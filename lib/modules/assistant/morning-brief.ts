import type { OutboundMessage, ScheduledJob, TenantContext } from "../types";

/**
 * STUB — Morning Brief scheduled job (job_type 'morning_brief'), per SPEC.md §6.3 and
 * SYSTEM-DESIGN.md §4.4.
 *
 * Real implementation would combine today's upl_todos (this pass's real CRUD could feed
 * it) with upcoming Google Calendar events and an optional news digest into one Flex
 * message, then rely on the Scheduled Job Dispatcher to push it via LINE. It is left as a
 * stub here because it depends on Calendar Sync (Google OAuth) and News Digest, both out
 * of scope for this pass — wiring only the todo half in would give a misleadingly partial
 * brief, so this returns a clear Thai "not yet connected" message instead.
 */
export async function handleMorningBriefJob(
  _job: ScheduledJob,
  _ctx: TenantContext
): Promise<OutboundMessage[]> {
  return [
    {
      type: "text",
      text: "Morning Brief ยังไม่ได้เชื่อมต่อ — รอผูกปฏิทิน (Google OAuth) และสรุปข่าวให้ครบก่อน",
    },
  ];
}
