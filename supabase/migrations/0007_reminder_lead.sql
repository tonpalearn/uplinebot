-- UP Line — configurable reminder lead time (เตือนก่อนถึงเวลา N นาที).
-- Per-target DEFAULT + optional per-task OVERRIDE. The reminder scan fires when
-- now >= due_at - lead, where lead = todo.remind_before_minutes ?? target.reminder_lead_minutes ?? 0.

-- per-task override (null = use the target's default)
alter table upl_todos add column if not exists remind_before_minutes integer;

-- per-target default (minutes before due to remind; 0 = at the due time)
alter table upl_targets add column if not exists reminder_lead_minutes integer not null default 0;
