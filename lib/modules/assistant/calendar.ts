import type { OutboundMessage } from "../types";

/**
 * STUB — Calendar Sync (Google OAuth), per SPEC.md §6.3 and SYSTEM-DESIGN.md §4.2 TODO notes.
 *
 * Real implementation needs:
 * - upl_calendar_links row (refresh_token_enc, decrypted via lib/crypto.ts) for the tenant.
 * - A Google OAuth app (client id/secret + consent flow) that is NOT part of this pass —
 *   out of scope per task instructions ("Calendar ... out of scope for this pass since they
 *   need real Google OAuth").
 * - Once connected: create/list events against the Google Calendar API using the decrypted
 *   refresh token, likely triggered by "นัดหมาย"/"ปฏิทิน" style commands or purely from the
 *   Admin Dashboard.
 *
 * This stub returns a clear Thai "not yet connected" message so the interface is complete
 * without pretending calendar sync works.
 */
export async function handleCalendarIntent(): Promise<OutboundMessage[]> {
  return [
    {
      type: "text",
      text: "ปฏิทิน (Google Calendar) ยังไม่ได้เชื่อมต่อ — ฟีเจอร์นี้ต้องผูก Google OAuth ก่อนใช้งานได้",
    },
  ];
}
