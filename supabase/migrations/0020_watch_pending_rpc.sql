-- 0020 — อ่านข้อความที่ยังไม่ได้สรุป ผ่านฟังก์ชันฝั่งฐานข้อมูล
--
-- ทำไมต้องมี: การอ่านผ่าน PostgREST ด้วย select หลายคอลัมน์พร้อมกัน คืน 0 แถวเงียบ ๆ
-- (ไม่ error) ทั้งที่นับด้วยเงื่อนไขเดียวกันได้ 7 แถว — ขอทีละคอลัมน์ได้ครบ แต่ขอพร้อมกันได้ศูนย์
-- ผลคือกลุ่มที่มีข้อความค้างอยู่จริงไม่เคยถูกสรุปเลย และไม่มี error ให้ไล่
--
-- ย้ายมาเป็นฟังก์ชัน SQL: รูปแบบผลลัพธ์ถูกกำหนดตายตัวที่นี่ ไม่ขึ้นกับการแปลง select
-- ของชั้น REST อีกต่อไป และได้ผลลัพธ์ในรอบเดียว

create or replace function upl_watch_pending(p_target uuid, p_limit int default 500)
returns table (id bigint, display_name text, text text, sent_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select m.id, m.display_name, m.text, m.sent_at
  from upl_group_messages m
  where m.target_id = p_target
    and m.summarized = false
  order by m.sent_at asc
  limit greatest(1, least(coalesce(p_limit, 500), 2000));
$$;

comment on function upl_watch_pending is
  'ข้อความที่ยังไม่ถูกสรุปของกลุ่มหนึ่ง เรียงตามเวลา — ใช้แทนการ select หลายคอลัมน์ผ่าน REST';
