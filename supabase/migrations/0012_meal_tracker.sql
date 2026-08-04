-- UP Line — Meal Tracker module (บันทึกอาหาร + สัดส่วนสารอาหาร C:P:F).
-- พิมพ์ "กิน <มื้อ> <วันที่>" แล้วไล่รายการอาหารทีละบรรทัด → บอทจับคู่ฐานอาหาร คำนวณคาร์บ/โปรตีน/
-- ไขมัน (กรัม) + %พลังงานจากแต่ละสารอาหาร แล้วตอบเป็นการ์ด Flex พร้อมกราฟโดนัท และสรุปรวมทั้งวันได้.
--
-- ขอบเขตข้อมูล (สำคัญ):
--   • upl_food_items เก็บ "ฐานอาหาร" — แถวที่ tenant_id IS NULL = ฐานกลางที่ระบบ seed มาให้ (แชร์ทุก
--     ธุรกิจ, อ่านอย่างเดียวในทางปฏิบัติ); แถวที่มี tenant_id = อาหารที่ธุรกิจนั้นสอนเอง ("สอนอาหาร")
--     ซึ่งจะ "ทับ" ชื่อเดียวกันของฐานกลางเสมอ (ดู meal_food_search)
--   • upl_meal_entries เก็บ "สิ่งที่กินจริง" — ผูกกับ target (แชท/กลุ่ม) + line_user_id (ใครกิน)
--     จึงแยกไดอารี่ของแต่ละคนในกลุ่มเดียวกันได้ โดยไม่ต้องแก้ TenantContext
--   • ตัวเลขมาโครถูก "แช่แข็ง" ลงในแถว entry ตอนบันทึก (snapshot) — แก้ฐานอาหารทีหลังจะไม่ย้อนไป
--     เปลี่ยนประวัติที่บันทึกไปแล้ว (ยกเว้นการ backfill รายการที่ยังไม่รู้จัก ซึ่งตั้งใจให้เกิด)

create extension if not exists pg_trgm;

-- ===== ฐานอาหาร =====
-- basis อธิบายว่าตัวเลข kcal/carb/protein/fat ที่เก็บไว้ "ต่ออะไร":
--   per_100g    → ต่อ 100 กรัม (วัตถุดิบ: ข้าวสวย, อกไก่, กล้วย)
--   per_serving → ต่อ 1 หน่วยเสิร์ฟ (เมนูจานเดียว: ข้าวมันไก่ 1 จาน, ไข่ต้ม 1 ฟอง)
-- unit_label/unit_grams = สะพานแปลงหน่วย ⇄ กรัม (ทัพพี 60 g, ฟอง 50 g) ทำให้ผู้ใช้พิมพ์ได้ทั้ง
-- "ข้าวสวย 100g" และ "ข้าวสวย 1 ทัพพี" โดยคำนวณถูกทั้งคู่.
create table if not exists upl_food_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references upl_tenants(id) on delete cascade,  -- null = ฐานกลาง
  name text not null,
  aliases text,                                    -- คำเรียกอื่น คั่นด้วย , (เช่น "อกไก่,chicken breast")
  basis text not null default 'per_100g' check (basis in ('per_100g','per_serving')),
  unit_label text,                                 -- 'ทัพพี' | 'ฟอง' | 'จาน' | 'แก้ว' | ...
  unit_grams numeric(8,2),                         -- น้ำหนักโดยประมาณต่อ 1 หน่วย
  kcal numeric(8,2) not null,
  carb_g numeric(8,2) not null default 0,
  protein_g numeric(8,2) not null default 0,
  fat_g numeric(8,2) not null default 0,
  source text not null default 'seed-approx',      -- 'seed-approx' | 'chat' | 'admin'
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ชื่อห้ามซ้ำ "ภายในเจ้าของเดียวกัน" — ฐานกลาง (tenant_id null) ต้องใช้ partial unique เพราะ
-- NULL ไม่เท่ากับ NULL ใน unique constraint ปกติ
create unique index if not exists uq_food_items_global_name
  on upl_food_items (lower(btrim(name))) where tenant_id is null;
create unique index if not exists uq_food_items_tenant_name
  on upl_food_items (tenant_id, lower(btrim(name))) where tenant_id is not null;

-- ค้นชื่อแบบ fuzzy (ไทยไม่มีเว้นวรรคระหว่างคำ → trigram ทำงานดีกว่า full-text)
create index if not exists idx_food_items_name_trgm
  on upl_food_items using gin (name gin_trgm_ops);
create index if not exists idx_food_items_tenant on upl_food_items (tenant_id);

