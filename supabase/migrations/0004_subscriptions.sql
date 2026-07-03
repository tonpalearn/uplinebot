-- UP Line — self-serve subscriptions (public pricing → checkout → manage/cancel).
-- Separate concept from upl_module_subscriptions (per-tenant module entitlements).
-- These rows are created by the PUBLIC /api/subscribe flow and managed by the
-- customer via a manage_token (no login). Server access is via the service role,
-- so RLS is enabled with no public policies (fully locked down).

-- ===== Plan catalog (public pricing) =====
create table if not exists upl_plans (
  plan_key text primary key check (plan_key in ('starter','pro','business')),
  name text not null,
  tagline text,
  price_monthly integer not null,          -- THB / month
  price_yearly integer not null,           -- THB / year (billed once)
  sort integer not null default 0,
  active boolean not null default true
);

insert into upl_plans (plan_key, name, tagline, price_monthly, price_yearly, sort) values
  ('starter',  'Starter',  'เริ่มต้นให้ LINE ทำงานเอง',            990,   9900,  1),
  ('pro',      'Pro',      'ครบสำหรับร้านที่ขายและดูแลลูกค้าจริงจัง', 2990,  29900, 2),
  ('business', 'Business', 'ครบทุกโมดูล + งานหลังบ้านองค์กร',        4990,  49900, 3)
on conflict (plan_key) do update set
  name = excluded.name,
  tagline = excluded.tagline,
  price_monthly = excluded.price_monthly,
  price_yearly = excluded.price_yearly,
  sort = excluded.sort;

-- ===== Customer subscriptions =====
create table if not exists upl_customer_subscriptions (
  id uuid primary key default gen_random_uuid(),
  plan_key text not null references upl_plans(plan_key),
  billing_cycle text not null check (billing_cycle in ('monthly','yearly')),
  status text not null default 'pending'
    check (status in ('pending','active','canceled','past_due')),

  -- who is subscribing
  business_name text not null,
  customer_name text not null,
  customer_email text not null,
  customer_phone text,
  line_oa_id text,                          -- optional at signup; filled during onboarding

  -- money
  amount integer not null,                  -- THB charged for this cycle
  currency text not null default 'THB',
  payment_method text not null default 'promptpay',
  payment_ref text not null unique,         -- our order reference (also PromptPay memo)

  -- lifecycle
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  activated_at timestamptz,

  -- self-serve management (no login)
  manage_token text not null unique,

  -- optional link to a provisioned tenant once activated
  tenant_id uuid references upl_tenants(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_cust_subs_status on upl_customer_subscriptions (status);
create index if not exists idx_cust_subs_email on upl_customer_subscriptions (customer_email);
create index if not exists idx_cust_subs_created on upl_customer_subscriptions (created_at desc);

-- keep updated_at fresh
create or replace function upl_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_cust_subs_touch on upl_customer_subscriptions;
create trigger trg_cust_subs_touch
  before update on upl_customer_subscriptions
  for each row execute function upl_touch_updated_at();

-- ===== RLS (locked; server uses service role) =====
alter table upl_plans enable row level security;
alter table upl_customer_subscriptions enable row level security;
-- no policies: only the service role (which bypasses RLS) may read/write.
