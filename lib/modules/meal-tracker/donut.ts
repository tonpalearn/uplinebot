// ───────────────────────────────────────────────────────────────────────────
// donut.ts — วาดกราฟโดนัทสัดส่วนสารอาหารเป็น PNG (2D โค้งมน คมชัด)
//
// ทำไมไม่ใช้ SVG หรือไลบรารีกราฟ:
//   • LINE ส่งรูปได้เฉพาะ PNG/JPEG ผ่าน URL — ต้อง rasterize ฝั่งเซิร์ฟเวอร์อยู่ดี
//   • การให้ sharp อ่าน SVG ต้องพึ่ง librsvg + "ฟอนต์ในเครื่อง" ซึ่งบน Vercel Lambda ไม่มีฟอนต์ไทย
//     → ข้อความจะกลายเป็นสี่เหลี่ยม. เราจึงวาดด้วย "พิกเซลดิบ" ล้วน ๆ (ไม่มีตัวอักษรในรูปเลย)
//     แล้วให้ตัวหนังสือทั้งหมดอยู่บนการ์ด Flex ซึ่งเรนเดอร์ด้วยฟอนต์ของเครื่องผู้ใช้ = คมชัดเสมอ
//   • ผลพลอยได้: ไม่มี dependency เพิ่ม, deterministic, เทสต์ได้, เร็ว (~10ms)
//
// เทคนิค: signed distance field ต่อพิกเซล — ระยะห่างจาก "วงแหวนที่ถูกตัดเป็นเสี้ยว + ปลายมน"
// แล้วแปลงระยะเป็น alpha (ขอบเบลอ 1 พิกเซล) จึงได้ขอบเรียบแบบ anti-aliased จริง ไม่ใช่ขั้นบันได.
// ───────────────────────────────────────────────────────────────────────────

import sharp from "sharp";
import { MACRO } from "../flex-ui";

export interface DonutSegment {
  /** ค่าที่ใช้แบ่งสัดส่วน (พลังงาน kcal ของสารอาหารนั้น) — ติดลบ/NaN จะถูกตัดทิ้ง */
  value: number;
  /** สี hex "#RRGGBB" */
  color: string;
}

export interface DonutOptions {
  /** ความกว้าง=ความสูง (พิกเซล) */
  size?: number;
  /** ความหนาวงแหวนเป็นสัดส่วนของ size */
  thickness?: number;
  /** ความกว้างของ "ช่องว่างสีขาว" ที่เห็นจริงระหว่างเสี้ยว เป็นสัดส่วนของความหนา */
  gap?: number;
}

const TWO_PI = Math.PI * 2;

/** "#RRGGBB" → [r,g,b] (ไม่รองรับ shorthand เพราะ palette เราคุมเองทั้งหมด) */
function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** มุมเชิงบวกในช่วง [0, 2π) */
function norm(a: number): number {
  const m = a % TWO_PI;
  return m < 0 ? m + TWO_PI : m;
}

/** อยู่ในช่วงมุม [a0, a1] ไหม (รองรับกรณีคร่อม 0) */
function inArc(theta: number, a0: number, a1: number): boolean {
  const span = norm(a1 - a0);
  const rel = norm(theta - a0);
  return rel <= span;
}

/**
 * เรนเดอร์โดนัทเป็น PNG (พื้นหลังโปร่งใส).
 *
 * เสี้ยวเรียงตามเข็มนาฬิกาเริ่มจากด้านบน (12 นาฬิกา) — อ่านง่ายที่สุดสำหรับคนทั่วไป.
 * ถ้าผลรวม = 0 จะได้วงแหวนสีเทาจาง ๆ วงเดียว (สถานะ "ยังไม่มีข้อมูล") แทนที่จะเป็นรูปเปล่า.
 */
