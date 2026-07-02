-- UP Line — initial schema migration
-- Source: SYSTEM-DESIGN.md §3 (Data Model — DDL) and §3.1 (Row Level Security), verbatim.
-- Plus: seed of upl_module_catalog from SPEC.md §6 (Module Catalog) / §7 (Pricing & Packaging Model).

-- ===== Tenancy & Billing =====
create table upl_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plan_tier text not null default 'starter' check (plan_tier in ('starter','pro','business')),
  trial_ends_at timestamptz,
  created_at timestamptz not null default now()
);

create table upl_users_admin (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  auth_user_id uuid not null references auth.users(id),
  role text not null default 'manager' check (role in ('owner','manager')),
  created_at timestamptz not null default now(),
  unique (tenant_id, auth_user_id)
);

create table upl_module_catalog (        -- global, not tenant-scoped
  module_key text primary key,
  name text not null,
  requires_api_key boolean not null default false,
  tier_min text not null check (tier_min in ('starter','pro','business')),
  addon_price_thb numeric(10,2),
  is_core boolean not null default false  -- true for core_engine/admin_dashboard: never billed standalone
);

create table upl_module_subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  module_key text not null references upl_module_catalog(module_key),
  enabled boolean not null default true,
  billing_mode text not null check (billing_mode in ('included_in_tier','addon')),
  activated_at timestamptz not null default now(),
  unique (tenant_id, module_key)
);

-- ===== Bots & Targets =====
create table upl_bots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  line_channel_id text not null unique,
  channel_secret_enc bytea not null,      -- pgsodium-encrypted
  access_token_enc bytea not null,
  default_prefix text,
  group_reply_mode text not null default 'mention_only'
    check (group_reply_mode in ('mention_only','prefix','all')),
  allowed_group_ids text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table upl_targets (
  id uuid primary key default gen_random_uuid(),
  bot_id uuid not null references upl_bots(id) on delete cascade,
  line_source_id text not null,           -- LINE userId/groupId/roomId
  source_type text not null check (source_type in ('user','group','room')),
  display_name text,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (bot_id, line_source_id)
);

create table upl_module_configs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  module_key text not null references upl_module_catalog(module_key),
  settings jsonb not null default '{}'::jsonb,
  unique (target_id, module_key)
);

-- ===== Provider Credentials (requires_api_key modules) =====
create table upl_provider_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  module_key text not null references upl_module_catalog(module_key),
  provider text not null,                 -- 'slipok' | 'easyslip' | 'google_calendar' | 'gemini' | 'promptpay' | ...
  credential_enc bytea not null,           -- pgsodium-encrypted secret (API key or OAuth refresh token)
  metadata jsonb not null default '{}'::jsonb,  -- non-secret: scopes, account id, expiry — safe to read for status display
  status text not null default 'active' check (status in ('active','expired','revoked')),
  created_at timestamptz not null default now(),
  unique (tenant_id, module_key, provider)
);

-- ===== Core operational tables =====
create table upl_message_logs (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  module_key text,
  status text not null check (status in ('ok','error','silent')),
  raw jsonb,
  created_at timestamptz not null default now()
);
-- retention: partition by month, drop partitions older than retention policy (default 1yr, tenant-configurable)
create index idx_message_logs_target_created on upl_message_logs (target_id, created_at desc);
create index idx_message_logs_module_status on upl_message_logs (module_key, status);

create table upl_todos (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  content text not null,
  done boolean not null default false,
  due_date date,
  created_at timestamptz not null default now()
);

create table upl_calendar_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  refresh_token_enc bytea not null,
  calendar_id text not null default 'primary'
);

create table upl_broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  title text not null,
  message_type text not null check (message_type in ('text','flex')),
  payload jsonb not null,
  trigger_keyword text
);

create table upl_scheduled_jobs (          -- unifies broadcast schedules + morning brief + any future cron-driven module
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  job_type text not null check (job_type in ('broadcast','morning_brief','booking_reminder','membership_renewal')),
  ref_id uuid,                              -- e.g. broadcast_id, or null for per-target jobs like morning_brief
  target_id uuid references upl_targets(id) on delete cascade,
  cron_expr text,                           -- for recurring
  run_at timestamptz,                       -- for one-shot
  timezone text not null default 'Asia/Bangkok',
  active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index idx_scheduled_jobs_due on upl_scheduled_jobs (next_run_at) where active;

-- ===== Slip Verification (P2 — build first) =====
create table upl_slip_verifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  target_id uuid not null references upl_targets(id) on delete cascade,
  slip_ref_hash text not null,             -- sha256(bank_code || txn_ref || amount || txn_time) — dedupe key
  amount numeric(12,2),
  bank_code text,
  txn_time timestamptz,
  status text not null check (status in ('pending','verified','duplicate','failed','fraud_flag')),
  provider text not null,                  -- 'slipok' | 'easyslip'
  provider_response jsonb,                 -- raw response, minus any long-lived PII
  order_ref text,                          -- free-text or FK to upl_orders.id once Commerce module exists
  created_at timestamptz not null default now(),
  unique (tenant_id, slip_ref_hash)         -- DB-level duplicate guard, not just app logic
);
create index idx_slip_target_created on upl_slip_verifications (target_id, created_at desc);

