// ───────────────────────────────────────────────────────────────────────────
// chunk.ts — แปลงเอกสารที่วางมาเป็นก้อน → รายการความรู้ {question, answer}[]
// PURE + DETERMINISTIC (ไม่มี DB / ไม่มี clock) — ทดสอบได้เต็ม.
//
// ฮิวริสติก (ตามลำดับ):
//   (a) ถ้ามีคู่ถาม-ตอบชัดเจน  Q:/A:  หรือ  ถาม:/ตอบ:  → จับเป็นคู่
//   (b) ไม่งั้น split ตามบรรทัดว่าง → แต่ละบล็อก: บรรทัดแรก = คำถาม (หัวข้อ), ที่เหลือ = คำตอบ
//       (ถ้าบล็อกมีบรรทัดเดียว → ใช้ทั้งบล็อกเป็นคำตอบ)
//   (c) จำกัดความยาวคำถาม/คำตอบ, ข้ามก้อนว่าง, จำกัดจำนวนก้อนไม่เกิน MAX_CHUNKS (ตัดส่วนเกินทิ้ง)
// อินพุตว่าง → []
// ───────────────────────────────────────────────────────────────────────────

export interface KmChunk {
  question: string;
  answer: string;
}

/** เพดานจำนวนความรู้ต่อเอกสารหนึ่งครั้ง — เกินกว่านี้ถูกตัดทิ้ง (กันวางเอกสารยักษ์). */
export const MAX_CHUNKS = 200;
/** เพดานความยาวหัวข้อ/คำถาม (ตัวอักษร). */
export const MAX_QUESTION_LEN = 300;
/** เพดานความยาวคำตอบ (ตัวอักษร). */
export const MAX_ANSWER_LEN = 2000;

/** มาร์กเกอร์บรรทัดคำถาม/คำตอบ (รับทั้งอังกฤษ Q/A และไทย ถาม/ตอบ, ไม่สนตัวพิมพ์). */
const Q_MARKER = /^\s*(?:Q|ถาม)\s*:\s*(.*)$/i;
const A_MARKER = /^\s*(?:A|ตอบ)\s*:\s*(.*)$/i;

/** ตัดความยาว + trim ให้ไม่เกิน max. */
function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? t.slice(0, max).trim() : t;
}

/** สร้างก้อนที่ถูกต้อง (question+answer ไม่ว่าง) แล้ว push — คืน true ถ้าเพิ่ม. */
function pushChunk(out: KmChunk[], question: string, answer: string): void {
  const q = clip(question, MAX_QUESTION_LEN);
  const a = clip(answer, MAX_ANSWER_LEN);
  if (q && a) out.push({ question: q, answer: a });
}

/** (a) โหมดคู่ถาม-ตอบ: เดินทีละบรรทัด สะสมคำถามจนเจอ "ตอบ:" แล้วสะสมคำตอบจนเจอ "ถาม:" ถัดไป. */
function chunkQaPairs(lines: string[]): KmChunk[] {
  const out: KmChunk[] = [];
  let curQ: string[] = [];
  let curA: string[] = [];
  let mode: "idle" | "q" | "a" = "idle";

  const flush = () => {
    if (curQ.length && curA.length) {
      pushChunk(out, curQ.join(" "), curA.join("\n"));
    }
    curQ = [];
    curA = [];
  };

  for (const line of lines) {
    const qm = line.match(Q_MARKER);
    const am = line.match(A_MARKER);
    if (qm) {
      flush(); // ปิดคู่ก่อนหน้า (ถ้าครบ) ก่อนเริ่มคำถามใหม่
      curQ = qm[1] ? [qm[1]] : [];
      curA = [];
      mode = "q";
    } else if (am) {
      curA = am[1] ? [am[1]] : [];
      mode = "a";
    } else if (mode === "q") {
      curQ.push(line);
    } else if (mode === "a") {
      curA.push(line);
    }
    // mode === "idle" (ข้อความก่อนคำถามแรก) → ข้าม
    if (out.length >= MAX_CHUNKS) return out.slice(0, MAX_CHUNKS);
  }
  flush();
  return out.slice(0, MAX_CHUNKS);
}

/** (b) โหมดบล็อก: split ตามบรรทัดว่าง → บรรทัดแรก = คำถาม, ที่เหลือ (หรือทั้งบล็อก) = คำตอบ. */
function chunkBlocks(text: string): KmChunk[] {
  const blocks = text
    .split(/\n\s*\n+/) // บรรทัดว่างอย่างน้อยหนึ่ง (รวมที่มีช่องว่าง)
    .map((b) => b.trim())
    .filter(Boolean);

  const out: KmChunk[] = [];
  for (const block of blocks) {
    const blockLines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    if (blockLines.length === 0) continue;
    const question = blockLines[0];
    const rest = blockLines.slice(1).join("\n").trim();
    // มีเนื้อหาต่อจากหัวข้อ → ใช้เป็นคำตอบ; บล็อกบรรทัดเดียว → ใช้ทั้งบล็อกเป็นคำตอบ
    const answer = rest || block;
    pushChunk(out, question, answer);
    if (out.length >= MAX_CHUNKS) break;
  }
  return out.slice(0, MAX_CHUNKS);
}

/** มีคู่ถาม-ตอบชัดเจนไหม (ต้องมีทั้งบรรทัดคำถาม และบรรทัดคำตอบ อย่างน้อยอย่างละหนึ่ง). */
function hasQaMarkers(lines: string[]): boolean {
  const hasQ = lines.some((l) => Q_MARKER.test(l));
  const hasA = lines.some((l) => A_MARKER.test(l));
  return hasQ && hasA;
}

/**
 * แปลงเอกสาร → รายการความรู้. คืน [] ถ้าอินพุตว่าง/มีแต่ช่องว่าง.
 */
export function chunkDocument(text: string): KmChunk[] {
  const raw = (text ?? "").replace(/\r\n?/g, "\n"); // normalize newlines
  if (!raw.trim()) return [];

  const lines = raw.split("\n");
  if (hasQaMarkers(lines)) {
    const pairs = chunkQaPairs(lines);
    if (pairs.length > 0) return pairs;
    // มีมาร์กเกอร์แต่จับคู่ไม่ได้เลย → fall back เป็นโหมดบล็อก
  }
  return chunkBlocks(raw);
}
