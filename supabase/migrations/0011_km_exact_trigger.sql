-- Knowledge Base: exact keyword triggers + plain-text answers.
-- A message that EXACTLY matches an entry's trigger keyword (e.g. "opb2026") is answered directly,
-- with NO "ถาม" prefix needed. Answers are sent as plain text (the admin formats them + can paste
-- links that LINE auto-links), not a Flex card.

alter table upl_km_entries add column if not exists trigger_keywords text;

-- Exact-trigger lookup: does `p_text` (trimmed, lowercased) exactly equal any of an entry's
-- trigger_keywords (the field is split on newline OR comma)? Returns the matching entry, newest
-- first. Used by the handler on EVERY inbound text (indexed on tenant_id) — cheap, and it only
-- ever matches entries that have an explicit trigger, so non-trigger chatter stays silent.
-- Matches when the message exactly equals the entry QUESTION (admins naturally put the keyword in
-- the question field, e.g. question "opb2026") OR any of its trigger_keywords. Case/space-insensitive.
create or replace function km_exact(p_tenant uuid, p_text text)
returns table (id uuid, question text, answer text, source text)
language sql
stable
as $$
  select e.id, e.question, e.answer, e.source
  from upl_km_entries e
  where e.tenant_id = p_tenant
    and e.enabled = true
    and (
      lower(btrim(p_text)) = lower(btrim(e.question))
      or (
        e.trigger_keywords is not null
        and lower(btrim(p_text)) = any (
          select btrim(lower(t))
          from regexp_split_to_table(e.trigger_keywords, '[\n,]+') as t
          where btrim(t) <> ''
        )
      )
    )
  order by e.updated_at desc
  limit 1
$$;
