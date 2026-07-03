import { describe, it, expect } from "vitest";
import { buildPromptPayPayload, isPromptPayConfigured } from "@/lib/payments/promptpay";

// Re-implement the CRC the spec expects, to check the payload's own checksum is valid.
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

describe("PromptPay payload", () => {
  it("builds a well-formed EMVCo string for a mobile number", () => {
    const p = buildPromptPayPayload("0899999999", 100);
    expect(p.startsWith("000201")).toBe(true); // payload format indicator
    expect(p).toContain("010212"); // dynamic (amount present)
    expect(p).toContain("A000000677010111"); // PromptPay AID
    expect(p).toContain("0066899999999"); // 0066 + 9 digits
    expect(p).toContain("5303764"); // currency THB
    expect(p).toContain("5406100.00"); // amount tag + value
    expect(p).toContain("5802TH"); // country
  });

  it("appends a self-consistent CRC (tag 63)", () => {
    const p = buildPromptPayPayload("0899999999", 100);
    const body = p.slice(0, -4); // everything except the 4 CRC hex chars
    expect(body.endsWith("6304")).toBe(true);
    expect(p.slice(-4)).toBe(crc16(body));
  });

  it("encodes a national ID with sub-tag 02", () => {
    const p = buildPromptPayPayload("1234567890123", 50);
    expect(p).toContain("02131234567890123"); // tag 02, len 13, id
  });

  it("changes the amount tag when the amount changes", () => {
    const a = buildPromptPayPayload("0899999999", 990);
    const b = buildPromptPayPayload("0899999999", 2990);
    expect(a).toContain("5406990.00");
    expect(b).toContain("54072990.00");
    expect(a).not.toBe(b);
  });

  it("rejects invalid ids / amounts", () => {
    expect(() => buildPromptPayPayload("123", 100)).toThrow();
    expect(() => buildPromptPayPayload("0899999999", 0)).toThrow();
  });

  it("isPromptPayConfigured guards missing/invalid ids", () => {
    expect(isPromptPayConfigured(undefined)).toBe(false);
    expect(isPromptPayConfigured("")).toBe(false);
    expect(isPromptPayConfigured("nope")).toBe(false);
    expect(isPromptPayConfigured("0899999999")).toBe(true);
  });
});
