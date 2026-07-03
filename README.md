# UP Line Bot

แพลตฟอร์ม LINE Bot อเนกประสงค์ (multi-tenant, modular SaaS) — เลือกซื้อแยกเป็นโมดูลได้ (à la carte)

**Stack:** Next.js 14 (App Router) · React · Tailwind · Vercel · Supabase — สถาปัตยกรรมแบบ BFF (Backend-for-Frontend)

## โครงสร้าง

```
app/            BFF route handlers (webhook, admin, cron) + Admin dashboard UI
lib/            core: db, crypto, entitlement, context, LINE client
  modules/      module plug-in handlers (registry + assistant / broadcast / slip-verification)
  scheduler/    cron job dispatcher
supabase/       migrations — full DDL + RLS + module_catalog seed (13 modules)
tests/          vitest suites (33 tests, mocked — zero network calls)
```

## เริ่มพัฒนา

```bash
npm install
cp .env.example .env      # ใส่ค่าจริง: LINE channel, Supabase, SlipOK/EasySlip
npm test                  # รัน vitest (mock ทั้งหมด ไม่ต้องต่อของจริง)
npm run dev
```

## สถานะ

- ✅ **P0–P2** — Core Engine · Admin Dashboard · Assistant · Broadcast · **Slip Verification** — 33/33 tests ผ่าน, `tsc` clean
- ⏳ ต่อของจริงก่อน production: LINE OA · Supabase project (รัน `supabase/migrations/0001_init.sql`) · SlipOK/EasySlip API key
- 🔜 P3–P5: Commerce, Booking, FAQ RAG, CRM, Community, Internal Ops, Receipt/KYC, Multi-Branch

🔥 **Slip Verification** = โมดูล priority สูงสุด (validated: 4/5 persona ลูกค้าจริงเลือกเป็นอันดับ 1) — build ก่อนโมดูล Pro อื่น

---
Spec + system design เต็ม: เก็บแยกนอก repo นี้ (SPEC.md / SYSTEM-DESIGN.md)

⏰ **ตัวตั้งเวลา / การเตือนตามเวลา (Cron) — ใช้ pg_cron เป็นหลัก:** Vercel Hobby ยิง cron ได้แค่วันละครั้ง
จึงใช้ **pg_cron ใน Supabase** (job `upline-cron-dispatch`, ทุก 1 นาที) → `net.http_get` ยิง `/api/cron/dispatch`
พร้อม `Authorization: Bearer $CRON_SECRET` เชื่อถือได้ ±1 นาที · การส่ง reminder ทำแบบ **parallel** (25/รอบ, สูงสุด
300 งาน/รอบ) รองรับหลายลูกค้าตั้งเวลาพร้อมกัน · ทางเลือก/อัปเกรด Pro ดู [`docs/CRON.md`](docs/CRON.md)
> GitHub Actions cron เดิม = fallback (ไม่เสถียร throttle เป็น ชม.) แนะนำปิดใน Actions UI
