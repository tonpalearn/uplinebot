-- meal_food_search: ให้ "คำเรียกอื่น" (aliases) ถูกนำมาเทียบแบบคล้าย ๆ ด้วย ไม่ใช่ต้องตรงเป๊ะ
--
-- ปัญหาที่เจอจริง (ผู้ใช้พิมพ์ในไลน์ 19 ส.ค. 69):
--   1) "All plant Protien" → **ไม่เจอเลย** เพราะคะแนนเดิมคิดจาก similarity(ชื่อ, คำค้น) อย่างเดียว
--      และชื่ออาหารเป็นภาษาไทย ("นิวทริไลท์ ออล แพลนท์ โปรตีน") — คำอังกฤษกับข้อความไทย
--      แทบไม่มี trigram ร่วมกันเลย คะแนนจึงเกือบ 0 ตกเกณฑ์ 0.34 เสมอ
--      ต่อให้ใส่ alias ภาษาอังกฤษไว้ ก็ยังพลาด เพราะ alias เดิม "ต้องตรงเป๊ะ" เท่านั้น
--      พิมพ์ผิดนิดเดียว (Protien/Protein) ก็หลุด
--   2) "Green tea Protien" → ไปโดนอาหารผิดตัวที่ alias ตรงเป๊ะพอดี (ของเก่าที่ AI เคยสร้าง)
--   3) แยก alias ด้วยคอมมาอย่างเดียว — ใครใส่เว้นวรรค/ขึ้นบรรทัดใหม่ กลายเป็น alias ก้อนเดียว
--
-- แก้: คะแนน = ค่าที่ "ดีที่สุด" ระหว่าง similarity ของชื่อ กับ similarity ของ alias แต่ละตัว
-- แยก alias ด้วย คอมมา / เซมิโคลอน / ขึ้นบรรทัดใหม่ (ยืดหยุ่นกับสิ่งที่คนพิมพ์จริง)
-- คงทางลัด "ตรงเป๊ะ" ไว้เหมือนเดิม (ชื่อ = 1.0, alias = 0.99) เพราะตรงเป๊ะต้องชนะเสมอ
--
-- ยืนยันหลังแก้: "All plant Protien" → ออล แพลนท์ โปรตีน 0.62 · "Green tea Protien" → กรีนที 0.67
-- "Chocolate Protien" → รสช็อกโกแลต 0.64 · ของเดิมไม่พัง (ข้าวสวย/ไข่ต้ม/ส้มตำ ยัง 0.99–1.00
-- และ "โต๊ะทำงาน"/"asdfgh"/"รถยนต์" ยังไม่เจอ = ไม่มี false positive เพิ่ม)
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
        -- ตรงเป๊ะกับชื่อ (ตัดช่องว่างออกก่อน เพื่อรับ "ข้าว สวย" = "ข้าวสวย")
        when replace(lower(btrim(f.name)), ' ', '') = replace((select needle from q), ' ', '') then 1.0::real
        -- ตรงเป๊ะกับ alias ตัวใดตัวหนึ่ง
        when exists (
          select 1 from regexp_split_to_table(coalesce(f.aliases, ''), '[,;\n]') a
          where btrim(a) <> ''
            and replace(lower(btrim(a)), ' ', '') = replace((select needle from q), ' ', '')
        ) then 0.99::real
        -- ไม่ตรงเป๊ะ → เอาคะแนนคล้ายที่ดีที่สุด ระหว่าง "ชื่อ" กับ "alias แต่ละตัว"
        -- (ส่วนนี้ทำให้พิมพ์อังกฤษ/พิมพ์ผิด แล้วยังเจออาหารที่ชื่อเป็นภาษาไทยได้)
        else greatest(
          similarity(lower(f.name), (select needle from q)),
          coalesce((
            select max(similarity(lower(btrim(a)), (select needle from q)))
            from regexp_split_to_table(coalesce(f.aliases, ''), '[,;\n]') a
            where btrim(a) <> ''
          ), 0::real)
        )
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