-- ===== รายการอาหารที่กินจริง =====
create table if not exists upl_meal_entries (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null references upl_targets(id) on delete cascade,
  line_user_id text,                               -- ใครกิน (แยกไดอารี่รายคนในกลุ่ม); null = ไม่ทราบ
  occurred_on date not null,                       -- วันตามปฏิทิน Asia/Bangkok (ย้อนหลังได้)
  meal_slot text not null default 'other'
    check (meal_slot in ('breakfast','lunch','dinner','snack','other')),
  food_id uuid references upl_food_items(id) on delete set null,
  food_name text not null,                         -- ชื่อที่ผู้ใช้พิมพ์ (เก็บไว้ตรวจ/สอนย้อนหลัง)
  qty numeric(10,2) not null default 1,
  qty_unit text not null default 'unit',           -- 'g' | 'unit'
  grams numeric(10,2),                             -- น้ำหนักจริงถ้าคำนวณได้
  kcal numeric(10,2) not null default 0,
  carb_g numeric(10,2) not null default 0,
  protein_g numeric(10,2) not null default 0,
  fat_g numeric(10,2) not null default 0,
  resolved boolean not null default true,          -- false = ยังไม่รู้จักอาหารนี้ (มาโคร = 0, รอ "สอนอาหาร")
  raw_text text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists idx_meal_entries_diary
  on upl_meal_entries (target_id, line_user_id, occurred_on)
  where deleted_at is null;

-- ใช้ตอน backfill: หา entry ที่ยังไม่รู้จักชื่อนี้ หลังผู้ใช้ "สอนอาหาร"
create index if not exists idx_meal_entries_unresolved
  on upl_meal_entries (target_id, lower(btrim(food_name)))
  where deleted_at is null and resolved = false;

-- ===== ค้นหาอาหาร: ตรงเป๊ะ → alias → trigram =====
-- คืนผลเรียงตาม "ความมั่นใจ": อาหารของ tenant เองมาก่อนฐานกลางเสมอ (ธุรกิจสอนทับได้),
-- แล้วจึงเรียงตามคะแนนความคล้าย. limit ให้ผู้เรียกตัดสินใจว่ารับผลแรกไหม.
create or replace function meal_food_search(p_tenant uuid, p_name text, p_limit int default 5)
returns table (
  id uuid, tenant_id uuid, name text, basis text, unit_label text, unit_grams numeric,
  kcal numeric, carb_g numeric, protein_g numeric, fat_g numeric, source text, score real
)
language sql
stable
as $$
  with q as (select lower(btrim(p_name)) as needle),
  scored as (
    select
      f.id, f.tenant_id, f.name, f.basis, f.unit_label, f.unit_grams,
      f.kcal, f.carb_g, f.protein_g, f.fat_g, f.source,
      case
        -- ตรงเป๊ะกับชื่อ (ตัดช่องว่างทั้งหมดออกก่อน เพื่อรับ "ข้าว สวย" = "ข้าวสวย")
        when replace(lower(btrim(f.name)), ' ', '') = replace((select needle from q), ' ', '') then 1.0::real
        -- ตรงเป๊ะกับ alias ตัวใดตัวหนึ่ง
        when exists (
          select 1 from regexp_split_to_table(coalesce(f.aliases, ''), ',') a
          where btrim(a) <> ''
            and replace(lower(btrim(a)), ' ', '') = replace((select needle from q), ' ', '')
        ) then 0.99::real
        else similarity(f.name, (select needle from q))
      end as score
    from upl_food_items f
    where f.tenant_id is null or f.tenant_id = p_tenant
  )
  select id, tenant_id, name, basis, unit_label, unit_grams,
         kcal, carb_g, protein_g, fat_g, source, score
  from scored
  where score >= 0.34
  order by (tenant_id is not null) desc, score desc, length(name) asc
  limit p_limit
$$;

-- ===== Catalog entry (16th module) =====
insert into upl_module_catalog (module_key, name, requires_api_key, tier_min, addon_price_thb, is_core)
values ('meal_tracker', 'บันทึกอาหาร & สารอาหาร C:P:F', false, 'pro', 990.00, false)
on conflict (module_key) do update set
  name = excluded.name,
  requires_api_key = excluded.requires_api_key,
  tier_min = excluded.tier_min,
  addon_price_thb = excluded.addon_price_thb;

-- ===== RLS (ล็อก; เซิร์ฟเวอร์ใช้ service role) =====
alter table upl_food_items enable row level security;
alter table upl_meal_entries enable row level security;
