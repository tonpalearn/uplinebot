import type { SlipProvider, SlipVerifyResult } from "./types";

/**
 * Deterministic mock provider for tests / SLIP_MOCK=true local dev.
 *
 * Convention: the first byte of the image buffer is a "marker byte" that
 * decides isValid — 0x01 = valid slip, anything else = invalid. This lets
 * tests construct buffers like Buffer.from([0x01, ...]) to deterministically
 * exercise both the happy path and the invalid/fraud path without any
 * network call or real OCR.
 */
export class MockSlipProvider implements SlipProvider {
  async verify(imageBuffer: Buffer): Promise<SlipVerifyResult> {
    const marker = imageBuffer.length > 0 ? imageBuffer[0] : 0x00;
    const isValid = marker === 0x01;

    // Deterministic-ish fields derived from buffer content/length so repeated
    // calls with the same buffer produce the same dedupe hash (useful for
    // testing the unique-constraint dedupe path in SYSTEM-DESIGN.md §4.3 step 4).
    const amount = 100 + (imageBuffer.length % 900);
    const refSeed = imageBuffer.reduce((acc, byte) => (acc + byte) % 100000, 0);

    return {
      bank: "MOCKBANK",
      amount,
      ref: `MOCKREF${refSeed.toString().padStart(5, "0")}`,
      txnTime: new Date(0).toISOString(),
      isValid,
    };
  }
}
