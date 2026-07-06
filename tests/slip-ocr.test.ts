import { describe, it, expect } from "vitest";
import { extractAmounts } from "../lib/payments/slip-ocr";

/**
 * Pure amount-parser tests for the OCR gate. We test extractAmounts (the regex/selection logic)
 * directly on OCR-text strings — no tesseract is run here. The selection rule under test:
 *   • prefer money-formatted tokens (\d+.\d{2}), and pick the MAX of them as `detected`
 *   • fall back to the max bare integer ONLY when there is no decimal token at all
 *   • return null when nothing usable is present
 */

describe("extractAmounts — money-formatted amounts", () => {
  it("reads '990.00' out of a Thai amount line", () => {
    const { detected, amounts } = extractAmounts("ยอด 990.00 บาท");
    expect(detected).toBe(990);
    expect(amounts).toContain(990);
  });

  it("parses a comma-thousands amount '1,234.56'", () => {
    const { detected } = extractAmounts("จำนวนเงิน 1,234.56");
    expect(detected).toBe(1234.56);
  });

  it("handles large comma-grouped amounts '12,990.00'", () => {
    const { detected } = extractAmounts("Amount 12,990.00 THB");
    expect(detected).toBe(12990);
  });

  it("picks the MONEY-formatted amount over stray integers on the slip", () => {
    // A real slip is full of integers (dates, ref numbers, times). The .00 amount must win, even
    // though bigger bare integers (like a 12-digit ref) are present.
    const text = "12/07/2569 10:45 Ref 015208112233 ยอด 990.00 บาท เลขที่ 66123456789012";
    const { detected } = extractAmounts(text);
    expect(detected).toBe(990);
  });

  it("returns the MAX of multiple money tokens", () => {
    const { detected, amounts } = extractAmounts("fee 20.00 total 2,990.00");
    expect(detected).toBe(2990);
    expect(amounts).toEqual(expect.arrayContaining([20, 2990]));
  });

  it("does not surface the integer part of a money token as a separate bogus integer", () => {
    // "1,234.56" must not also yield "1234" in amounts.
    const { amounts } = extractAmounts("1,234.56");
    expect(amounts).toEqual([1234.56]);
  });
});

describe("extractAmounts — fallbacks and empties", () => {
  it("returns null when there is no amount at all", () => {
    const { detected, amounts } = extractAmounts("โอนเงินสำเร็จ");
    expect(detected).toBeNull();
    expect(amounts).toEqual([]);
  });

  it("returns null for empty / non-string input", () => {
    expect(extractAmounts("").detected).toBeNull();
    // @ts-expect-error — guard against undefined at the boundary
    expect(extractAmounts(undefined).detected).toBeNull();
  });

  it("falls back to the max bare integer only when NO decimal token exists", () => {
    const { detected } = extractAmounts("ยอด 990 บาท (rounded 1000)");
    expect(detected).toBe(1000);
  });

  it("ignores zero and treats only >= 1 integers as weak candidates", () => {
    const { detected, amounts } = extractAmounts("0 0 500");
    expect(detected).toBe(500);
    expect(amounts).toContain(500);
    expect(amounts).not.toContain(0);
  });
});
