-- 0021 — กันรอบสรุปของกลุ่มเดียวกันทับกัน
--
-- อาการจริง: cron ยิงทุก 1 นาที แต่รอบหนึ่งใช้เวลานานกว่านั้นได้ (AI สรุป + push หลายกลุ่ม)
-- รอบที่ 2 จึงเริ่มก่อนที่รอบแรกจะทำเครื่องหมาย "สรุปแล้ว" เสร็จ → อ่านเจอข้อความชุดเดิม
-- → สรุปซ้ำ ส่งซ้ำ (เกิดจริงแล้ว 20:07 และ 20:08 เนื้อหาเดียวกันเป๊ะ)
--
-- แก้ด้วยการจองสิทธิ์รันเป็นรายกลุ่มแบบ atomic ใน UPDATE เดียว — ใครจองได้คนนั้นรัน
-- ที่ต้องมี stale timeout เพราะถ้า process ตายกลางทาง ธงจะค้างและกลุ่มนั้นจะไม่ถูกสรุปอีกเลย

alter table upl_watch_configs
  add column if not exists summarizing_at timestamptz;

comment on column upl_watch_configs.summarizing_at is
  'ธงว่ากำลังมีรอบสรุปของกลุ่มนี้ทำงานอยู่ — กันรอบ cron ที่ทับกันสรุปซ้ำ';

create or replace function upl_watch_try_begin(p_target uuid, p_stale_seconds int default 300)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok boolean;
begin
  update upl_watch_configs
     set summarizing_at = now()
   where target_id = p_target
     and (summarizing_at is null
          or summarizing_at < now() - make_interval(secs => greatest(60, p_stale_seconds)))
  returning true into v_ok;

  return coalesce(v_ok, false);
end;
$$;

create or replace function upl_watch_end(p_target uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update upl_watch_configs set summarizing_at = null where target_id = p_target;
$$;