-- ===== Future-module tables (defined now so ER stays stable; built in P3/P4) =====
create table upl_bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  target_id uuid not null references upl_targets(id) on delete cascade,
  slot_time timestamptz not null,
  status text not null check (status in ('booked','confirmed','cancelled','no_show','completed'))
);

create table upl_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  target_id uuid not null references upl_targets(id) on delete cascade,
  items jsonb not null,
  status text not null check (status in ('cart','placed','paid','fulfilled','cancelled'))
);

create table upl_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references upl_tenants(id) on delete cascade,
  name text,
  phone text,
  tag text,
  created_at timestamptz not null default now()
);

-- ===== Row Level Security (RLS) =====
-- Pattern: every tenant-scoped table restricts to tenants the authenticated admin user belongs to,
-- via upl_users_admin. The BFF uses the Supabase service role for webhook/cron processing
-- (bypasses RLS by design). RLS exists as defense-in-depth for direct client-side Supabase calls.

alter table upl_tenants enable row level security;
alter table upl_bots enable row level security;
alter table upl_targets enable row level security;
alter table upl_module_subscriptions enable row level security;
alter table upl_slip_verifications enable row level security;
-- ...repeat enable for every tenant-scoped table
alter table upl_users_admin enable row level security;
alter table upl_module_configs enable row level security;
alter table upl_provider_credentials enable row level security;
alter table upl_message_logs enable row level security;
alter table upl_todos enable row level security;
alter table upl_calendar_links enable row level security;
alter table upl_broadcasts enable row level security;
alter table upl_scheduled_jobs enable row level security;
alter table upl_bookings enable row level security;
alter table upl_orders enable row level security;
alter table upl_leads enable row level security;
alter table upl_module_catalog enable row level security;

create policy tenant_isolation_tenants on upl_tenants
  for all using (id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_bots on upl_bots
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_subscriptions on upl_module_subscriptions
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_slips on upl_slip_verifications
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

-- upl_targets has no tenant_id directly — join through bots
create policy tenant_isolation_targets on upl_targets
  for all using (bot_id in (
    select id from upl_bots where tenant_id in (
      select tenant_id from upl_users_admin where auth_user_id = auth.uid()
    )
  ));

-- Apply the same tenant_id in (select ... from upl_users_admin ...) policy shape to every
-- remaining tenant-scoped table. upl_todos is scoped via target -> bot -> tenant join.

create policy tenant_isolation_users_admin on upl_users_admin
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_module_configs on upl_module_configs
  for all using (target_id in (
    select t.id from upl_targets t
    join upl_bots b on b.id = t.bot_id
    where b.tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid())
  ));

create policy tenant_isolation_provider_credentials on upl_provider_credentials
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_message_logs on upl_message_logs
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_todos on upl_todos
  for all using (target_id in (
    select t.id from upl_targets t
    join upl_bots b on b.id = t.bot_id
    where b.tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid())
  ));

create policy tenant_isolation_calendar_links on upl_calendar_links
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_broadcasts on upl_broadcasts
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_scheduled_jobs on upl_scheduled_jobs
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_bookings on upl_bookings
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_orders on upl_orders
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

create policy tenant_isolation_leads on upl_leads
  for all using (tenant_id in (select tenant_id from upl_users_admin where auth_user_id = auth.uid()));

-- upl_module_catalog is global/read-only for all authenticated users (no tenant filter needed) —
-- grant select only, no insert/update from client roles.
create policy module_catalog_read_all on upl_module_catalog
  for select using (true);

-- ===== Seed: upl_module_catalog =====
-- Source: SPEC.md §6 (Module Catalog table) + §7.1/§7.2 (Pricing & Packaging Model).
-- tier_min / requires_api_key / addon_price_thb taken verbatim from those tables.
-- Core Engine + Admin Dashboard are is_core = true (never billed standalone, addon_price_thb null).
insert into upl_module_catalog (module_key, name, requires_api_key, tier_min, addon_price_thb, is_core) values
  ('core_engine',            'Core Bot Engine',                              true,  'starter',  null,    true),
  ('admin_dashboard',        'Admin Dashboard',                              false, 'starter',  null,    true),
  ('assistant_productivity', 'Assistant: Todo, Calendar & Morning Brief',    true,  'starter',  null,    false),
  ('broadcast_campaigns',    'Broadcast & Campaigns',                       false, 'starter',  null,    false),
  ('slip_verification',      'Slip Verification & Payment OCR',              true,  'pro',      990.00,  false),
  ('receipt_ekyc_ocr',       'Receipt/Expense OCR & ID-Card e-KYC',          true,  'business', 2490.00, false),
  ('commerce_ordering',      'In-chat Commerce & Ordering',                  true,  'pro',      1990.00, false),
  ('booking_appointments',   'Booking & Appointments',                       true,  'pro',      1490.00, false),
  ('faq_rag_support',        'FAQ Auto-reply (RAG) & Support Desk',          true,  'pro',      1990.00, false),
  ('internal_ops_hr',        'Internal Ops: HR & Approvals',                 true,  'business', 2990.00, false),
  ('crm_lead_capture',       'CRM & Lead Capture',                           true,  'pro',      1490.00, false),
  ('community_course',       'Community & Course Delivery',                  true,  'pro',      1990.00, false),
  ('multi_branch',           'Multi-Branch Management',                      false, 'pro',      990.00,  false);
