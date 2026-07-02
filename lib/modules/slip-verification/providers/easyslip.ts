import type { SlipProvider, SlipVerifyResult } from "./types";

/**
 * EasySlip provider adapter — per SYSTEM-DESIGN.md §4.3 step 3:
 * "EasySlip: equivalent contract, swap client adapter — both implement a shared
 * SlipProvider interface (verify(imageBuffer): Promise<{bank, amount, ref, txnTime,
 * isValid}>) so switching default provider is a config change, not a rewrite."
 *
 * EasySlip's documented API takes the image as multipart/form-data at
 * POST https://developer.easyslip.com/api/v1/verify and authenticates via a
 * Bearer token (the tenant's decrypted API key).
 */
export class EasySlipProvider implements SlipProvider {
  constructor(private readonly apiKey: string) {}

  async verify(imageBuffer: Buffer): Promise<SlipVerifyResult> {
    const url = "https://developer.easyslip.com/api/v1/verify";

    const form = new FormData();
    form.append("file", new Blob([bufferToArrayBuffer(imageBuffer)]), "slip.jpg");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: form,
    });

    const body = (await res.json().catch(() => null)) as EasySlipResponse | null;

    if (!res.ok || !body || body.status !== 200) {
      return {
        bank: "",
        amount: 0,
        ref: "",
        txnTime: new Date().toISOString(),
        isValid: false,
      };
    }

    const data = body.data;

    return {
      bank: data?.sender?.bank?.short ?? data?.receiver?.bank?.short ?? "",
      amount: data?.amount?.amount ?? 0,
      ref: data?.transRef ?? "",
      txnTime: data?.date ?? new Date().toISOString(),
      isValid: true,
    };
  }
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

interface EasySlipResponse {
  status: number;
  data?: {
    date?: string; // ISO 8601
    transRef?: string;
    amount?: { amount?: number };
    sender?: { bank?: { short?: string } };
    receiver?: { bank?: { short?: string } };
  };
}
