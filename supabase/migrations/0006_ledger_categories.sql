-- UP Line — Expense Tracker: per-target category customization (EunJod-style).
-- A row exists ONLY when a target customizes a category: adds a custom one (is_custom=true),
-- hides a built-in (hidden=true), or overrides its emoji/sort. The "effective" category list
-- for a target = DEFAULT_CATEGORIES (in code) minus hidden, union custom, ordered by sort.
-- Recategorizing a transaction just updates upl_ledger_entries.category (+ optional learn into
-- upl_ledger_category_map); this table only governs the pickable list, not the stored strings.

create table if not exists upl_ledger_categories (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('income','expense')),
  emoji text,
  sort integer not null default 100,
  hidden boolean not null default false,
  is_custom boolean not null default true,   -- true = user-added; false = override of a built-in
  created_at timestamptz not null default now(),
  unique (target_id, name, kind)
);

create index if not exists idx_ledger_categories_target
  on upl_ledger_categories (target_id, kind);

alter table upl_ledger_categories enable row level security;
