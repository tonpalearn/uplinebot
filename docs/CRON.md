# ⏰ ตัวตั้งเวลา (Cron) — ทำไมต้องยิงจากข้างนอก

> **TL;DR (สรุปสั้น):** ปฏิทินตั้งเวลา (Cron) ของ Vercel บนแพ็กเกจ **Hobby** วิ่งได้ **วันละครั้งเท่านั้น**
> และเวลาคลาดได้ถึง ±59 นาที — จึงส่ง "การเตือนงานตามเวลา" (todo reminder) ไม่ทัน
> ทางแก้ที่ใช้อยู่: ให้ **GitHub Actions ยิงเข้ามาทุก 5 นาที** ที่ปลายทาง `/api/cron/dispatch`
> (ไฟล์ `.github/workflows/cron-dispatch.yml`) โดยแนบรหัสลับ `CRON_SECRET` แบบเดียวกับที่ Vercel ใช้

---

## 1) ปัญหา

ฟีเจอร์ Todo มี "การเตือนตามเวลา" — `app/api/cron/dispatch/route.ts` เรียก
`scanTodoReminders(now)` (ใน `lib/reminders.ts`) เพื่อยิงข้อความเตือนผ่าน LINE เมื่อถึงเวลา
`due_at` ของงานนั้น

แต่ตัวยิงต้องถูก "เรียก" ถี่พอ ไม่งั้นเตือนไม่ทันเวลา เช่น งานกำหนด 14:00 ถ้าตัวยิงทำงาน
แค่วันละครั้งตอนเที่ยงคืน การเตือนจะไปโผล่รอบถัดไป (คนละวัน)

## 2) ทำไม Vercel Cron อย่างเดียวไม่พอ (บน Hobby)

จากเอกสารทางการของ Vercel (Usage & Pricing for Cron Jobs):

| แพ็กเกจ | จำนวน Cron ต่อโปรเจกต์ | ความถี่ต่ำสุด | ความแม่นของเวลา |
| --- | --- | --- | --- |
| **Hobby** | 100 | **วันละครั้ง** | รายชั่วโมง (±59 นาที) |
| **Pro** | 100 | ทุก 1 นาที | รายนาที |

> ⚠️ คำเตือนจาก Vercel: *"Hobby accounts are limited to daily cron jobs. This cron expression
> would run more than once per day."* — แปลว่า **ถ้าตั้ง `*/5 * * * *` ใน `vercel.json` บน Hobby
> การ deploy จะ "ล้มเหลว" (build fail)** ไม่ใช่แค่ทำงานช้า

**สถานะบัญชีตอนนี้:** ทีม `upwellness` (slug `ultimatepassion`) = **Hobby** → จึง **ห้าม** ใส่
`*/5` ใน `vercel.json` เด็ดขาด (จะทำให้ขึ้นระบบไม่ได้)

ด้วยเหตุนี้ `vercel.json` จึง **คงไว้ที่วันละครั้ง** (`0 0 * * *` = 07:00 น. เวลาไทย) เป็น
"ตาข่ายกันพลาด" (backstop) ที่ยังถูกกติกา Hobby — ถ้าตัวยิงหลักล่ม อย่างน้อยวันละครั้ง
งานค้างทั้งหมดก็ยังถูกเก็บกวาด

## 3) ทางแก้ที่ใช้อยู่ — GitHub Actions ยิงทุก 5 นาที ✅

ไฟล์ `.github/workflows/cron-dispatch.yml` ตั้งเวลา `*/5 * * * *` ให้ GitHub ยิง
`curl` เข้าปลายทางเดิม `/api/cron/dispatch` พร้อมหัวข้อ (header)
`Authorization: Bearer <CRON_SECRET>` — เหมือนที่ Vercel เรียกเองทุกประการ

**ยิงถี่ทุก 5 นาทีปลอดภัย เพราะโค้ดกันซ้ำไว้แล้ว:**
- `dispatchDueJobs()` เลือกเฉพาะงานที่ `active` และ `next_run_at <= now` แล้วเลื่อน `next_run_at`
  ต่อไป → morning_brief / broadcast **ไม่ยิงซ้ำก่อนเวลา**
- `scanTodoReminders()` เลือกเฉพาะ todo ที่ `reminded_at` ยังว่าง แล้วประทับ `reminded_at`
  → **เตือนซ้ำไม่ได้**

### วิธีเปิดใช้ (ทำครั้งเดียว)

1. ไปที่ repo `tonpalearn/uplinebot` → **Settings → Secrets and variables → Actions → New repository secret**
   - ชื่อ: `CRON_SECRET`
   - ค่า: ต้องตรงกับ `CRON_SECRET` ที่ตั้งไว้ใน Vercel (ดูได้จาก Vercel → Project → Settings → Environment Variables) — ตอนนี้ prod ตั้งค่านี้ไว้แล้ว
