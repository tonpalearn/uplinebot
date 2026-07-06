-- UP Line — self-hosted payment-slip verification (Phase 1).
-- We decode the QR embedded in an uploaded transfer slip ourselves (sharp + jsQR) instead of
-- calling a paid slip API. The raw QR string is unique per transaction, so it (plus a sha256
-- of the image bytes and the parsed transRef) forms a multi-layer anti-replay key set:
-- the same slip can never activate two subscriptions.
-- Created/consumed by POST /api/subscribe/verify-slip (service role). RLS locked, no policies.

create table if not exists upl_payment_slips (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references upl_customer_subscriptions(id) on delete cascade,

  -- decoded slip data (best-effort; only image_hash is guaranteed present)
  raw_qr text,                       -- raw decoded QR text — primary anti-replay key
  trans_ref text,                    -- transaction ref parsed from EMVCo TLV, when present
  sending_bank text,                 -- sending bank hint parsed from the QR, when present
  amount numeric,                    -- amount if ever parsed from the slip (not trusted for money)
  slip_datetime timestamptz,         -- transfer timestamp if ever parsed from the slip

  image_hash text not null,          -- sha256 (hex) of the uploaded image bytes — anti-replay key
  created_at timestamptz not null default now()
);

-- ===== Multi-layer anti-replay =====
-- (a) exact same image can never be reused
create unique index if not exists uq_payment_slips_image_hash
  on upl_payment_slips (image_hash);
-- (b) same QR payload (the strongest per-transaction key) can never be reused
create unique index if not exists uq_payment_slips_raw_qr
  on upl_payment_slips (raw_qr) where raw_qr is not null;
-- (c) same parsed transaction reference can never be reused
create unique index if not exists uq_payment_slips_trans_ref
  on upl_payment_slips (trans_ref) where trans_ref is not null;

create index if not exists idx_payment_slips_subscription
  on upl_payment_slips (subscription_id);

-- ===== Subscription: record how/when payment was verified =====
alter table upl_customer_subscriptions
  add column if not exists payment_verified_at timestamptz;
alter table upl_customer_subscriptions
  add column if not exists payment_channel text
    check (payment_channel in ('web','line','admin'));

-- ===== RLS (locked; server uses the service role) =====
alter table upl_payment_slips enable row level security;
-- no policies: only the service role (which bypasses RLS) may read/write.
