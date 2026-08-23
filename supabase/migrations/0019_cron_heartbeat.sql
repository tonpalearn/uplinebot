-- 0019 — ชีพจรของ cron (heartbeat)
--
-- ทำไมต้องมี: ตารางเวลาของผู้ช่วยเฝ้ากลุ่ม (และ reminder ทั้งระบบ) ขึ้นกับ pg_cron ที่ยิง
-- /api/cron/dispatch ทุก 1 นาที. ถ้า pg_cron หยุด/ถูกลบ/ URL เปลี่ยน — ทุกอย่างจะ "เงียบ"
-- โดยไม่มี error ให้เห็นเลย แล้วเราจะไปนั่งไล่หาบั๊กผิดที่ (นึกว่าโค้ดสรุปพัง ทั้งที่ cron ไม่เดิน)
--
-- ตารางนี้มีแถวเดียวตลอดกาล (id=1) บันทึกว่า dispatch ถูกเรียกล่าสุดเมื่อไหร่
-- /api/health อ่านค่านี้ไปตอบว่า "cron เดินอยู่ไหม" ได้ใน 5 วินาที ไม่ต้องเดา

create table if not exists upl_cron_heartbeat (
  id            smallint primary key default 1 check (id = 1),
  last_tick_at  timestamptz not null default now(),
  tick_count    bigint      not null default 0,
  last_result   jsonb
);

insert into upl_cron_heartbeat (id, last_tick_at, tick_count)
values (1, now(), 0)
on conflict (id) do nothing;

comment on table upl_cron_heartbeat is
  'แถวเดียว: เวลาที่ /api/cron/dispatch ถูกเรียกล่าสุด — ใช้ตอบว่า pg_cron ยังเดินอยู่ไหม';

-- ฟังก์ชันบันทึกชีพจร — atomic (นับต่อได้โดยไม่ต้องอ่านก่อนเขียน จึงไม่มี race)
create or replace function upl_cron_tick(p_result jsonb default null)
returns void
language sql
security definer
set search_path = public
as $$
  insert into upl_cron_heartbeat (id, last_tick_at, tick_count, last_result)
  values (1, now(), 1, p_result)
  on conflict (id) do update
    set last_tick_at = now(),
        tick_count   = upl_cron_heartbeat.tick_count + 1,
        last_result  = excluded.last_result;
$$;
