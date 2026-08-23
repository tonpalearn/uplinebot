import { generateJson, isGeminiEnabled } from "../../ai/gemini";

/**
 * สรุปบทสนทนาในกลุ่มด้วย AI — จุดที่กติกาความเป็นส่วนตัวมีผลจริง.
 *
 * สิ่งที่โมดูลนี้ส่งออกไปคือ "บทสนทนาของคนอื่น" ให้คนที่ไม่ได้อยู่ในวงนั้น จึงตั้งใจให้
 * ค่าเริ่มต้นเป็นการสรุป **ประเด็น** ไม่ใช่ **ใครพูดอะไร** (`includeNames=false`) —
 * ต่างกันมากในทางปฏิบัติ: อย่างแรกช่วยให้เจ้าของธุรกิจตามงานทัน อย่างหลังคือการสอดส่องรายคน
 *
 * ผลลัพธ์ตั้งใจให้ "ใช้ต่อได้ทันที" ไม่ใช่แค่ย่อความ — สิ่งที่คนอ่านสรุปกลุ่มอยากได้จริง ๆ คือ
 * มีอะไรต้องทำ · มีใครถามแล้วยังไม่มีคำตอบ · มีอะไรที่รอไม่ได้
 */

export interface WatchSummary {
  /** ประเด็นหลักที่คุยกัน 2–5 ข้อ */
  topics: string[];
  /** สิ่งที่ต้องทำต่อ (ถ้ามี) */
  actions: string[];
  /** คำถามที่ยังไม่มีใครตอบ — มีค่ามากในกลุ่มลูกค้า */
  openQuestions: string[];
  /** ตัวเลข/วันเวลา/ยอดเงินที่โผล่ในบทสนทนา */
  facts: string[];
  /** true = มีเรื่องที่ควรรีบดู */
  needsAttention: boolean;
  /** เหตุผลสั้น ๆ ว่าทำไมถึงควรรีบ (ว่างถ้าไม่มี) */
  attentionReason: string;
}

const SCHEMA: Record<string, unknown> = {
  type: "OBJECT",
  properties: {
    topics: { type: "ARRAY", items: { type: "STRING" } },
    actions: { type: "ARRAY", items: { type: "STRING" } },
    openQuestions: { type: "ARRAY", items: { type: "STRING" } },
    facts: { type: "ARRAY", items: { type: "STRING" } },
    needsAttention: { type: "BOOLEAN" },
    attentionReason: { type: "STRING" },
  },
  required: ["topics", "actions", "openQuestions", "facts", "needsAttention", "attentionReason"],
};

function systemPrompt(includeNames: boolean): string {
  return [
    "คุณคือผู้ช่วยที่อ่านบทสนทนาในกลุ่มแชทแล้วสรุปให้เจ้าของธุรกิจอ่านอย่างรวดเร็ว",
    "ตอบเป็น JSON ตาม schema เท่านั้น ใช้ภาษาไทยแบบคนทั่วไป สั้น กระชับ",
    "",
    "กติกาที่ห้ามฝ่าฝืน:",
    "- สรุปเฉพาะสิ่งที่ 'มีอยู่จริง' ในบทสนทนา ห้ามเดา ห้ามเติมความเห็นของตัวเอง",
    "- ถ้าบทสนทนาไม่มีสาระ (ทักทาย สติกเกอร์ คุยเล่น) ให้ topics เป็นลิสต์ว่าง อย่าปั้นประเด็นขึ้นมา",
    includeNames
      ? "- ระบุชื่อผู้พูดได้เมื่อจำเป็นต่อการเข้าใจว่าใครรับผิดชอบอะไร"
      : "- **ห้ามระบุชื่อบุคคล** สรุปเป็นประเด็นเท่านั้น (เช่น 'มีคนถามเรื่องราคา' ไม่ใช่ 'สมชายถามเรื่องราคา')",
    "- ห้ามคัดลอกข้อความส่วนตัว/ข้อมูลอ่อนไหว (เบอร์โทร เลขบัญชี ที่อยู่ อาการป่วย) ลงในสรุป",
    "",
    "actions = สิ่งที่ต้องมีคนไปทำต่อ · openQuestions = คำถามที่ยังไม่มีใครตอบในบทสนทนานี้",
    "facts = ตัวเลข วันเวลา ยอดเงิน หรือข้อตกลงที่ระบุชัด",
    "needsAttention = true เฉพาะเมื่อมีคนไม่พอใจ ร้องเรียน ทวงงาน หรือมีเรื่องที่รอไม่ได้",
  ].join("\n");
}