2. (ถ้าโดเมนไม่ใช่ `uplinebot.vercel.app`) เพิ่ม **Variable** ชื่อ `DISPATCH_URL`
   = URL เต็มของปลายทาง เช่น `https://<โดเมนจริง>/api/cron/dispatch`
3. `git add .github/workflows/cron-dispatch.yml && git commit && git push origin main`
   — ตารางเวลาจะเริ่มทำงานหลังไฟล์อยู่บน branch `main` เท่านั้น

### วิธีทดสอบ

- **ในหน้า GitHub:** แท็บ **Actions → "Dispatch cron..." → Run workflow** (ปุ่ม manual) แล้วดูผล
  ต้องได้ `HTTP 200` และ body ประมาณ `{"ok":true,"jobs":...,"reminders":{"sent":...}}`
- **ยิงมือจากเครื่อง** (ใส่ค่า `CRON_SECRET` จริงแทน `xxxx`):
  ```bash
  curl -i -H "Authorization: Bearer xxxx" https://uplinebot.vercel.app/api/cron/dispatch
  ```
  - ได้ `200` = ผ่าน · ได้ `401` = `CRON_SECRET` ไม่ตรง · ได้ `404`/DNS error = URL ผิด

> **ข้อควรรู้ของ GitHub Actions (ตรงไปตรงมา):** 5 นาทีคือถี่สุดที่ GitHub ให้ · เวลาจริง
> **อาจดีเลย์** 5–15 นาทีตอนระบบ GitHub โหลดหนัก · และ **ถ้า repo เงียบไม่มี commit นาน 60 วัน
> GitHub จะปิดตารางเวลานี้อัตโนมัติ** — ถ้าเตือนงานเงียบไป ให้มาเช็กข้อนี้ก่อน หรือใช้บริการ
> cron เฉพาะทางในข้อ 4 ที่นิ่งกว่า

## 4) ทางเลือกที่นิ่งกว่า GitHub Actions (ถ้าต้องการความชัวร์)

ใช้บริการ cron ภายนอกที่ทำหน้าที่นี้โดยเฉพาะ ตั้งให้ยิง **ทุก 1–5 นาที** ไปที่
`https://uplinebot.vercel.app/api/cron/dispatch` พร้อม header
`Authorization: Bearer <CRON_SECRET>` (method GET):

- **cron-job.org** — ฟรี, ตั้งได้ทุก 1 นาที, นิ่ง (แนะนำสำหรับ production)
- **EasyCron** / **UptimeRobot** (โหมด HTTP monitor + custom header) — ทางเลือกอื่นที่ทำได้เหมือนกัน

ตั้งค่าในบริการพวกนี้:
- URL: `https://uplinebot.vercel.app/api/cron/dispatch`
- Method: `GET`
- Header: `Authorization: Bearer <CRON_SECRET ค่าจริง>`
- Interval: ทุก 5 นาที (หรือ 1 นาทีถ้าต้องการเตือนแม่นขึ้น)

> ถ้าเปิดตัวนี้แล้ว จะปิด GitHub Actions ก็ได้ (ทั้งคู่กันซ้ำอยู่แล้ว จะเปิดพร้อมกันก็ไม่พัง
> แค่เปลืองรอบยิงเปล่า ๆ)

## 5) เมื่ออัปเกรดเป็น Vercel Pro (วิธีที่สะอาดที่สุด)

พอย้ายทีมเป็น **Pro** แล้ว Vercel Cron ยิงได้ทุก 1 นาทีเอง — ไม่ต้องพึ่งตัวยิงข้างนอก:

1. แก้ `vercel.json` เปลี่ยน `schedule` เป็น `*/5 * * * *`:
   ```json
   {
     "$schema": "https://openapi.vercel.sh/vercel.json",
     "framework": "nextjs",
     "crons": [
       { "path": "/api/cron/dispatch", "schedule": "*/5 * * * *" }
     ]
   }
   ```
2. deploy ใหม่ (คราวนี้ผ่าน เพราะ Pro รองรับ sub-daily)
3. ปิด/ลบ `.github/workflows/cron-dispatch.yml` (และปิด cron ภายนอกถ้ามี) — ให้เหลือตัวยิงเดียว

---

_อ้างอิง: Vercel Docs — Usage & Pricing for Cron Jobs (อัปเดต 2026-06-16) ·
โค้ดที่เกี่ยวข้อง: `app/api/cron/dispatch/route.ts`, `lib/reminders.ts`, `lib/scheduler/dispatcher.ts`_
