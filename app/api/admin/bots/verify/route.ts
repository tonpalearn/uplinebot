import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { decrypt } from "@/lib/crypto";
import { requireAdmin, AdminAuthError } from "@/lib/admin-auth";

// Calls the real LINE API at runtime with a decrypted token — never prerender.
export const dynamic = "force-dynamic";

const LINE_BOT_INFO_URL = "https://api.line.me/v2/bot/info";

/**
 * POST /api/admin/bots/verify { id } — actually verify a connected LINE OA against LINE.
 *
 * Loads the bot's stored (encrypted) channel access token, decrypts it server-side, and calls
 * LINE `GET /v2/bot/info`. That confirms the token is valid AND returns the REAL Bot User ID
 * (`userId`) + display name, so the operator can check the stored `line_channel_id` (the value
 * LINE sends as the webhook `destination`) is the correct one — the common onboarding mistake.
 *
 * Security: the access token never leaves the server; only LINE's public bot info is returned.
 * `matches` = does LINE's real userId equal the stored line_channel_id.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: { id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ ok: false, reason: "id is required" }, { status: 400 });

  const supabase = getServiceClient();
  const { data: bot, error } = await supabase
    .from("upl_bots")
    .select("id, line_channel_id, access_token_enc")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  if (!bot) return NextResponse.json({ ok: false, reason: "not_found" }, { status: 404 });

  const storedChannelId = bot.line_channel_id as string;

  // Mock mode (LINE_MOCK=true): don't call the real API — echo the stored id as a match.
  if (process.env.LINE_MOCK === "true") {
    return NextResponse.json({
      ok: true,
      mock: true,
      info: { userId: storedChannelId, displayName: "(mock) Bot", basicId: "@mock" },
      storedChannelId,
      matches: true,
    });
  }

  let token: string;
  try {
    token = decrypt(bot.access_token_enc as string);
  } catch {
    return NextResponse.json(
      { ok: true, verified: false, reason: "decrypt_failed", storedChannelId, matches: false },
      { status: 200 }
    );
  }

  let res: Response;
  try {
    res = await fetch(LINE_BOT_INFO_URL, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    return NextResponse.json(
      { ok: true, verified: false, reason: "line_unreachable", storedChannelId, matches: false },
      { status: 200 }
    );
  }

  if (!res.ok) {
    // 401 = the stored access token is wrong/expired; other codes = a LINE-side error.
    const detail = await res.text().catch(() => "");
    return NextResponse.json({
      ok: true,
      verified: false,
      reason: res.status === 401 ? "invalid_access_token" : `line_error_${res.status}`,
      detail: detail.slice(0, 200),
      storedChannelId,
      matches: false,
    });
  }

  const info = (await res.json().catch(() => ({}))) as {
    userId?: string;
    basicId?: string;
    displayName?: string;
    pictureUrl?: string;
  };
  const realUserId = typeof info.userId === "string" ? info.userId : null;

  return NextResponse.json({
    ok: true,
    verified: true,
    info: {
      userId: realUserId,
      basicId: info.basicId ?? null,
      displayName: info.displayName ?? null,
      pictureUrl: info.pictureUrl ?? null,
    },
    storedChannelId,
    // The whole point: does LINE's real Bot User ID match what we stored as the webhook destination?
    matches: realUserId != null && realUserId === storedChannelId,
  });
}
