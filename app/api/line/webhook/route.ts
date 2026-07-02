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
 * Real handler (not a stub) per SYSTEM-DESIGN.md §2.2, §4.1, §4.2:
 * 1. Verify X-Line-Signature (HMAC-SHA256 over the raw body, using the bot's channel secret).
 * 2. Resolve tenant/target context (Context Resolver).
 * 3. Route each event through the Command Router (entitlement-filtered).
 * 4. Send any resulting replies via the LINE Messaging API.
 *
 * Note: LINE's webhook payload does not include which channel/bot it targets in a way
 * that's usable before we know the channel secret to verify against. In practice the
 * bot is resolved from the `destination` field LINE includes in the webhook body
 * (the bot's user id), which we treat here as equivalent to line_channel_id — the
 * mapping from `destination` to `upl_bots.line_channel_id` should be set up when
 * connecting each bot in the Admin Dashboard.
 */

interface LineWebhookBody {
  destination: string;
  events: LineEvent[];
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-line-signature");

  let parsed: LineWebhookBody;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const bot = await lookupBotByChannelId(parsed.destination);
  if (!bot) {
    // Unknown destination — nothing we can verify against; reject rather than
    // silently 200 (would mask a misconfiguration).
    return NextResponse.json({ ok: false, reason: "unknown_bot" }, { status: 404 });
  }

  const channelSecret = await getBotChannelSecret(bot.id);
  const isValidSignature = verifyLineSignature(rawBody, signature, channelSecret);
  if (!isValidSignature) {
    return NextResponse.json({ ok: false, reason: "invalid_signature" }, { status: 401 });
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
      // Per-event failure should not fail the whole webhook batch — log and continue.
      // upl_message_logs is the primary observability surface pre-launch (SYSTEM-DESIGN §5.3).
      console.error("Failed to process LINE event:", err);
    }
  }

  return NextResponse.json({ ok: true });
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
