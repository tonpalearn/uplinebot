import { describe, it, expect, afterEach } from "vitest";
import { randomBytes } from "node:crypto";

/**
 * Locks in the new STRING interface of lib/crypto.ts after the bytea -> text fix:
 * encrypt(x) returns a base64 STRING and decrypt(encrypt(x)) === x, so what we write to a
 * `text` *_enc column is exactly what we read back — no supabase-js bytea hex-string
 * corruption. Covers:
 *   (1) real AES-256-GCM key: base64 output != plaintext, round-trips for many inputs
 *       (ascii, unicode/Thai, emoji, long LINE-token-like secrets).
 *   (2) encrypt() output survives a JS string round-trip (simulating text-column storage).
 *   (3) ENCRYPTION_KEY unset: the STUB_B64 fallback still round-trips.
 *
 * crypto.ts reads process.env.ENCRYPTION_KEY at call time (inside getKey()), so toggling the
 * env var per test is sufficient — no module cache reset needed. tests/setup.ts intentionally
 * leaves ENCRYPTION_KEY unset, so ORIGINAL_KEY is normally undefined and afterEach deletes it.
 */

import { encrypt, decrypt, isUsingStubEncryption } from "../lib/crypto";

const ORIGINAL_KEY = process.env.ENCRYPTION_KEY;

/** base64 of exactly 32 random bytes = a valid AES-256-GCM ENCRYPTION_KEY. */
function realKeyB64(): string {
  return randomBytes(32).toString("base64");
}

/** Forces a JS string through a UTF-8 encode/decode cycle, emulating what happens when the
 *  base64 ciphertext is stored in a Postgres `text` column and read back by supabase-js. */
function roundTripThroughString(s: string): string {
  return Buffer.from(s, "utf8").toString("utf8");
}

// Diverse plaintexts: ascii, Thai, mixed, emoji, whitespace/newlines, empty, and a
// realistic long LINE channel-access-token-like blob.
const INPUTS: Record<string, string> = {
  ascii: "line-access-token-abcdef",
  thai: "ช่องแชทลับ-มีภาษาไทยด้วย-๑๒๓",
  mixed: "channel-secret-มีไทยด้วย-123 / provider=LINE",
  emoji: "🔐 token 🇹🇭 ✅ ผ่าน",
  whitespace: "  leading and trailing \t and\nnewlines  ",
  empty: "",
  longLineToken:
    "u" +
    randomBytes(120).toString("base64") +
    "/" +
    "9a8b7c6d5e4f3021" +
    "=".repeat(2) +
    "line-bot-channel-access-token-มีไทยปน-" +
    randomBytes(80).toString("hex"),
};

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.ENCRYPTION_KEY;
  } else {
    process.env.ENCRYPTION_KEY = ORIGINAL_KEY;
  }
});

describe("crypto — real AES-256-GCM (ENCRYPTION_KEY = base64 of 32 bytes)", () => {
  it("is not using the stub when a real key is set", () => {
    process.env.ENCRYPTION_KEY = realKeyB64();
    expect(isUsingStubEncryption()).toBe(false);
  });

  it("encrypt(x) returns a base64 string that is NOT the plaintext, and decrypt(encrypt(x)) === x", () => {
    process.env.ENCRYPTION_KEY = realKeyB64();

    for (const [name, plaintext] of Object.entries(INPUTS)) {
      const enc = encrypt(plaintext);

      // returns a string
      expect(typeof enc, name).toBe("string");
      // ciphertext is not the plaintext
      expect(enc, name).not.toBe(plaintext);
      // real cipher, not the labeled dev stub
      expect(enc.startsWith("STUB_B64:"), name).toBe(false);
      // base64, not the old bytea hex "\x..." form that corrupted round-trips
      expect(enc.startsWith("\\x"), name).toBe(false);
      expect(enc, name).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      // round-trips exactly
      expect(decrypt(enc), name).toBe(plaintext);
    }
  });

  it("round-trips the long LINE-token-like secret specifically", () => {
    process.env.ENCRYPTION_KEY = realKeyB64();
    const token = INPUTS.longLineToken;
    expect(token.length).toBeGreaterThan(200);

    const enc = encrypt(token);
    expect(enc).not.toBe(token);
    expect(decrypt(enc)).toBe(token);
  });

  it("two encryptions of the same plaintext differ (random IV) but both decrypt correctly", () => {
    process.env.ENCRYPTION_KEY = realKeyB64();
    const secret = "same-input-มีไทย";

    const a = encrypt(secret);
    const b = encrypt(secret);

    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe(secret);
    expect(decrypt(b)).toBe(secret);
  });
});

describe("crypto — ciphertext survives a JS string round-trip (text-column storage)", () => {
  it("real AES-256-GCM output decrypts after passing through a JS string losslessly", () => {
    process.env.ENCRYPTION_KEY = realKeyB64();

    for (const [name, plaintext] of Object.entries(INPUTS)) {
      const enc = encrypt(plaintext);
      // Simulate write-to-text-column then read-back-as-string.
      const stored = roundTripThroughString(enc);

      // The stored string is byte-for-byte identical to what encrypt() produced.
      expect(stored, name).toBe(enc);
      // And it still decrypts to the original plaintext.
      expect(decrypt(stored), name).toBe(plaintext);
    }
  });

  it("stub output also survives the JS string round-trip", () => {
    delete process.env.ENCRYPTION_KEY;

    const plaintext = "refresh-token-มีไทย-stub-🔐";
    const enc = encrypt(plaintext);
    const stored = roundTripThroughString(enc);

    expect(stored).toBe(enc);
    expect(decrypt(stored)).toBe(plaintext);
  });
});

describe("crypto — stub fallback (ENCRYPTION_KEY unset)", () => {
  it("reports it is using the stub when no key is set", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(isUsingStubEncryption()).toBe(true);
  });

  it("encrypt() returns a labeled base64 string and decrypt(encrypt(x)) === x for many inputs", () => {
    delete process.env.ENCRYPTION_KEY;

    for (const [name, plaintext] of Object.entries(INPUTS)) {
      const enc = encrypt(plaintext);

      expect(typeof enc, name).toBe("string");
      // clearly labeled so it can never be mistaken for real ciphertext
      expect(enc.startsWith("STUB_B64:"), name).toBe(true);
      // the payload after the prefix is valid base64
      expect(enc.slice("STUB_B64:".length), name).toMatch(/^[A-Za-z0-9+/]*={0,2}$/);
      // round-trips exactly (incl. unicode/Thai and the long LINE-token-like string)
      expect(decrypt(enc), name).toBe(plaintext);
    }
  });
});