export async function renderDonutPng(segments: DonutSegment[], opts: DonutOptions = {}): Promise<Buffer> {
  const size = Math.max(64, Math.min(1024, Math.round(opts.size ?? 420)));
  const thicknessRatio = opts.thickness ?? 0.17;
  const gapRatio = opts.gap ?? 0.22;

  const cx = size / 2;
  const cy = size / 2;
  const thickness = size * thicknessRatio;
  const half = thickness / 2;
  const radius = size * 0.42 - half; // รัศมีกึ่งกลางวงแหวน

  const usable = segments.filter((s) => Number.isFinite(s.value) && s.value > 0);
  const total = usable.reduce((a, s) => a + s.value, 0);

  // มุมที่ต้อง "ร่นเข้า" ต่อปลายหนึ่งข้าง — สำคัญต่อความถูกต้องของสัดส่วน:
  // เสี้ยวถูกวาดเป็น "แถบโค้ง a0→a1 + วงกลมปลายรัศมี half" ปลายมนจึงยื่นกลับออกไปอีก half
  // ดังนั้นถ้าร่นเข้า (half + ช่องว่าง/2) พอดี ขอบสีที่ตาเห็นจะไปจบที่ "เส้นแบ่งสัดส่วนจริง ลบครึ่ง
  // ช่องว่าง" เป๊ะ ๆ → เสี้ยวยังกินพื้นที่ตามสัดส่วนจริง แถมได้ช่องว่างสวย ๆ ตรงกลางรอยต่อ.
  // (เวอร์ชันแรกร่นน้อยกว่า half ทำให้ปลายมนของสองเสี้ยวเกยกันจนกลายเป็นรอยต่อแบนสนิท)
  const gapPx = thickness * gapRatio;
  const inset = total > 0 && usable.length > 1 ? (thickness + gapPx) / 2 / radius : 0;

  // สร้างรายการเสี้ยวพร้อมมุมเริ่ม-จบ (เริ่มที่ 12 นาฬิกา = -π/2 แล้วเดินตามเข็ม)
  interface Arc {
    a0: number;
    a1: number;
    cap: number; // รัศมีปลายมนของเสี้ยวนี้
    rgb: [number, number, number];
    full: boolean;
  }
  const arcs: Arc[] = [];
  let cursor = -Math.PI / 2;
  for (const s of usable) {
    const sweep = (s.value / total) * TWO_PI;
    const full = usable.length === 1;
    let a0 = full ? cursor : cursor + inset;
    let a1 = full ? cursor + TWO_PI : cursor + sweep - inset;
    let cap = half;

    // เสี้ยวที่บางกว่าปลายมน → ยุบเป็น "จุดกลม" ที่กึ่งกลางเสี้ยวจริง (ยังเห็นว่ามีอยู่ ไม่หายเงียบ)
    // และย่อขนาดจุดตามสัดส่วนจริงด้วย — จุดขนาดเต็มความหนาจะทำให้ 0.7% ดูเหมือน 5% ซึ่งโกหกสายตา
    // (ยังคงมีขนาดขั้นต่ำ 30% ไว้ให้มองเห็น เพราะ "มีนิดหน่อย" ต่างจาก "ไม่มีเลย")
    if (!full && a1 < a0) {
      const mid = cursor + sweep / 2;
      a0 = mid;
      a1 = mid;
      cap = Math.max(half * 0.3, Math.min(half, (sweep * radius) / 2));
    }

    arcs.push({ a0, a1, cap, rgb: hexToRgb(s.color), full });
    cursor += sweep;
  }

  const trackRgb = hexToRgb(MACRO.track);
  const data = Buffer.alloc(size * size * 4); // RGBA

  for (let y = 0; y < size; y++) {
    const dy = y + 0.5 - cy;
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - cx;
      const r = Math.sqrt(dx * dx + dy * dy);

      // ตัดพิกเซลที่อยู่ไกลวงแหวนออกก่อน (เร็วขึ้นมาก — เกินครึ่งภาพไม่ต้องคิดต่อ)
      const bandDist = Math.abs(r - radius) - half;
      if (bandDist > 1.5) continue;

      const theta = norm(Math.atan2(dy, dx));

      // หาเสี้ยวที่ "ใกล้ที่สุด" ของพิกเซลนี้ (เสี้ยวไม่ทับกัน จึงเลือกตัวที่ระยะน้อยสุดได้เลย)
      let bestSd = Infinity;
      let bestRgb: [number, number, number] | null = null;

      for (const arc of arcs) {
        let sd: number;
        if (arc.full) {
          sd = bandDist;
        } else {
          sd = inArc(theta, arc.a0, arc.a1) ? bandDist : Infinity;
          // ปลายมน: วงกลมรัศมี arc.cap ที่หัวและท้ายเสี้ยว
          for (const a of [arc.a0, arc.a1]) {
            const ex = cx + radius * Math.cos(a);
            const ey = cy + radius * Math.sin(a);
            const ed = Math.hypot(x + 0.5 - ex, y + 0.5 - ey) - arc.cap;
            if (ed < sd) sd = ed;
          }
        }
        if (sd < bestSd) {
          bestSd = sd;
          bestRgb = arc.rgb;
        }
      }

      // alpha จากระยะ: ข้างใน (sd ≤ -0.5) ทึบ, ข้างนอก (sd ≥ 0.5) ใส, ระหว่างนั้นไล่เฉด
      const segAlpha = bestRgb ? Math.max(0, Math.min(1, 0.5 - bestSd)) : 0;
      const trackAlpha = Math.max(0, Math.min(1, 0.5 - bandDist)) * 0.55;

      // ประกอบ: เสี้ยวสีทับรางเทาจาง (รางโผล่ตรงช่องว่างระหว่างเสี้ยว = ดูตั้งใจ ไม่ใช่รูโหว่)
      const outA = segAlpha + trackAlpha * (1 - segAlpha);
      if (outA <= 0.002) continue;

      const sr = bestRgb ? bestRgb[0] : 0;
      const sg = bestRgb ? bestRgb[1] : 0;
      const sb = bestRgb ? bestRgb[2] : 0;
      const wSeg = segAlpha;
      const wTrack = trackAlpha * (1 - segAlpha);

      const i = (y * size + x) * 4;
      data[i] = Math.round((sr * wSeg + trackRgb[0] * wTrack) / outA);
      data[i + 1] = Math.round((sg * wSeg + trackRgb[1] * wTrack) / outA);
      data[i + 2] = Math.round((sb * wSeg + trackRgb[2] * wTrack) / outA);
      data[i + 3] = Math.round(outA * 255);
    }
  }

  return sharp(data, { raw: { width: size, height: size, channels: 4 } })
    .png({ compressionLevel: 9, palette: true })
    .toBuffer();
}
