-- UP Line — Meal Tracker "AI mode": จำไว้ว่าตัวเลขของแต่ละรายการ "มาจากไหน"
--
-- เมื่ออาหารไม่มีในฐาน ระบบจะให้ AI (Gemini) ประเมินค่าสารอาหารให้แล้วเก็บเข้าฐานของ tenant
-- ด้วย source='ai-estimate'. ปัญหาคือ upl_meal_entries เก็บ "ค่ามาโคร" แบบ snapshot ไว้แล้ว
-- แต่ไม่ได้เก็บ "ที่มา" — พอฐานอาหารถูกแก้/ลบทีหลัง (food_id เป็น SET NULL) เราจะไม่รู้อีกต่อไป
-- ว่าตัวเลขในประวัติมาจากคนสอนหรือ AI เดา.
--
-- เก็บที่มาลงในแถวไปพร้อมกับตัวเลข (snapshot เหมือนกัน) เพื่อให้การ์ดติดป้าย 🤖 ได้ถูกต้อง
-- ทั้งการ์ดมื้อและการ์ดสรุปทั้งวัน — ผู้ใช้ต้องแยกออกเสมอว่าเลขไหน "คนยืนยัน" เลขไหน "AI เดา".
alter table upl_meal_entries add column if not exists food_source text;

comment on column upl_meal_entries.food_source is
  'ที่มาของตัวเลขมาโคร ณ เวลาบันทึก: seed-approx (ฐานกลาง) | chat (คนสอน) | ai-estimate (AI ประเมิน) | admin';
