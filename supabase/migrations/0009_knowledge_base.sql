-- UP Line — Knowledge Base / FAQ (module_key: faq_rag_support), Phase 1.
-- A per-TENANT knowledge base (one KB shared across all of a business's groups). Retrieval is
-- self-hosted with NO paid API: pg_trgm trigram similarity, which works on Thai text WITHOUT word
-- segmentation (Postgres FTS tokenizes poorly on Thai — no spaces between words). Phase 2 (opt-in)
-- can add Gemini embeddings + pgvector for semantic search; those columns are additive later.
-- Answered in a GREEN Flex card; managed at /km/<km_token> and taught in-chat via "สอน Q = A".

create extension if not exists pg_trgm;

-- ── knowledge entries (the KB) ───────────────────────────────────────────────────────────────
create table if not exists upl_km_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  question text not null,               -- canonical question / title (what customers ask)
  answer text not null,                 -- the answer we reply with
  keywords text,                        -- optional extra search terms (synonyms, misspellings)
  source text not null default 'manual',-- 'manual' | 'chat' (taught in LINE) | a document name
  enabled boolean not null default true,
  -- Retrieval key: question + keywords (NOT the answer — long answers dilute trigram scores).
  search_text text generated always as (question || ' ' || coalesce(keywords, '')) stored,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_km_entries_tenant on upl_km_entries (tenant_id);
-- Trigram GIN index powers `search_text % :q` + `similarity(search_text, :q)` (Thai-friendly).
create index if not exists idx_km_entries_search_trgm on upl_km_entries using gin (search_text gin_trgm_ops);

-- ── unanswered questions (the "teach me this" queue / learning loop) ─────────────────────────
create table if not exists upl_km_unanswered (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  question text not null,
  target_id uuid,                        -- which chat asked (nullable; for admin context)
  ask_count integer not null default 1,  -- bumped when the same question recurs
  resolved boolean not null default false,
  created_at timestamptz not null default now(),
  last_asked_at timestamptz not null default now()
);
create index if not exists idx_km_unanswered_tenant on upl_km_unanswered (tenant_id, resolved);

-- ── per-tenant management token (mints the /km/<token> admin link) ────────────────────────────
alter table upl_tenants add column if not exists km_token text;
create unique index if not exists uq_tenants_km_token on upl_tenants (km_token) where km_token is not null;

-- ── catalog: this module ships WITHOUT an API key (Phase 1 trigram). Phase 2 embeddings = opt-in.
update upl_module_catalog set requires_api_key = false where module_key = 'faq_rag_support';

-- ── RLS (locked; server uses the service role) ──────────────────────────────────────────────
alter table upl_km_entries enable row level security;
alter table upl_km_unanswered enable row level security;
-- no policies: only the service role (which bypasses RLS) may read/write.
