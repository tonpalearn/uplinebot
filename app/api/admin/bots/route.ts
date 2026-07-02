import { NextRequest, NextResponse } from "next/server";
import { getServiceClient } from "@/lib/db";
import { encrypt } from "@/lib/crypto";
import { requireAdmin, AdminAuthError } from "@/lib/admin-auth";

// Encrypts and stores customer LINE OA credentials at runtime — never prerender.
export const dynamic = "force-dynamic";

/**
 * /api/admin/bots — seller-only: connect a customer's LINE Official Account to a tenant
 * (guarded by requireAdmin). Step 2 of onboarding (step 1 is POST /api/admin/tenants).
 *
 * After creating a bot here, the admin drops OUR single webhook URL
 * (POST /api/line/webhook) into the customer's LINE console. That one URL serves every
 * customer: each inbound webhook is routed to the right bot by the payload `destination`
 * (the OA Bot User ID), which maps to upl_bots.line_channel_id; the signature is then
 * verified using THAT bot's channel secret. So line_channel_id below MUST be the OA Bot
 * User ID (the value LINE sends as `destination`), not the numeric provider/channel id.
 *
 * POST  create a bot (channel_secret + access_token are stored ENCRYPTED; never returned).
 * GET   ?tenant_id=... list a tenant's bots WITHOUT any secrets.
 */

interface CreateBotBody {
  tenant_id: string;
  // The OA Bot User ID == the `destination` LINE sends in webhooks. Maps 1:1 to a bot.
  line_channel_id: string;
  channel_secret: string;
  access_token: string;
  group_reply_mode?: "mention_only" | "prefix" | "all";
  allowed_group_ids?: string[];
  default_prefix?: string;
}

const GROUP_REPLY_MODES = ["mention_only", "prefix", "all"] as const;

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  let body: CreateBotBody;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, reason: "invalid_json" }, { status: 400 });
  }

  const {
    tenant_id,
    line_channel_id,
    channel_secret,
    access_token,
    group_reply_mode,
    allowed_group_ids,
    default_prefix,
  } = body;

  if (!tenant_id || !line_channel_id || !channel_secret || !access_token) {
    return NextResponse.json(
      {
        ok: false,
        reason: "tenant_id, line_channel_id, channel_secret and access_token are required",
      },
      { status: 400 }
    );
  }

  if (group_reply_mode && !GROUP_REPLY_MODES.includes(group_reply_mode)) {
    return NextResponse.json(
      { ok: false, reason: "group_reply_mode must be one of mention_only|prefix|all" },
      { status: 400 }
    );
  }

  const supabase = getServiceClient();

  // Encrypt secrets to base64 text before persisting (columns are text per migration 0002).
  const { data: bot, error } = await supabase
    .from("upl_bots")
    .insert({
      tenant_id,
      line_channel_id,
      channel_secret_enc: encrypt(channel_secret),
      access_token_enc: encrypt(access_token),
      group_reply_mode: group_reply_mode ?? "mention_only",
      allowed_group_ids: allowed_group_ids ?? [],
      default_prefix: default_prefix ?? null,
    })
    // Deliberately DO NOT select the *_enc columns — secrets never leave the server.
    .select("id, tenant_id, line_channel_id, group_reply_mode, allowed_group_ids, default_prefix, active, created_at")
    .single();

  if (error || !bot) {
    return NextResponse.json(
      { ok: false, reason: error?.message ?? "bot_insert_failed" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, bot });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    requireAdmin(req);
  } catch (err) {
    if (err instanceof AdminAuthError) {
      return NextResponse.json({ ok: false, reason: "unauthorized" }, { status: 401 });
    }
    throw err;
  }

  const tenantId = req.nextUrl.searchParams.get("tenant_id");
  if (!tenantId) {
    return NextResponse.json({ ok: false, reason: "tenant_id query param is required" }, { status: 400 });
  }

  const supabase = getServiceClient();

  // Never select the *_enc secret columns.
  const { data: bots, error } = await supabase
    .from("upl_bots")
    .select("id, line_channel_id, group_reply_mode, active, created_at")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ ok: false, reason: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, bots: bots ?? [] });
}
