import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase client factory.
 *
 * getServiceClient() returns a service-role client for BFF use only
 * (webhook handlers, cron dispatcher, admin API routes). It bypasses RLS
 * by design — the trusted server is already gated by application-level
 * auth + entitlement checks (see lib/entitlement.ts).
 *
 * Never expose the service-role key to the client/browser.
 */

let cachedClient: SupabaseClient | null = null;

export function getServiceClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceRoleKey) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to create the service client."
    );
  }

  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
    global: {
      // **ต้องปิดแคชของ fetch ให้ชัด** — supabase-js เรียกผ่าน fetch และ Next.js บน Vercel
      // แคชผลของ fetch ให้เองโดยปริยาย ผลคือ query เดิม (URL เดิม) คืนคำตอบเก่าค้างอยู่
      //
      // อาการที่เกิดจริงก่อนแก้: ข้อความในกลุ่มถูกทำเครื่องหมายว่า "สรุปแล้ว" ในฐานข้อมูลจริง
      // แต่รอบถัดไปยังอ่านเจอชุดเดิมทุกนาที → สรุปซ้ำ ส่งซ้ำเข้าแชทผู้ใช้ไม่หยุด
      // และ select ที่คอลัมน์ต่างกัน (URL ต่างกัน = แคชคนละก้อน) ให้คำตอบไม่ตรงกันเอง
      //
      // กระทบทุกโมดูลที่อ่านข้อมูลที่เปลี่ยนบ่อย ไม่ใช่เฉพาะผู้ช่วยเฝ้ากลุ่ม —
      // แก้ที่จุดเดียวนี้เพื่อให้ทั้งระบบอ่านของสดเสมอ
      fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
    },
  });

  return cachedClient;
}
