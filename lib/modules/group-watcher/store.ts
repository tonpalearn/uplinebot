import { getServiceClient } from "../../db";

import type { ConversationLine } from "./summarize";

/**
 * DB ops ของผู้ช่วยเฝ้ากลุ่ม.
 *
 * ขอบเขต: ทุกอย่างผูกกับ **targetId** (กลุ่มเดียว = การเฝ้าชุดเดียว) ต่างจากฐานอาหารที่เป็น
 * ระดับ tenant — เพราะการยินยอมให้สรุปเป็นเรื่องของ "คนในกลุ่มนั้น" ไม่ใช่ของทั้งธุรกิจ
 */

export interface WatchConfig {
  targetId: string;
  tenantId: string;
  active: boolean;
  reportToUser: string | null;
  reportToTarget: string | null;
  scheduleKind: "interval" | "times" | "off";
  intervalMinutes: number;
  reportTimes: string | null;
  keywords: string | null;
  urgentKeywords: string | null;
  includeNames: boolean;
  retentionDays: number;
  minMessages: number;
  alertCooldownMinutes: number;
  lastAlertAt: string | null;
}

const CONFIG_COLUMNS =
  "target_id, tenant_id, active, report_to_user, report_to_target, schedule_kind, interval_minutes, report_times, keywords, urgent_keywords, include_names, retention_days, min_messages, alert_cooldown_minutes, last_alert_at";

function toConfig(r: Record<string, unknown>): WatchConfig {
  return {
    targetId: r.target_id as string,
    tenantId: r.tenant_id as string,
    active: r.active as boolean,
    reportToUser: (r.report_to_user as string | null) ?? null,
    reportToTarget: (r.report_to_target as string | null) ?? null,
    scheduleKind: r.schedule_kind as WatchConfig["scheduleKind"],
    intervalMinutes: Number(r.interval_minutes),
    reportTimes: (r.report_times as string | null) ?? null,
    keywords: (r.keywords as string | null) ?? null,
    urgentKeywords: (r.urgent_keywords as string | null) ?? null,
    includeNames: r.include_names as boolean,
    retentionDays: Number(r.retention_days),
    minMessages: Number(r.min_messages),
    alertCooldownMinutes: Number(r.alert_cooldown_minutes),
    lastAlertAt: (r.last_alert_at as string | null) ?? null,
  };
}

