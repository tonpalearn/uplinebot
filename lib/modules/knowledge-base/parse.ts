// ───────────────────────────────────────────────────────────────────────────
// parse.ts — แยกข้อความ → intent ของโมดูลคลังความรู้ (Knowledge Base / FAQ).
// PURE + DETERMINISTIC: ไม่มี DB, ไม่เรียก new Date() — คืน intent จากข้อความล้วน ๆ.
//
// รูปแบบที่รองรับ (ตรวจตามลำดับ link → teach → ask):
//   • teach : "สอน <คำถาม> = <คำตอบ>"  (รับ ":" เป็นตัวคั่นได้ด้วย) → บันทึกความรู้
//   • link  : "คลังความรู้" | "จัดการความรู้" | "km" (ทั้งข้อความ) → ขอลิงก์หน้าจัดการ
//   • ask   : "ถาม <คำถาม>" (ถาม แล้วเว้นวรรค) → ค้นคำตอบจากคลัง
//   • อื่น ๆ → null (โมดูลนี้ไม่แมตช์ เว้นแต่ config.answer_all = true ที่ handler จัดการเอง)
// ───────────────────────────────────────────────────────────────────────────

export type KmIntent =
  | { action: "teach"; question: string; answer: string }
  | { action: "link" }
  | { action: "ask"; question: string }
  | null;

/** คำสั่ง (ทั้งข้อความ) ที่ขอ "ลิงก์หน้าจัดการคลังความรู้" — ตรงเป๊ะ (trim, "km" ไม่สนตัวพิมพ์). */
const LINK_WORDS_TH = new Set(["คลังความรู้", "จัดการความรู้"]);

/**
 * ตัวคั่น teach: คั่นที่ตำแหน่ง "=" หรือ ":" ที่ "มาก่อน" (ตัวแรกสุด) เพื่อให้คำตอบมี : ได้
 * (เช่น URL หรือ "9:00-18:00"). คืน index ของตัวคั่น หรือ -1 ถ้าไม่มี.
 */
function firstSeparatorIndex(s: string): number {
  const eq = s.indexOf("=");
  const colon = s.indexOf(":");
  if (eq === -1) return colon;
  if (colon === -1) return eq;
  return Math.min(eq, colon);
}

/**
 * แปลงข้อความ → KmIntent.
 * - ตรวจ "link" ก่อน (ทั้งข้อความตรงกับคำสั่งจัดการ)
 * - แล้ว "teach": ขึ้นต้น "สอน" + เว้นวรรค (boundary กัน "สอนพิเศษ...") แล้วต้องมีตัวคั่น = หรือ :
 *   ทั้งคำถามและคำตอบ trim แล้วต้องไม่ว่าง
 * - แล้ว "ask": ขึ้นต้น "ถาม" + เว้นวรรค แล้วมีคำถามตามหลัง (ไม่ว่าง)
 * - ไม่เข้าเงื่อนไขใด → null
 */
export function parseKmIntent(text: string): KmIntent {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return null;

  // 1) ลิงก์หน้าจัดการ — ทั้งข้อความตรงกับคำสั่ง (Thai ตรงเป๊ะ, "km" ไม่สนตัวพิมพ์)
  if (LINK_WORDS_TH.has(trimmed) || trimmed.toLowerCase() === "km") {
    return { action: "link" };
  }

  // 2) สอนความรู้ — "สอน <คำถาม> = <คำตอบ>" (หรือ ":") ; boundary \s กัน "สอนพิเศษ"
  const teachMatch = trimmed.match(/^สอน\s+([\s\S]+)$/);
  if (teachMatch) {
    const rest = teachMatch[1];
    const sepAt = firstSeparatorIndex(rest);
    if (sepAt > -1) {
      const question = rest.slice(0, sepAt).trim();
      const answer = rest.slice(sepAt + 1).trim();
      if (question && answer) {
        return { action: "teach", question, answer };
      }
    }
    // ขึ้นต้น "สอน" แต่ไม่มีตัวคั่น/มีฝั่งว่าง → ไม่ถือเป็นคำสั่งโมดูลนี้
    return null;
  }

  // 3) ถามคำถาม — "ถาม <คำถาม>" ; ต้องมีเว้นวรรคแล้วคำถามไม่ว่าง (boundary กัน "ถามตอบ")
  const askMatch = trimmed.match(/^ถาม\s+([\s\S]+)$/);
  if (askMatch) {
    const question = askMatch[1].trim();
    if (question) return { action: "ask", question };
    return null;
  }

  return null;
}
