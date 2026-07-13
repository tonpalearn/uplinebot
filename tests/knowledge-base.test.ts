import { describe, it, expect } from "vitest";
import { parseKmIntent } from "@/lib/modules/knowledge-base/parse";
import { chunkDocument, MAX_CHUNKS } from "@/lib/modules/knowledge-base/chunk";

/**
 * Unit tests for the Knowledge Base module's PURE + DETERMINISTIC pieces:
 *   - parse.ts   — text → KmIntent (teach / link / ask / null)
 *   - chunk.ts   — pasted document → {question, answer}[]
 * No DB, no clock. handler.ts (DB-backed) is covered in knowledge-base-handler.test.ts.
 */

// ── parseKmIntent — teach ("สอน Q = A") ─────────────────────────────────────────────────────
describe("parseKmIntent — teach", () => {
  it("'สอน <คำถาม> = <คำตอบ>' → teach with both trimmed", () => {
    const intent = parseKmIntent("สอน คืนสินค้าได้ไหม = ได้ครับ ภายใน 7 วัน");
    expect(intent).toEqual({
      action: "teach",
      question: "คืนสินค้าได้ไหม",
      answer: "ได้ครับ ภายใน 7 วัน",
    });
  });

  it("accepts ':' as the separator too", () => {
    const intent = parseKmIntent("สอน เปิดกี่โมง : 9 โมงเช้า");
    expect(intent).toEqual({ action: "teach", question: "เปิดกี่โมง", answer: "9 โมงเช้า" });
  });

  it("splits on the FIRST separator so a URL/time in the answer keeps its ':'", () => {
    const intent = parseKmIntent("สอน เว็บไซต์ = https://example.com");
    expect(intent).toEqual({ action: "teach", question: "เว็บไซต์", answer: "https://example.com" });
  });

  it("':' before any '=' → colon wins (answer may contain '=')", () => {
    const intent = parseKmIntent("สอน สูตร: a = b");
    expect(intent).toEqual({ action: "teach", question: "สูตร", answer: "a = b" });
  });

  it("empty answer → null", () => {
    expect(parseKmIntent("สอน คำถามลอย = ")).toBeNull();
  });

  it("empty question → null", () => {
    expect(parseKmIntent("สอน = คำตอบลอย")).toBeNull();
  });

  it("no separator at all → null", () => {
    expect(parseKmIntent("สอน อะไรก็ไม่รู้")).toBeNull();
  });

  it("'สอน' alone → null", () => {
    expect(parseKmIntent("สอน")).toBeNull();
  });

  it("boundary: 'สอนพิเศษ = 500' (no space after สอน) → null, not a teach", () => {
    expect(parseKmIntent("สอนพิเศษ = 500")).toBeNull();
  });
});

// ── parseKmIntent — link (manage page) ──────────────────────────────────────────────────────
describe("parseKmIntent — link", () => {
  it("'คลังความรู้' → link", () => {
    expect(parseKmIntent("คลังความรู้")).toEqual({ action: "link" });
  });
  it("'จัดการความรู้' → link", () => {
    expect(parseKmIntent("จัดการความรู้")).toEqual({ action: "link" });
  });
  it("'km' → link (case-insensitive)", () => {
    expect(parseKmIntent("km")).toEqual({ action: "link" });
    expect(parseKmIntent("KM")).toEqual({ action: "link" });
  });
  it("tolerates surrounding whitespace", () => {
    expect(parseKmIntent("  คลังความรู้  ")).toEqual({ action: "link" });
  });
  it("'คลังความรู้เพิ่ม' (not exact) → not a link", () => {
    expect(parseKmIntent("คลังความรู้เพิ่ม")).toBeNull();
  });
});