export interface ConversationLine {
  name: string | null;
  text: string;
}

/** จำนวนข้อความสูงสุดที่ส่งให้ AI ต่อรอบ — กันทั้งค่าใช้จ่ายและ prompt ยาวเกิน */
export const MAX_LINES_PER_SUMMARY = 400;

/**
 * สร้างสรุปจากบทสนทนา — คืน null เมื่อไม่มีคีย์ / เรียกไม่สำเร็จ / ผลลัพธ์ใช้ไม่ได้
 * ไม่ throw เด็ดขาด (อยู่บนเส้นทาง cron และเส้นทางตอบแชท)
 */
export async function summarizeConversation(
  lines: ConversationLine[],
  opts: { includeNames: boolean }
): Promise<WatchSummary | null> {
  if (lines.length === 0 || !isGeminiEnabled()) return null;

  const capped = lines.slice(-MAX_LINES_PER_SUMMARY);
  const transcript = capped
    .map((l) => (opts.includeNames && l.name ? `${l.name}: ${l.text}` : `- ${l.text}`))
    .join("\n")
    .slice(0, 24000); // กัน prompt ยาวผิดปกติจากข้อความสแปม

  const raw = await generateJson<WatchSummary>({
    system: systemPrompt(opts.includeNames),
    prompt: `บทสนทนาในกลุ่ม (${capped.length} ข้อความ):\n\n${transcript}\n\nสรุปตาม schema`,
    schema: SCHEMA,
    // ให้เวลามากกว่าปกติ: บทสนทนายาวกว่าชื่ออาหารมาก
    timeoutMs: 20000,
  });

  return validateSummary(raw);
}

/**
 * ตรวจผลจาก AI ก่อนใช้ — คืน null ถ้าใช้ไม่ได้.
 * export ไว้ให้เทสต์ยิงเคสพิสดารได้โดยไม่ต้องเรียก API จริง
 */
export function validateSummary(raw: unknown): WatchSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WatchSummary>;

  const list = (v: unknown, cap: number): string[] =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === "string")
          .map((x) => x.trim())
          .filter((x) => x.length > 0 && x.length <= 300)
          .slice(0, cap)
      : [];

  const topics = list(r.topics, 6);
  const actions = list(r.actions, 8);
  const openQuestions = list(r.openQuestions, 6);
  const facts = list(r.facts, 8);

  // ไม่มีอะไรเลยสักหมวด = สรุปที่ส่งไปก็ว่างเปล่า ไม่ต้องรบกวนเจ้าของ
  if (topics.length + actions.length + openQuestions.length + facts.length === 0) return null;

  return {
    topics,
    actions,
    openQuestions,
    facts,
    needsAttention: r.needsAttention === true,
    attentionReason:
      typeof r.attentionReason === "string" ? r.attentionReason.trim().slice(0, 200) : "",
  };
}

/**
 * สรุปสำรองเมื่อ AI ใช้ไม่ได้ — ไม่ปล่อยให้ผู้ใช้ได้ "ความเงียบ" โดยไม่รู้ว่าเกิดอะไรขึ้น
 * บอกจำนวนข้อความและช่วงเวลาไปก่อน ดีกว่าไม่ส่งอะไรเลย
 */
export function fallbackSummary(count: number): WatchSummary {
  return {
    topics: [`มีข้อความใหม่ ${count} ข้อความ (ระบบสรุปอัตโนมัติไม่พร้อมใช้งานตอนนี้)`],
    actions: [],
    openQuestions: [],
    facts: [],
    needsAttention: false,
    attentionReason: "",
  };
}
