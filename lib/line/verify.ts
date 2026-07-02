import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the X-Line-Signature header per LINE Messaging API webhook spec:
 * signature = base64(HMAC-SHA256(channelSecret, rawRequestBody))
 *
 * Real crypto — not mocked, even in LINE_MOCK mode — since signature
 * verification is a pure function of (secret, body, signature) with no
 * network call involved.
 */
export function verifyLineSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  channelSecret: string
): boolean {
  if (!signatureHeader) return false;
  if (!channelSecret) return false;

  const expected = createHmac("sha256", channelSecret).update(rawBody).digest("base64");

  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(signatureHeader, "utf8");

  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }

  return timingSafeEqual(expectedBuf, actualBuf);
}
