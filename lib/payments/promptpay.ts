/**
 * PromptPay QR (EMVCo) payload generator — pure, no deps.
 *
 * Produces the standard Thai PromptPay QR string for a given merchant PromptPay ID
 * (mobile number or 13-digit national/tax ID) and amount. Render it to an actual QR
 * with any encoder (we use `qrcode` server-side in the subscribe route).
 *
 * Spec refs: EMV QRCPS + BOT PromptPay. Merchant account is tag 29 with AID
 * A000000677010111; mobile is formatted 0066+<9 digits>, national ID is the 13 digits.
 */

function tag(id: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${id}${len}${value}`;
}

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF) — the PromptPay checksum. */
function crc16(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Normalize a merchant PromptPay ID into the EMV sub-tag (01 mobile | 02 national/tax id). */
function merchantSubTag(rawId: string): string {
  const digits = rawId.replace(/\D/g, "");

  // Mobile: 10 local digits (0XXXXXXXXX) → 0066 + last 9 → tag 01
  if (digits.length === 10 && digits.startsWith("0")) {
    return tag("01", "0066" + digits.slice(1));
  }
  // Already country-coded mobile (66XXXXXXXXX)
  if (digits.length === 11 && digits.startsWith("66")) {
    return tag("01", "00" + digits);
  }
  // National ID / Tax ID: 13 digits → tag 02
  if (digits.length === 13) {
    return tag("02", digits);
  }
  // e-Wallet ID: 15 digits → tag 03
  if (digits.length === 15) {
    return tag("03", digits);
  }
  throw new Error(`invalid PromptPay id: "${rawId}" (expect mobile 10 digits or national id 13 digits)`);
}

export function buildPromptPayPayload(promptPayId: string, amountTHB: number): string {
  if (!promptPayId) throw new Error("PromptPay id is empty");
  if (!(amountTHB > 0)) throw new Error("amount must be > 0");

  const merchant = tag(
    "29",
    tag("00", "A000000677010111") + merchantSubTag(promptPayId)
  );

  const withoutCrc =
    tag("00", "01") + // payload format indicator
    tag("01", "12") + // point of initiation: 12 = dynamic (amount present)
    merchant +
    tag("58", "TH") + // country
    tag("53", "764") + // currency THB
    tag("54", amountTHB.toFixed(2)) + // amount
    "6304"; // CRC tag id + length, checksum computed over this prefix

  return withoutCrc + crc16(withoutCrc);
}

/** Whether a merchant PromptPay id is configured + valid (used to decide QR vs fallback). */
export function isPromptPayConfigured(promptPayId: string | undefined): promptPayId is string {
  if (!promptPayId) return false;
  try {
    buildPromptPayPayload(promptPayId, 1);
    return true;
  } catch {
    return false;
  }
}
