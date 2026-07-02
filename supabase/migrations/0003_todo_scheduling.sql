-- UP Line — migration 0003: Todo scheduling + calendar plan tokens
--
-- Adds the columns the "complete todo experience" needs (SPEC.md §6.3 Todo Manager):
--   * upl_todos.due_at      — optional absolute due instant (timestamptz, UTC) for a task.
--                             Parsed from Thai natural language and stored as an absolute
--                             instant; user-facing formatting is done in Asia/Bangkok.
--                             Supersedes the date-only `due_date` for time-based reminders.
--   * upl_todos.reminded_at — set once the time-based reminder has been pushed, so the cron
--                             reminder scan never double-notifies a task.
--   * upl_todos.sort_order  — optional manual ordering (set by the calendar web page when the
--                             customer drags tasks around). NULL falls back to created_at order,
--                             so existing rows keep their current oldest-first numbering.
--   * upl_targets.plan_token — URL-safe random token minting the per-target calendar link
--                             `/plan/<token>`. Unique so a token resolves to exactly one target.

alter table upl_todos add column due_at timestamptz;
alter table upl_todos add column reminded_at timestamptz;
alter table upl_todos add column sort_order integer;

alter table upl_targets add column plan_token text unique;

-- Reminder scan hot path: find pending, un-reminded, due tasks cheaply. Partial index keeps it
-- tiny (only rows that could still fire a reminder are indexed).
create index idx_todos_due_pending on upl_todos (due_at)
  where due_at is not null and done = false and reminded_at is null;
