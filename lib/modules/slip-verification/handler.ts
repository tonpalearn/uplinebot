import { createHash } from "node:crypto";
import type { ModuleHandler, LineEvent, ModuleConfig, TenantContext, OutboundMessage } from "../types";
import { assertModuleEntitled, EntitlementError } from "../../entitlement";
import { getServiceClient } from "../../db";
import { decrypt } from "../../crypto";
import { getMessageContent } from "../../line/client";
import { getBotAccessToken } from "../../line/token";
import { decodeSlip } from "../../payments/slip-decode";
import type { SlipProvider, SlipVerifyResult } from "./providers/types";
import { MockSlipProvider } from "./providers/mock";
import { SlipOkProvider } from "./providers/slipok";
import { EasySlipProvider } from "./providers/easyslip";

/**
 * Slip Verification & Payment OCR (module_key: slip_verification)
 *
 * Full flow per SYSTEM-DESIGN.md §4.3 — see handleEvent() for the numbered steps.
 *
 * ⚠️ ด่านแรกคือ "รูปนี้เป็นสลิปไหม" ไม่ใช่ "สลิปนี้ผ่านไหม" — สองอย่างนี้ต่างกัน และเคยรวมกันจนพัง:
 * matchesIntent() รับรูป **ทุกรูป** (ต้องเป็นฟังก์ชัน sync แตะ I/O ไม่ได้ตามสัญญา ModuleHandler)
 * เดิม handleEvent จึงส่งรูปแมว/รูปสินค้า/สกรีนช็อตในกลุ่มเข้า provider แล้วได้ isValid=false
 * → ตอบ "❌ ไม่สามารถยืนยันสลิปนี้ได้" ใส่ทุกคนที่โพสต์รูปอะไรก็ตาม + เขียนแถว failed ลงฐานทุกใบ
 * ตอนนี้กรองด้วย QR ของสลิปธนาคารก่อน (ดู isPaymentSlip) — ไม่ใช่สลิป = **เงียบสนิท**
 */

const PROVIDER_TIMEOUT_MS = 3000;

const PENDING_MESSAGE: OutboundMessage = {
  type: "text",
  text: "กำลังตรวจสอบสลิป กรุณารอสักครู่ ระบบจะแจ้งผลอีกครั้งเร็วๆ นี้",
};

export const SlipVerificationModule: ModuleHandler = {
  key: "slip_verification",

  matchesIntent(event: LineEvent, _config: ModuleConfig): boolean {
    return event.message?.type === "image";
  },

  async handleEvent(event: LineEvent, ctx: TenantContext): Promise<OutboundMessage[]> {
    // Defensive second guard — the router already filters by entitlement before
    // calling handleEvent(), but money is on the line here, so re-check explicitly.
    try {
      await assertModuleEntitled(ctx.tenantId, "slip_verification");
    } catch (err) {
      if (err instanceof EntitlementError) {
        return [];
      }
      throw err;
    }

    if (!event.message || event.message.type !== "image") {
      return [];
    }

    const supabase = getServiceClient();

    // 2. Fetch image content (respects LINE_MOCK inside getMessageContent()).
    const accessToken = await getBotAccessToken(ctx.botId);
    const imageBuffer = await getMessageContent(accessToken, event.message.id);

    // 2b. ด่าน "นี่เป็นสลิปหรือเปล่า" — ทำก่อนทุกอย่าง และก่อนเขียนอะไรลงฐาน
    //     สลิปโอนเงินของธนาคารไทยมี QR สำหรับตรวจสอบติดมาด้วยเสมอ ส่วนรูปทั่วไปไม่มี
    //     จึงใช้ตัวถอด QR (self-host เดียวกับ /api/subscribe/verify-slip · เร็ว ~0.1–0.3 วิ)
    //     เป็นตัวแยก. ไม่เจอ QR = ไม่ใช่สลิป → เงียบ ไม่ตอบ ไม่บันทึก
    if (!(await isPaymentSlip(imageBuffer))) {
      return [];
    }

    // 3. Select provider by SLIP_PROVIDER, call verify() with a 3s timeout.
    const provider = await resolveProvider(ctx.tenantId);
    const result = await verifyWithTimeout(provider, imageBuffer);

    if (result.timedOut) {
      return [PENDING_MESSAGE];
    }

    const { bank, amount, ref, txnTime, isValid } = result;

    // Compute dedupe hash — per §4.3 step 4.
    const slipRefHash = createHash("sha256")
      .update(`${bank}${ref}${amount}${txnTime}`)
      .digest("hex");

    const providerName = resolveProviderName();
    const status = isValid ? "verified" : "failed";

    const { error: insertError } = await supabase
      .from("upl_slip_verifications")
      .insert({
        tenant_id: ctx.tenantId,
        target_id: ctx.targetId,
        slip_ref_hash: slipRefHash,
        amount,
        bank_code: bank,
        txn_time: txnTime,
        status,
        provider: providerName,
        provider_response: result as unknown as Record<string, unknown>,
      })
      .select("id")
      .single();

    if (insertError) {
      // Postgres unique-violation on (tenant_id, slip_ref_hash) IS the dedupe
      // mechanism (race-safe, no separate check-then-insert per §4.3 step 4).
      if (insertError.code === "23505") {
        return [
          {
            type: "text",
            text: "⚠️ ตรวจพบสลิปนี้ถูกใช้ยืนยันไปแล้ว กรุณาตรวจสอบอีกครั้ง หรือติดต่อผู้ดูแลหากคิดว่าเป็นความผิดพลาด",
          },
        ];
      }
      throw new Error(`Failed to insert slip verification: ${insertError.message}`);
    }

    if (!isValid) {
      return [
        {
          type: "text",
          text: "❌ ไม่สามารถยืนยันสลิปนี้ได้ กรุณาตรวจสอบความถูกต้องของสลิป หรือติดต่อผู้ดูแล",
        },
      ];
    }

    // 4. Success — verified, not duplicate.
    return [
      {
        type: "text",
        text: `✅ ยืนยันสลิปสำเร็จ\nจำนวนเงิน: ${amount.toLocaleString("th-TH")} บาท\nธนาคาร: ${bank}`,
      },
    ];
  },
};

