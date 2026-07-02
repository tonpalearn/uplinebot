import type { SlipProvider, SlipVerifyResult } from "./types";

/**
 * SlipOK provider adapter — per SYSTEM-DESIGN.md §4.3 step 3:
 * "POST https://api.slipok.com/api/line/apikey/{apikey} with the image — returns
 * bank, amount, txn ref, timestamp already OCR'd and bank-verified (SlipOK does the
 * OCR+verification, UP Line does not need its own vision model for this module)."
 *
 * The API key is per-tenant (decrypted from upl_provider_credentials by the caller)
 * and is embedded directly in the endpoint path, matching SlipOK's documented
 * "LINE apikey" endpoint shape.
 */
export class SlipOkProvider implements SlipProvider {
  constructor(private readonly apiKey: string) {}

  async verify(imageBuffer: Buffer): Promise<SlipVerifyResult> {
    const url = `https://api.slipok.com/api/line/apikey/${this.apiKey}`;

    const form = new FormData();
    form.append("files", new Blob([bufferToArrayBuffer(imageBuffer)]), "slip.jpg");

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "x-authorization": this.apiKey,
      },
      body: form,
    });

    const body = (await res.json().catch(() => null)) as SlipOkResponse | null;

    if (!res.ok || !body) {
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
      bank: data?.receiver?.bank?.short ?? data?.sendingBank ?? "",
      amount: data?.amount ?? 0,
      ref: data?.transRef ?? "",
      txnTime: data?.transDate && data?.transTime
        ? new Date(`${data.transDate}T${data.transTime}`).toISOString()
        : new Date().toISOString(),
      isValid: body.success === true,
    };
  }
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
}

interface SlipOkResponse {
  success: boolean;
  message?: string;
  data?: {
    amount?: number;
    transRef?: string;
    sendingBank?: string;
    transDate?: string; // e.g. "20260702"
    transTime?: string; // e.g. "14:05:00"
    receiver?: {
      bank?: { short?: string };
    };
  };
}
