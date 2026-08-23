-- UP Line — โมดูลที่ 17: ผู้ช่วยเฝ้ากลุ่ม (group_watcher)
--
-- บอทอยู่ในกลุ่ม อ่านข้อความที่คุยกัน แล้วสรุปประเด็นส่งให้เจ้าของ (แชทส่วนตัว หรือกลุ่มที่กำหนด)
-- ตามรอบเวลา หรือเด้งทันทีเมื่อเจอคำสำคัญ
--
-- ⚠️ ฟีเจอร์นี้ต่างจากทุกโมดูลก่อนหน้าโดยพื้นฐาน: โมดูลอื่นประมวลผล "ข้อความที่ส่งถึงบอท"
-- แต่อันนี้อ่าน **บทสนทนาของคนอื่น** แล้วส่งต่อให้คนที่ไม่ได้อยู่ในวงสนทนานั้น
-- จึงต้องมีกติกาคุ้มครองคนในกลุ่มติดมากับตัวโครงสร้างข้อมูลเอง ไม่ใช่ฝากไว้กับวินัยของผู้ตั้งค่า:
--
--   1. เก็บข้อความดิบสั้นที่สุดเท่าที่ทำงานได้ (`retention_days` ค่าเริ่มต้น 3 วัน) แล้วลบอัตโนมัติ
--   2. เก็บเฉพาะ "ข้อความตัวอักษร" — ไม่เก็บรูป ไฟล์ เสียง ตำแหน่ง (ดู handler)
--   3. สมาชิกคนไหนขอไม่ให้สรุปข้อความตัวเอง ต้องทำได้ (`upl_watch_optouts`) และมีผลทันที
--   4. ค่าเริ่มต้นของสรุปคือ **ไม่ระบุชื่อคนพูด** (`include_names=false`) — สรุปว่า "คุยเรื่องอะไร"
--      ไม่ใช่ "ใครพูดอะไร" · เปิดระบุชื่อได้แต่ต้องตั้งใจเปิดเอง
--   5. ใครก็ได้ในกลุ่มพิมพ์ถามได้ว่ากำลังเฝ้าอะไรอยู่ ส่งให้ใคร (คำสั่ง "เฝ้าอะไรอยู่")
--      — ความโปร่งใสต้องเป็นสิทธิ์ของคนถูกสรุป ไม่ใช่ของคนสั่งสรุป

-- ── ข้อความที่เก็บไว้รอสรุป ────────────────────────────────────────────────────
create table if not exists upl_group_messages (
  id            bigserial primary key,
  target_id     uuid not null references upl_targets(id) on delete cascade,
  line_user_id  text,                       -- ใครพูด (null ได้ถ้า LINE ไม่ส่งมา)
  display_name  text,                       -- ชื่อที่แสดง ณ ตอนนั้น (best-effort)
  text          text not null,
  sent_at       timestamptz not null default now(),
  -- true = ถูกรวมในสรุปรอบใดรอบหนึ่งไปแล้ว (กันสรุปซ้ำเรื่องเดิม)
  summarized    boolean not null default false
);

create index if not exists idx_group_messages_pending
  on upl_group_messages (target_id, sent_at) where not summarized;
create index if not exists idx_group_messages_purge
  on upl_group_messages (sent_at);

