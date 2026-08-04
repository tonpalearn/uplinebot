-- UP Line — หน้าเว็บจัดการอาหาร /meal/<token>
--
-- ⚠️ ต่างจาก ledger_token / km_token ตรง "ขอบเขต" อย่างมีเหตุผล:
--   • ledger_token อยู่บน upl_targets  → 1 แชท = 1 ลิงก์ (บัญชีรายรับ-จ่ายเป็นของทั้งกลุ่ม)
--   • km_token     อยู่บน upl_tenants  → 1 ธุรกิจ = 1 ลิงก์ (คลังความรู้ใช้ร่วมกัน)
--   • meal token   ต้องเป็น **ราย (แชท × คน)** เพราะไดอารี่อาหารเก็บแยกด้วย line_user_id อยู่แล้ว
--     ถ้าทำเป็นระดับแชทเหมือน ledger คนหนึ่งในกลุ่มจะเปิดดู/แก้ไดอารี่อาหารของคนอื่นได้ทันที
--     ซึ่งเป็นข้อมูลสุขภาพส่วนบุคคล — ยอมไม่ได้ จึงต้องมีตารางแยก
create table if not exists upl_meal_tokens (
  token         text primary key,
  target_id     uuid not null references upl_targets(id) on delete cascade,
  -- null = แชท 1:1 ที่ไม่มี userId (เกิดได้ยาก แต่ต้องรองรับ) — ดู unique index ด้านล่าง
  line_user_id  text,
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz
);

-- 1 คน 1 แชท = 1 โทเคนเท่านั้น (idempotent เวลาผู้ใช้พิมพ์ขอลิงก์ซ้ำ)
-- ต้องใช้ 2 ดัชนีเพราะ NULL ใน unique index ปกติไม่ชนกันเอง — เคส 1:1 ที่ line_user_id เป็น null
-- จึงต้องมีดัชนีเฉพาะของมันแยกต่างหาก
create unique index if not exists upl_meal_tokens_target_user_uidx
  on upl_meal_tokens (target_id, line_user_id)
  where line_user_id is not null;

create unique index if not exists upl_meal_tokens_target_nouser_uidx
  on upl_meal_tokens (target_id)
  where line_user_id is null;

alter table upl_meal_tokens enable row level security;

comment on table upl_meal_tokens is
  'โทเคนหน้าเว็บจัดการอาหาร — ราย (target × line_user_id) เพราะไดอารี่อาหารเป็นข้อมูลส่วนบุคคล';
