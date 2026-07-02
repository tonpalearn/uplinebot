import type { OutboundMessage } from "../modules/types";

/**
 * LINE Messaging API wrapper: replyMessage, pushMessage, getMessageContent.
 *
 * When process.env.LINE_MOCK === 'true', every method returns a canned
 * successful response instead of calling the real API — so tests (and local
 * dev without live LINE credentials) never hit the network.
 */

const LINE_API_BASE = "https://api.line.me/v2/bot";
const LINE_DATA_API_BASE = "https://api-data.line.me/v2/bot";

function isMockMode(): boolean {
  return process.env.LINE_MOCK === "true";
}

function toLinePayload(messages: OutboundMessage[]): Record<string, unknown>[] {
  return messages.map((m) => {
    switch (m.type) {
      case "text":
        return { type: "text", text: m.text ?? "" };
      case "flex":
        return { type: "flex", altText: m.altText ?? "", contents: m.contents ?? {} };
      case "image":
        return {
          type: "image",
          originalContentUrl: m.originalContentUrl ?? "",
          previewImageUrl: m.previewImageUrl ?? m.originalContentUrl ?? "",
        };
      case "sticker":
        return { type: "sticker", packageId: m.packageId ?? "", stickerId: m.stickerId ?? "" };
      default:
        return { type: "text", text: "" };
    }
  });
}

export interface LineApiResult {
  ok: boolean;
  status: number;
  body?: unknown;
}

export async function replyMessage(
  accessToken: string,
  replyToken: string,
  messages: OutboundMessage[]
): Promise<LineApiResult> {
  if (isMockMode()) {
    return { ok: true, status: 200, body: { mock: true, method: "replyMessage", replyToken } };
  }

  const res = await fetch(`${LINE_API_BASE}/message/reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ replyToken, messages: toLinePayload(messages) }),
  });

  return { ok: res.ok, status: res.status, body: await safeJson(res) };
}

export async function pushMessage(
  accessToken: string,
  to: string,
  messages: OutboundMessage[]
): Promise<LineApiResult> {
  if (isMockMode()) {
    return { ok: true, status: 200, body: { mock: true, method: "pushMessage", to } };
  }

  const res = await fetch(`${LINE_API_BASE}/message/push`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ to, messages: toLinePayload(messages) }),
  });

  return { ok: res.ok, status: res.status, body: await safeJson(res) };
}

export async function getMessageContent(
  accessToken: string,
  messageId: string
): Promise<Buffer> {
  if (isMockMode()) {
    // Deterministic canned "image" buffer for tests — marker byte 0x01 = valid slip
    // (see lib/modules/slip-verification/providers/mock.ts for how the marker is used).
    return Buffer.from([0x01, 0x02, 0x03, 0x04]);
  }

  const res = await fetch(`${LINE_DATA_API_BASE}/message/${messageId}/content`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error(`getMessageContent failed: ${res.status} ${res.statusText}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
