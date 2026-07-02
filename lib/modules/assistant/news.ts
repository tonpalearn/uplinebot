import type { OutboundMessage } from "../types";

/**
 * STUB — News Digest (RSS + AI summary), per SPEC.md §6.3.
 *
 * Real implementation needs an RSS source list per tenant + an LLM call to summarize —
 * neither is wired up in this pass. This stub returns a clear Thai "not yet connected"
 * message so the interface is complete without pretending it works.
 */
export async function handleNewsIntent(): Promise<OutboundMessage[]> {
  return [
    {
      type: "text",
      text: "สรุปข่าวรายวันยังไม่ได้เชื่อมต่อ — ฟีเจอร์นี้อยู่นอกขอบเขตของรอบนี้",
    },
  ];
}
