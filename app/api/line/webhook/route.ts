import { NextRequest, NextResponse } from "next/server";
import { verifyLineSignature } from "@/lib/line/verify";
import { lookupBotByChannelId, resolveContext } from "@/lib/context";
import { routeEvent } from "@/lib/modules/registry";
import { replyMessage } from "@/lib/line/client";
import { decrypt } from "@/lib/crypto";
import { getServiceClient } from "@/lib/db";
import type { LineEvent } from "@/lib/modules/types";

/**
 * POST /api/line/webhook
 *
 * Real handler (not a stub) per SYSTEM-DESIGN.md §2.2, §4.1, §4.2.
 *
 * LINE COMPATIBILITY — ALWAYS RETURN 200:
 * The LINE Platform requires the webhook to return HTTP 200 (its "Verify" button and its
 * health checks fail, and LINE may DISABLE the webhook or retry, on any non-2xx). So this
 * handler returns 200 in every case and does its filtering INTERNALLY:
 *   - verify/empty request (events: []) → 200, nothing to do (this is what "Verify" sends).
 *   - unknown destination (bot not onboarded yet) → 200, logged, skipped.
 *   - invalid signature (forged/unsigned) → 200, logged, NOT processed (no side effects).
 *   - internal error → 200, logged (LINE would otherwise retry → duplicate processing).
 * Only a valid signature on a KNOWN, onboarded bot causes events to be processed.
 *
 * Multi-tenant routing: the bot is resolved from the `destination` field LINE puts in the
 * webhook body (the OA's bot user id) → upl_bots.line_channel_id. The signature is then
 * verified with THAT bot's own channel secret. One webhook URL serves every customer.
 */

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

// Single 200 response used for every outcome (LINE requires 200; details go to logs).
const OK = () => NextResponse.json({ ok: true }, { status: 200 });

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-line-signature");

    let parsed: LineWebhookBody;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      console.warn("[webhook] ignored: body is not valid JSON");
      return OK();
    }

    const bot = await lookupBotByChannelId(parsed.destination);
    if (!bot) {
      // Not onboarded yet (or wrong Bot User ID entered at onboarding). LINE's Verify
      // button hits this before a bot is connected — return 200 so Verify passes.
      console.warn(`[webhook] ignored: no bot for destination ${parsed.destination}`);
      return OK();
    }

    const channelSecret = await getBotChannelSecret(bot.id);
    const isValidSignature = verifyLineSignature(rawBody, signature, channelSecret);
    if (!isValidSignature) {
      // Do NOT process (protects against forged events) but still 200 to keep LINE happy.
      console.warn(`[webhook] rejected: invalid signature for bot ${bot.id}`);
      return OK();
    }

    const accessToken = await getBotAccessToken(bot.id);

    for (const event of parsed.events ?? []) {
      try {
        const ctx = await resolveContext(event, bot);
        const outbound = await routeEvent(event, ctx);

        if (outbound.length > 0 && event.replyToken) {
          await replyMessage(accessToken, event.replyToken, outbound);
        }
      } catch (err) {
        // Per-event failure must not fail the batch — log and continue.
        console.error("[webhook] failed to process event:", err);
      }
    }

    return OK();
  } catch (err) {
    // Any unexpected error (e.g. missing env) must still return 200 to LINE, otherwise
    // LINE retries the delivery (duplicate processing) or disables the webhook.
    console.error("[webhook] unexpected error (returning 200 anyway):", err);
    return OK();
  }
}

async function getBotChannelSecret(botId: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_bots")
    .select("channel_secret_enc")
    .eq("id", botId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load channel secret for bot ${botId}`);
  }

  // channel_secret_enc is a base64 text column (migration 0002) — pass the string straight in.
  return decrypt(data.channel_secret_enc);
}

async function getBotAccessToken(botId: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_bots")
    .select("access_token_enc")
    .eq("id", botId)
    .single();

  if (error || !data) {
    throw new Error(`Failed to load access token for bot ${botId}`);
  }

  // access_token_enc is a base64 text column (migration 0002) — pass the string straight in.
  return decrypt(data.access_token_enc);
}