-- ── ตั้งค่าการเฝ้าต่อกลุ่ม ─────────────────────────────────────────────────────
create table if not exists upl_watch_configs (
  target_id        uuid primary key references upl_targets(id) on delete cascade,
  tenant_id        uuid not null references upl_tenants(id) on delete cascade,
  active           boolean not null default true,

  -- ส่งสรุปไปไหน: แชทส่วนตัวของเจ้าของ และ/หรือ กลุ่มปลายทางอีกกลุ่ม
  report_to_user   text,                    -- lineUserId ของเจ้าของ (push 1:1)
  report_to_target uuid references upl_targets(id) on delete set null,

  -- รอบเวลา: 'interval' = ทุก N นาที · 'times' = ตามเวลาของวัน · 'off' = เฉพาะคำสำคัญ/สั่งเอง
  schedule_kind    text not null default 'interval'
                   check (schedule_kind in ('interval','times','off')),
  interval_minutes int  not null default 240 check (interval_minutes between 15 and 1440),
  report_times     text,                    -- 'HH:MM,HH:MM' เวลาไทย (ใช้เมื่อ kind='times')

  -- คำสำคัญ: เจอแล้วเด้งทันทีไม่รอรอบ (คั่นด้วยคอมมา — กติกาเดียวกับ aliases ของฐานอาหาร)
  keywords         text,
  -- คำที่บ่งบอกว่าเรื่องด่วน/ไม่พอใจ — เด้งทันทีพร้อมป้ายเตือน
  urgent_keywords  text,

  -- ความเป็นส่วนตัว
  include_names    boolean not null default false,
  retention_days   int not null default 3 check (retention_days between 1 and 30),

  -- กันรบกวน: ไม่มีข้อความใหม่ = ไม่ส่ง · และไม่ส่งถี่กว่านี้แม้เจอคำสำคัญรัว ๆ
  min_messages     int not null default 3 check (min_messages >= 1),
  alert_cooldown_minutes int not null default 10 check (alert_cooldown_minutes >= 0),
  last_alert_at    timestamptz,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ── สมาชิกที่ขอไม่ให้สรุปข้อความตัวเอง ─────────────────────────────────────────
create table if not exists upl_watch_optouts (
  target_id    uuid not null references upl_targets(id) on delete cascade,
  line_user_id text not null,
  created_at   timestamptz not null default now(),
  primary key (target_id, line_user_id)
);

-- ── รายงานที่ส่งไปแล้ว (ไว้ตรวจย้อนหลังว่าเคยส่งอะไรออกไป) ───────────────────────
create table if not exists upl_watch_reports (
  id           uuid primary key default gen_random_uuid(),
  target_id    uuid not null references upl_targets(id) on delete cascade,
  kind         text not null check (kind in ('scheduled','keyword','manual')),
  message_count int not null default 0,
  summary      text,
  delivered_to text,                        -- อธิบายปลายทางแบบอ่านออก
  created_at   timestamptz not null default now()
);

create index if not exists idx_watch_reports_recent on upl_watch_reports (target_id, created_at desc);

-- job_type เดิมเป็น CHECK แบบระบุค่า — เพิ่มชนิดใหม่ของโมดูลนี้
alter table upl_scheduled_jobs drop constraint if exists upl_scheduled_jobs_job_type_check;
alter table upl_scheduled_jobs add constraint upl_scheduled_jobs_job_type_check
  check (job_type in ('broadcast','morning_brief','booking_reminder','membership_renewal','group_watch'));

alter table upl_group_messages enable row level security;
alter table upl_watch_configs  enable row level security;
alter table upl_watch_optouts  enable row level security;
alter table upl_watch_reports  enable row level security;

-- แคตตาล็อกโมดูล (ตัวที่ 17)
insert into upl_module_catalog (module_key, name, requires_api_key, tier_min, addon_price_thb, is_core)
values ('group_watcher', 'ผู้ช่วยเฝ้ากลุ่ม & สรุปบทสนทนา', false, 'pro', 1290.00, false)
on conflict (module_key) do update set
  name = excluded.name,
  requires_api_key = excluded.requires_api_key,
  tier_min = excluded.tier_min,
  addon_price_thb = excluded.addon_price_thb;

comment on table upl_group_messages is
  'ข้อความกลุ่มที่เก็บชั่วคราวรอสรุป — ลบอัตโนมัติตาม upl_watch_configs.retention_days';
comment on column upl_watch_configs.include_names is
  'ค่าเริ่มต้น false = สรุปว่าคุยเรื่องอะไร ไม่ระบุว่าใครพูด (คุ้มครองคนในกลุ่ม)';
