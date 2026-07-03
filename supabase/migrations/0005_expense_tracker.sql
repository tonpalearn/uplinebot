-- UP Line — Expense Tracker module (บันทึกรายรับ-รายจ่าย), modeled on EunJod.
-- Records income/expense per TARGET (a LINE chat/group = one ledger, like todos),
-- auto-categorized by keyword, with day/week/month summaries (Flex + HTML report).

-- ===== Ledger entries (the transactions) =====
create table if not exists upl_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  kind text not null check (kind in ('income','expense')),
  amount numeric(14,2) not null check (amount >= 0),
  category text not null default 'อื่นๆ',
  note text,
  raw_text text,                         -- original message line (for audit/edit)
  occurred_on date not null,             -- Asia/Bangkok calendar date the money is for (backdatable)
  created_at timestamptz not null default now(),
  deleted_at timestamptz                 -- soft delete (undo / web edit)
);

create index if not exists idx_ledger_entries_target_date
  on upl_ledger_entries (target_id, occurred_on)
  where deleted_at is null;

-- ===== Learned keyword → category map (per target; EunJod's "เรียนรู้หมวด") =====
create table if not exists upl_ledger_category_map (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  keyword text not null,
  kind text not null check (kind in ('income','expense')),
  category text not null,
  created_at timestamptz not null default now(),
  unique (target_id, keyword, kind)
);

-- ===== Per-target token for the HTML money report ( /ledger/<token> ) =====
alter table upl_targets add column if not exists ledger_token text unique;

-- ===== Catalog entry (14th module) =====
insert into upl_module_catalog (module_key, name, requires_api_key, tier_min, addon_price_thb, is_core)
values ('expense_tracker', 'บันทึกรายรับ-รายจ่าย & รายงาน', false, 'pro', 990.00, false)
on conflict (module_key) do update set
  name = excluded.name,
  requires_api_key = excluded.requires_api_key,
  tier_min = excluded.tier_min,
  addon_price_thb = excluded.addon_price_thb;

-- ===== RLS (locked; server uses the service role) =====
alter table upl_ledger_entries enable row level security;
alter table upl_ledger_category_map enable row level security;