/**
 * รูปนี้เป็น "สลิปโอนเงิน" หรือเปล่า — ใช้ตัดสินว่าจะพูดหรือจะเงียบ (ไม่ใช่ตัดสินว่าสลิปผ่านไหม)
 *
 * เกณฑ์: ถอด QR ในรูปได้ไหม. สลิปของธนาคารไทย/พร้อมเพย์แนบ QR สำหรับตรวจสอบมาด้วยเสมอ
 * ส่วนรูปถ่ายทั่วไป/สกรีนช็อต/สติกเกอร์ ไม่มี — เป็นตัวแยกที่ทั้งเร็วและไม่ต้องพึ่ง API เสียเงิน
 *
 * **ล้มแล้วให้เงียบ**: ถอดไม่สำเร็จ (ไฟล์เสีย · sharp พัง · หมดเวลา) ให้ถือว่า "ไม่ใช่สลิป"
 * เพราะผลเสียของการทักผิดคนในกลุ่ม แรงกว่าการพลาดสลิปหนึ่งใบที่ผู้ใช้ส่งซ้ำได้เอง
 *
 * ข้อแลกที่ยอมรับ: สลิปที่ถูกครอปจน QR หายไปจะถูกมองว่าไม่ใช่สลิปด้วย — รับได้
 * เพราะทางเลือกเดิมคือตะโกน ❌ ใส่รูปทุกใบในกลุ่ม
 */
async function isPaymentSlip(imageBuffer: Buffer): Promise<boolean> {
  try {
    const { foundQr } = await decodeSlip(imageBuffer);
    return foundQr;
  } catch (err) {
    console.warn(`[slip] decode failed, treating as non-slip: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

interface VerifyOutcome extends SlipVerifyResult {
  timedOut?: boolean;
}

async function verifyWithTimeout(provider: SlipProvider, imageBuffer: Buffer): Promise<VerifyOutcome> {
  const timeout = new Promise<VerifyOutcome>((resolve) => {
    setTimeout(() => {
      resolve({
        bank: "",
        amount: 0,
        ref: "",
        txnTime: new Date().toISOString(),
        isValid: false,
        timedOut: true,
      });
    }, PROVIDER_TIMEOUT_MS);
  });

  return Promise.race([provider.verify(imageBuffer), timeout]);
}

function resolveProviderName(): string {
  const raw = process.env.SLIP_PROVIDER;
  return raw === "slipok" || raw === "easyslip" ? raw : "mock";
}

async function resolveProvider(tenantId: string): Promise<SlipProvider> {
  const providerName = resolveProviderName();

  if (providerName === "mock") {
    return new MockSlipProvider();
  }

  const apiKey = await getProviderApiKey(tenantId, providerName);

  if (providerName === "slipok") {
    return new SlipOkProvider(apiKey);
  }

  return new EasySlipProvider(apiKey);
}

async function getProviderApiKey(tenantId: string, provider: string): Promise<string> {
  const supabase = getServiceClient();
  const { data, error } = await supabase
    .from("upl_provider_credentials")
    .select("credential_enc")
    .eq("tenant_id", tenantId)
    .eq("module_key", "slip_verification")
    .eq("provider", provider)
    .single();

  if (error || !data) {
    throw new Error(`No connected "${provider}" credential found for tenant ${tenantId}`);
  }

  // credential_enc is a base64 text column (migration 0002) — pass the string straight in.
  return decrypt(data.credential_enc);
}

