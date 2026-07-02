import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encrypt/decrypt helpers for secrets persisted in *_enc columns
 * (upl_bots.channel_secret_enc/access_token_enc, upl_provider_credentials.credential_enc,
 * upl_calendar_links.refresh_token_enc).
 *
 * Production: expects ENCRYPTION_KEY to be a base64-encoded 32-byte key (AES-256-GCM).
 * In real deployment this should be backed by Supabase Vault / pgsodium per
 * SYSTEM-DESIGN.md §4.5 — this module is the application-side symmetric layer used
 * before/after that boundary, or as a standalone KMS-free fallback.
 *
 * Dev/test fallback: if ENCRYPTION_KEY is NOT set, we fall back to a clearly-labeled
 * reversible base64 "stub" so tests and local dev can run without provisioning a real key.
 * THIS STUB PROVIDES NO CONFIDENTIALITY — never use it in production.
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

export function encrypt(plaintext: string): Buffer {
  const key = getKey();

  if (!key) {
    // Dev/mock fallback — reversible, NOT secure. Labeled so it can never be
    // mistaken for real ciphertext.
    return Buffer.from(STUB_PREFIX + Buffer.from(plaintext, "utf8").toString("base64"), "utf8");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Layout: iv (12 bytes) || authTag (16 bytes) || ciphertext
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decrypt(data: Buffer): string {
  const asString = data.toString("utf8");
  if (asString.startsWith(STUB_PREFIX)) {
    const b64 = asString.slice(STUB_PREFIX.length);
    return Buffer.from(b64, "base64").toString("utf8");
  }

  const key = getKey();
  if (!key) {
    throw new Error(
      "Cannot decrypt real ciphertext without ENCRYPTION_KEY set (stub prefix not found)."
    );
  }

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
