-- UP Line — เป้าหมายพลังงาน/สารอาหารต่อวัน
--
-- ขอบเขต: ราย **(แชท × คน)** เหมือน upl_meal_tokens และไดอารี่อาหาร (upl_meal_entries แยกด้วย
-- line_user_id) — ไม่ใช่ระดับ tenant หรือระดับแชท. เป้าหมายแคลอรี่เป็นเรื่องเฉพาะบุคคล
-- (เพศ น้ำหนัก กิจกรรม เป้าลด/เพิ่ม) ในกลุ่มเดียวกันแต่ละคนย่อมมีเป้าไม่เหมือนกัน.
--
-- เก็บเป็น "กรัม" ของแต่ละสารอาหาร ไม่เก็บเป็น % เพราะ:
--   • กรัมคือหน่วยที่เอาไปเทียบกับยอดที่กินจริงได้ตรง ๆ (ยอดที่กินก็เก็บเป็นกรัม)
--   • % แปลงกลับจากกรัมได้เสมอด้วยสูตร Atwater แต่แปลงจาก % เป็นกรัมต้องรู้ kcal เป้าก่อน
--   • ถ้าเก็บทั้งสองอย่างจะมีโอกาสไม่ตรงกัน (ตัวเลขความจริงต้องมีแหล่งเดียว)
-- kcal เป้าเก็บแยกไว้ด้วยเพราะผู้ใช้ตั้ง "1800 kcal" มาก่อน แล้วค่อยกระจายเป็นกรัม —
-- ปัดเศษกรัมแล้วคูณกลับอาจไม่ได้ 1800 พอดี จึงต้องจำเลขที่ผู้ใช้ตั้งไว้ตามจริง
create table if not exists upl_meal_goals (
  target_id    uuid not null references upl_targets(id) on delete cascade,
  line_user_id text not null default '',
  kcal         numeric(7,1) not null check (kcal > 0 and kcal <= 20000),
  carb_g       numeric(6,1) not null check (carb_g >= 0),
  protein_g    numeric(6,1) not null check (protein_g >= 0),
  fat_g        numeric(6,1) not null check (fat_g >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (target_id, line_user_id)
);

alter table upl_meal_goals enable row level security;

comment on table upl_meal_goals is
  'เป้าหมายพลังงาน/สารอาหารต่อวัน ราย (target × line_user_id) — เก็บเป็นกรัม, % คำนวณกลับด้วย Atwater';
comment on column upl_meal_goals.line_user_id is
  'ใช้สตริงว่างแทน NULL เพื่อให้เป็น primary key ได้ (NULL ใน PK ไม่ได้) — เคสแชท 1:1 ที่ไม่มี userId';