// ── parseKmIntent — ask ("ถาม ...") ─────────────────────────────────────────────────────────
describe("parseKmIntent — ask", () => {
  it("'ถาม <คำถาม>' → ask with the rest trimmed", () => {
    expect(parseKmIntent("ถาม เปิดกี่โมง")).toEqual({ action: "ask", question: "เปิดกี่โมง" });
  });
  it("multi-word question after ถาม", () => {
    expect(parseKmIntent("ถาม ส่งของกี่วันถึง")).toEqual({ action: "ask", question: "ส่งของกี่วันถึง" });
  });
  it("'ถาม' alone → null (needs a question)", () => {
    expect(parseKmIntent("ถาม")).toBeNull();
  });
  it("boundary: 'ถามตอบ' (no space) → null", () => {
    expect(parseKmIntent("ถามตอบ")).toBeNull();
  });
});

// ── parseKmIntent — non-matches ─────────────────────────────────────────────────────────────
describe("parseKmIntent — non-matches → null", () => {
  it("ordinary chat → null", () => {
    expect(parseKmIntent("สวัสดีครับ")).toBeNull();
  });
  it("empty / whitespace → null", () => {
    expect(parseKmIntent("")).toBeNull();
    expect(parseKmIntent("   ")).toBeNull();
  });
});

// ── chunkDocument ───────────────────────────────────────────────────────────────────────────
describe("chunkDocument — Q/A pairs", () => {
  it("pairs Q:/A: lines", () => {
    const doc = "Q: เปิดกี่โมง\nA: 9:00-18:00\n\nQ: ส่งกี่วัน\nA: 2-3 วัน";
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({ question: "เปิดกี่โมง", answer: "9:00-18:00" });
    expect(chunks[1]).toEqual({ question: "ส่งกี่วัน", answer: "2-3 วัน" });
  });

  it("pairs Thai ถาม:/ตอบ: lines", () => {
    const doc = "ถาม: คืนของได้ไหม\nตอบ: ได้ภายใน 7 วัน";
    expect(chunkDocument(doc)).toEqual([{ question: "คืนของได้ไหม", answer: "ได้ภายใน 7 วัน" }]);
  });

  it("multi-line answer accumulates until the next Q", () => {
    const doc = "Q: วิธีสมัคร\nA: ขั้นที่ 1 กรอกฟอร์ม\nขั้นที่ 2 ยืนยันอีเมล\n\nQ: ราคา\nA: ฟรี";
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].question).toBe("วิธีสมัคร");
    expect(chunks[0].answer).toContain("ขั้นที่ 1");
    expect(chunks[0].answer).toContain("ขั้นที่ 2");
  });
});

describe("chunkDocument — blank-line blocks", () => {
  it("uses the first line as question and the rest as answer", () => {
    const doc =
      "นโยบายการคืนสินค้า\nคืนได้ภายใน 7 วัน นับจากวันที่ได้รับ\n\nการจัดส่ง\nส่งฟรีเมื่อซื้อครบ 500 บาท";
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      question: "นโยบายการคืนสินค้า",
      answer: "คืนได้ภายใน 7 วัน นับจากวันที่ได้รับ",
    });
    expect(chunks[1].question).toBe("การจัดส่ง");
  });

  it("single-line block → whole block is the answer too", () => {
    expect(chunkDocument("แค่บรรทัดเดียว")).toEqual([
      { question: "แค่บรรทัดเดียว", answer: "แค่บรรทัดเดียว" },
    ]);
  });

  it("skips empty blocks / stray blank lines", () => {
    const chunks = chunkDocument("หัวข้อ A\nเนื้อหา A\n\n\n\nหัวข้อ B\nเนื้อหา B");
    expect(chunks).toHaveLength(2);
  });
});

describe("chunkDocument — edge cases", () => {
  it("empty input → []", () => {
    expect(chunkDocument("")).toEqual([]);
    expect(chunkDocument("   \n  \n ")).toEqual([]);
  });

  it("caps the number of chunks at MAX_CHUNKS", () => {
    const doc = Array.from({ length: MAX_CHUNKS + 50 }, (_, i) => `หัวข้อ ${i}`).join("\n\n");
    const chunks = chunkDocument(doc);
    expect(chunks).toHaveLength(MAX_CHUNKS);
  });
});
