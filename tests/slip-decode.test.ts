import { describe, it, expect } from "vitest";
import QRCode from "qrcode";
import { decodeSlip, parseSlipQr, sha256Hex } from "../lib/payments/slip-decode";

/**
 * Unit tests for the self-hosted slip decoder (lib/payments/slip-decode.ts).
 *
 * Two concerns:
 *  1) parseSlipQr — best-effort EMVCo TLV parsing: extract transRef when present, and NEVER
 *     throw on unparseable input (return nulls instead).
 *  2) sha256Hex / decodeSlip — deterministic image hashing, and a real end-to-end decode of a
 *     QR we render ourselves (sharp → raw RGBA → jsQR), proving the Vercel-Node pipeline works.
 */

// EMVCo tag-length-value builder for constructing fixtures.
function tag(id: string, value: string): string {
  const len = value.length.toString().padStart(2, "0");
  return `${id}${len}${value}`;
}

/** A realistic Thai slip-verify QR: bank-account template (30) + additional-data ref (62.05). */
function buildSlipQr(ref: string, bankAid = "A000000677010112"): string {
  const merchant = tag("30", tag("00", bankAid) + tag("01", "0140000000001234"));
  const additional = tag("62", tag("05", ref));
  return (
    tag("00", "01") +
    tag("01", "12") +
    merchant +
    additional +
    tag("58", "TH") +
    tag("53", "764") +
    tag("63", "A1B2")
  );
}

describe("parseSlipQr — EMVCo TLV best-effort parse", () => {
  it("extracts transRef from the 62.05 reference sub-tag", () => {
    const raw = buildSlipQr("2024011512345678ABCD");
    const parsed = parseSlipQr(raw);
    expect(parsed.transRef).toBe("2024011512345678ABCD");
  });

  it("surfaces the bank AID from the account template as sendingBank", () => {
    const raw = buildSlipQr("REF1234567890", "A000000677010113");
    const parsed = parseSlipQr(raw);
    expect(parsed.sendingBank).toBe("A000000677010113");
  });

  it("falls back to a nested 62 sub-tag when 62.05 is absent", () => {
    // Only 62.01 (bill number) present — still a usable ref.
    const merchant = tag("30", tag("00", "A000000677010112"));
    const raw = tag("00", "01") + merchant + tag("62", tag("01", "BILLNO1234567"));
    const parsed = parseSlipQr(raw);
    expect(parsed.transRef).toBe("BILLNO1234567");
  });

  it("returns nulls (never throws) on a completely unparseable string", () => {
    expect(() => parseSlipQr("this-is-not-tlv-at-all!!")).not.toThrow();
    const parsed = parseSlipQr("this-is-not-tlv-at-all!!");
    expect(parsed.transRef).toBeNull();
    expect(parsed.sendingBank).toBeNull();
  });

  it("returns nulls on an empty string without throwing", () => {
    expect(() => parseSlipQr("")).not.toThrow();
    expect(parseSlipQr("")).toEqual({ transRef: null, sendingBank: null });
  });

  it("does not throw when a declared length overruns the buffer", () => {
    // tag 00, length 99, but only a few chars follow.
    expect(() => parseSlipQr("0099AB")).not.toThrow();
  });
});

describe("sha256Hex — deterministic image hashing", () => {
  it("is deterministic for identical bytes", () => {
    const a = Buffer.from("the-same-slip-bytes");
    const b = Buffer.from("the-same-slip-bytes");
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(sha256Hex(a)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bytes", () => {
    expect(sha256Hex(Buffer.from("slip-A"))).not.toBe(sha256Hex(Buffer.from("slip-B")));
  });
});

describe("decodeSlip — end-to-end (sharp → jsQR)", () => {
  it("decodes a real QR image and parses its transRef", async () => {
    const raw = buildSlipQr("2024011512345678ABCD");
    const png = await QRCode.toBuffer(raw, { type: "png", margin: 2, width: 320, errorCorrectionLevel: "M" });

    const out = await decodeSlip(png);
    expect(out.foundQr).toBe(true);
    expect(out.rawQr).toBe(raw);
    expect(out.transRef).toBe("2024011512345678ABCD");
    expect(out.imageHash).toBe(sha256Hex(png));
  });

  it("returns foundQr:false (and a valid hash) for an image with no QR", async () => {
    // A plain gray PNG — decodable by sharp, but jsQR finds no QR.
    const sharp = (await import("sharp")).default;
    const blank = await sharp({ create: { width: 160, height: 160, channels: 3, background: { r: 235, g: 235, b: 235 } } })
      .png()
      .toBuffer();

    const out = await decodeSlip(blank);
    expect(out.foundQr).toBe(false);
    expect(out.rawQr).toBeNull();
    expect(out.transRef).toBeNull();
    expect(out.imageHash).toBe(sha256Hex(blank));
  });

  it("does not throw on non-image bytes (degrades to foundQr:false)", async () => {
    const junk = Buffer.from("not-an-image-at-all");
    const out = await decodeSlip(junk);
    expect(out.foundQr).toBe(false);
    expect(out.imageHash).toBe(sha256Hex(junk));
  });
});
