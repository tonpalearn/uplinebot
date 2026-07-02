import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypt/decrypt helpers for secrets persisted in *_enc columns
 * (upl_bots.channel_secret_enc/access_token_enc, upl_provider_credentials.credential_enc,
 * upl_calendar_links.refresh_token_enc).
 *
 * STORAGE FORMAT: the *_enc columns are `text` (see migration 0002). encrypt() returns a
 * base64 STRING and decrypt() accepts that same base64 string. We store base64 TEXT rather
 * than `bytea` on purpose: supabase-js returns a `bytea` column as a hex string ("\x...."),
 * not a Buffer, which silently corrupted round-trips through Buffer.from(...). Storing base64
 * TEXT means what we write is exactly what we read back — no driver-specific decoding.
 *
 * Production: expects ENCRYPTION_KEY to be a base64-encoded 32-byte key (AES-256-GCM).
 * Ciphertext layout, then base64-encoded as one string:  iv (12B) || authTag (16B) || ciphertext.
 * In real deployment this should be backed by Supabase Vault / pgsodium per
 * SYSTEM-DESIGN.md §4.5 — this module is the application-side symmetric layer used
 * before/after that boundary, or as a standalone KMS-free fallback.
 *
 * Dev/test fallback: if ENCRYPTION_KEY is NOT set, we fall back to a clearly-labeled
 * reversible base64 "stub" (prefixed with STUB_B64:) so tests and local dev can run without
 * provisioning a real key. THIS STUB PROVIDES NO CONFIDENTIALITY — never use it in production.
 */

const STUB_PREFIX = "STUB_B64:";
const ALGO = "aes-256-gcm";

function getKey(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      `ENCRYPTION_KEY must decode to exactly 32 bytes for AES-256-GCM (got ${key.length}).`
    );
  }
  return key;
}

/**
 * Encrypt a plaintext secret into a base64 string safe to store in a `text` column.
 * With ENCRYPTION_KEY set: real AES-256-GCM. Without it: a labeled reversible stub.
 */
export function encrypt(plaintext: string): string {
  const key = getKey();

  if (!key) {
    // Dev/mock fallback — reversible, NOT secure. Labeled so it can never be
    // mistaken for real ciphertext.
    return STUB_PREFIX + Buffer.from(plaintext, "utf8").toString("base64");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: iv (12 bytes) || authTag (16 bytes) || ciphertext, base64-encoded as one string.
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/**
 * Decrypt a base64 string produced by encrypt() back to the original plaintext.
 * Accepts the labeled stub form (STUB_B64:...) and real AES-256-GCM base64.
 */
export function decrypt(value: string): string {
  if (value.startsWith(STUB_PREFIX)) {
    const b64 = value.slice(STUB_PREFIX.length);
    return Buffer.from(b64, "base64").toString("utf8");
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      "Cannot decrypt real ciphertext without ENCRYPTION_KEY set (stub prefix not found)."
    );
  }

  const data = Buffer.from(value, "base64");
  const iv = data.subarray(0, 12);
  const authTag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}

export function isUsingStubEncryption(): boolean {
  return !process.env.ENCRYPTION_KEY;
}