export async function getWatchConfig(targetId: string): Promise<WatchConfig | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_watch_configs")
    .select(CONFIG_COLUMNS)
    .eq("target_id", targetId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read watch config for ${targetId}: ${error.message}`);
  return data ? toConfig(data as Record<string, unknown>) : null;
}

/** เปิดการเฝ้า (สร้างถ้ายังไม่มี) — ค่าเริ่มต้นทั้งหมดมาจาก DB default ที่ตั้งไว้ให้ปลอดภัย */
export async function startWatch(
  targetId: string,
  tenantId: string,
  reportToUser: string | null
): Promise<WatchConfig> {
  const supabase = getServiceClient();
  const { error } = await supabase.from("upl_watch_configs").upsert(
    {
      target_id: targetId,
      tenant_id: tenantId,
      active: true,
      report_to_user: reportToUser,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "target_id" }
  );
  if (error) throw new Error(`Failed to start watch for ${targetId}: ${error.message}`);

  const cfg = await getWatchConfig(targetId);
  if (!cfg) throw new Error(`Watch config missing right after upsert for ${targetId}`);
  return cfg;
}

export async function updateWatchConfig(
  targetId: string,
  patch: Partial<{
    active: boolean;
    reportToUser: string | null;
    reportToTarget: string | null;
    scheduleKind: WatchConfig["scheduleKind"];
    intervalMinutes: number;
    reportTimes: string | null;
    keywords: string | null;
    urgentKeywords: string | null;
    includeNames: boolean;
    lastAlertAt: string;
  }>
): Promise<void> {
  const supabase = getServiceClient();
  const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
  const map: Record<string, string> = {
    active: "active",
    reportToUser: "report_to_user",
    reportToTarget: "report_to_target",
    scheduleKind: "schedule_kind",
    intervalMinutes: "interval_minutes",
    reportTimes: "report_times",
    keywords: "keywords",
    urgentKeywords: "urgent_keywords",
    includeNames: "include_names",
    lastAlertAt: "last_alert_at",
  };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined && map[k]) row[map[k]] = v;
  }

  const { error } = await supabase.from("upl_watch_configs").update(row).eq("target_id", targetId);
  if (error) throw new Error(`Failed to update watch config for ${targetId}: ${error.message}`);
}

// ── ข้อความ ───────────────────────────────────────────────────────────────────
/**
 * เก็บข้อความไว้รอสรุป — ข้ามเงียบ ๆ ถ้าคนพูดขอ opt-out ไว้
 * (เช็คตรงนี้ ไม่ใช่ตอนสรุป เพื่อไม่ให้ข้อความของเขาถูกเก็บลงดิสก์ตั้งแต่แรก)
 */
export async function captureMessage(
  targetId: string,
  lineUserId: string | null,
  displayName: string | null,
  text: string
): Promise<boolean> {
  const supabase = getServiceClient();

  if (lineUserId) {
    const { data } = await supabase
      .from("upl_watch_optouts")
      .select("line_user_id")
      .eq("target_id", targetId)
      .eq("line_user_id", lineUserId)
      .maybeSingle();
    if (data) return false;
  }

  const { error } = await supabase.from("upl_group_messages").insert({
    target_id: targetId,
    line_user_id: lineUserId,
    display_name: displayName,
    text: text.slice(0, 2000),
  });
  if (error) throw new Error(`Failed to capture message for ${targetId}: ${error.message}`);
  return true;
}

export interface PendingMessages {
  lines: ConversationLine[];
  ids: number[];
  firstAt: string | null;
  lastAt: string | null;
}

/**
 * ข้อความที่ยังไม่ถูกสรุป
 *
 * อ่านผ่านฟังก์ชัน SQL (upl_watch_pending) ไม่ใช่ select หลายคอลัมน์ผ่าน REST — เพราะแบบหลัง
 * เคยคืน **0 แถวเงียบ ๆ โดยไม่ error** ทั้งที่นับด้วยเงื่อนไขเดียวกันได้ 7 แถว
 * (ขอทีละคอลัมน์ได้ครบทุกคอลัมน์ แต่ขอ id+display_name+text+sent_at พร้อมกันได้ศูนย์)
 * ผลคือกลุ่มที่มีข้อความค้างจริงไม่เคยถูกสรุป และไม่มีร่องรอยให้ไล่
 *
 * รูปแบบผลลัพธ์ถูกกำหนดตายตัวใน migration 0020 จึงไม่ขึ้นกับการแปลง select ของชั้น REST อีก
 */
export async function getPending(targetId: string, limit = 500): Promise<PendingMessages> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("upl_watch_pending", {
    p_target: targetId,
    p_limit: limit,
  });

  if (error) throw new Error(`Failed to read pending messages for ${targetId}: ${error.message}`);
  const rows = (data ?? []) as { id: number; display_name: string | null; text: string; sent_at: string }[];

  return {
    lines: rows.map((r) => ({ name: r.display_name, text: r.text })),
    ids: rows.map((r) => r.id),
    firstAt: rows[0]?.sent_at ?? null,
    lastAt: rows[rows.length - 1]?.sent_at ?? null,
  };
}

/** ทำเครื่องหมายว่าสรุปไปแล้ว — เรียกหลังส่งสำเร็จเท่านั้น (ส่งไม่ออก = ต้องได้สรุปรอบหน้า) */
export async function markSummarized(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  const supabase = getServiceClient();
  const { error } = await supabase
    .from("upl_group_messages")
    .update({ summarized: true })
    .in("id", ids);
  if (error) throw new Error(`Failed to mark messages summarized: ${error.message}`);
}

/**
 * ลบข้อความที่เก็บไว้เกินกำหนด — เรียกจาก cron
 * นี่คือกลไกที่ทำให้สัญญา "เก็บสั้นที่สุด" เป็นจริง ไม่ใช่แค่เขียนไว้ในเอกสาร
 */
export async function purgeOldMessages(targetId: string, retentionDays: number): Promise<number> {
  const supabase = getServiceClient();
  const cutoff = new Date(Date.now() - retentionDays * 86400_000).toISOString();
  const { data, error } = await supabase
    .from("upl_group_messages")
    .delete()
    .eq("target_id", targetId)
    .lt("sent_at", cutoff)
    .select("id");

  if (error) throw new Error(`Failed to purge messages for ${targetId}: ${error.message}`);
  return (data ?? []).length;
}

// ── opt-out ──────────────────────────────────────────────────────────────────
export async function setOptOut(targetId: string, lineUserId: string, on: boolean): Promise<void> {
  const supabase = getServiceClient();
  if (on) {
    const { error } = await supabase
      .from("upl_watch_optouts")
      .upsert({ target_id: targetId, line_user_id: lineUserId }, { onConflict: "target_id,line_user_id" });
    if (error) throw new Error(`Failed to opt out: ${error.message}`);
    // ลบข้อความที่เก็บไว้แล้วของคนนี้ด้วย — ขอไม่ให้สรุป ต้องมีผลย้อนหลังด้วย
    // ไม่งั้น "ขอออก" จะกลายเป็นแค่คำสัญญาสำหรับอนาคต
    await supabase
      .from("upl_group_messages")
      .delete()
      .eq("target_id", targetId)
      .eq("line_user_id", lineUserId);
  } else {
    const { error } = await supabase
      .from("upl_watch_optouts")
      .delete()
      .eq("target_id", targetId)
      .eq("line_user_id", lineUserId);
    if (error) throw new Error(`Failed to opt in: ${error.message}`);
  }
}

export async function countOptOuts(targetId: string): Promise<number> {
  const supabase = getServiceClient();
  const { count, error } = await supabase
    .from("upl_watch_optouts")
    .select("line_user_id", { count: "exact", head: true })
    .eq("target_id", targetId);
  if (error) throw new Error(`Failed to count opt-outs: ${error.message}`);
  return count ?? 0;
}

// ── รายงานที่ส่งไปแล้ว ────────────────────────────────────────────────────────
export async function logReport(
  targetId: string,
  kind: "scheduled" | "keyword" | "manual",
  messageCount: number,
  summary: string,
  deliveredTo: string
): Promise<void> {
  const supabase = getServiceClient();
  const { error } = await supabase.from("upl_watch_reports").insert({
    target_id: targetId,
    kind,
    message_count: messageCount,
    summary: summary.slice(0, 4000),
    delivered_to: deliveredTo,
  });
  if (error) throw new Error(`Failed to log watch report: ${error.message}`);
}

/** เวลาที่ส่งรายงานล่าสุดของกลุ่มนั้น — ใช้ตัดสินว่าครบรอบหรือยัง และบอก "รอบหน้ากี่โมง" */
export async function lastReportAt(targetId: string): Promise<Date | null> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_watch_reports")
    .select("created_at")
    .eq("target_id", targetId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`Failed to read last report for ${targetId}: ${error.message}`);
  return data ? new Date(data.created_at as string) : null;
}

/**
 * จองสิทธิ์รันรอบสรุปของกลุ่มนี้ — คืน false ถ้ามีรอบอื่นทำงานอยู่
 *
 * cron ยิงทุก 1 นาที แต่รอบหนึ่งอาจใช้เวลานานกว่านั้น (AI สรุป + push) รอบถัดไปจึงเริ่ม
 * ก่อนที่รอบแรกจะ mark เสร็จ แล้วอ่านเจอข้อความชุดเดิม → ส่งสรุปซ้ำ (เกิดจริงมาแล้ว)
 */
export async function tryBeginSummary(targetId: string): Promise<boolean> {
  const supabase = getServiceClient();
  const { data, error } = await supabase.rpc("upl_watch_try_begin", { p_target: targetId });
  if (error) throw new Error(`Failed to claim summary run for ${targetId}: ${error.message}`);
  return data === true;
}

/** ปลดธง — ต้องเรียกเสมอ ไม่ว่ารอบนั้นจะสำเร็จหรือไม่ */
export async function endSummary(targetId: string): Promise<void> {
  const supabase = getServiceClient();
  await supabase.rpc("upl_watch_end", { p_target: targetId });
}

/** ทุกกลุ่มที่เปิดเฝ้าอยู่ — ใช้โดย cron */
export async function listActiveWatches(): Promise<WatchConfig[]> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_watch_configs")
    .select(CONFIG_COLUMNS)
    .eq("active", true);
  if (error) throw new Error(`Failed to list active watches: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toConfig);
}
