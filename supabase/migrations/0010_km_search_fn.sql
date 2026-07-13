-- UP Line — Knowledge Base retrieval function (follow-up to 0009).
--
-- supabase-js cannot express `similarity(search_text, :q)` inside a .select() (it is not a
-- real column), so retrieval is done through this thin SQL function called via
-- supabase.rpc('km_search', { p_tenant, p_query, p_limit }). It ranks a tenant's enabled KM
-- entries by pg_trgm trigram similarity and returns each row's score, so the application can
-- apply its own (tunable) threshold in TypeScript — KM_MATCH_THRESHOLD in
-- lib/modules/knowledge-base/store.ts — WITHOUT a migration to retune.
--
-- WHY no `%` operator / no default similarity_threshold: pg_trgm's `%` uses the session GUC
-- pg_trgm.similarity_threshold (default 0.3), which is far too high for Thai text (trigram
-- scores on segmentation-free Thai run low). We therefore rank with similarity() directly and
-- let the app threshold at ~0.12. The GIN(search_text gin_trgm_ops) index from 0009 still
-- accelerates trigram ops; per-tenant KBs are small in Phase 1 so a scan is cheap regardless.
--
-- Read-only + STABLE. No SECURITY DEFINER: the only caller is the trusted server (service role),
-- which bypasses RLS already.

create or replace function km_search(p_tenant uuid, p_query text, p_limit int)
returns table (
  id uuid,
  question text,
  answer text,
  source text,
  score real
)
language sql
stable
as $$
  select
    e.id,
    e.question,
    e.answer,
    e.source,
    similarity(e.search_text, p_query) as score
  from upl_km_entries e
  where e.tenant_id = p_tenant
    and e.enabled = true
  order by similarity(e.search_text, p_query) desc, e.updated_at desc
  limit greatest(coalesce(p_limit, 3), 1)
$$;
