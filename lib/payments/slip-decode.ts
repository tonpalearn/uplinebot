import { createHash } from "crypto";
import sharp from "sharp";
import jsQR from "jsqr";

/**
 * Self-hosted payment-slip QR decoder (Phase 1) — no paid slip API.
 *
 * A Thai bank-transfer slip embeds a "slip verify" QR whose RAW payload string is unique
 * per transaction. We decode that string ourselves and use it (plus a sha256 of the image
 * bytes) as anti-replay keys, so no third-party verification service is required.
 *
 * Pipeline (Node serverless / Vercel — NOT browser canvas):
 *   image bytes → sharp decodes to raw RGBA pixels → jsQR reads the QR → raw string.
 * sharp ships prebuilt platform binaries and is Vercel-supported; jsQR is pure JS and takes
 * a Uint8ClampedArray of RGBA + width + height. Both run on the default Node runtime.
 *
 * Everything here is pure and deterministic (no network), so it is unit-testable in isolation.
 */

export interface SlipDecode {
  /** true when jsQR found and decoded a QR in the image. */
  foundQr: boolean;
  /** The raw decoded QR text — the PRIMARY anti-replay/dedupe key. null when no QR. */
  rawQr: string | null;
  /** Human transaction reference parsed from the EMVCo TLV, when present. Best-effort. */
  transRef: string | null;
  /** Sending bank code/name parsed from the TLV, when present. Best-effort. */
  sendingBank: string | null;
  /** sha256 (hex) of the ORIGINAL image bytes — a second anti-replay/dedupe key. */
  imageHash: string;
}

/** sha256 hex of arbitrary bytes. Deterministic; used as the image dedupe key. */
export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Decode a payment slip image: find its QR, hash the bytes, best-effort parse the TLV.
 *
 * Never throws on a bad/rotated/QR-less image — it degrades to { foundQr:false } while still
 * returning a valid imageHash, so the caller can fall back to manual review.
 */
export async function decodeSlip(image: Buffer): Promise<SlipDecode> {
  const imageHash = sha256Hex(image);

  let rawQr: string | null = null;
  try {
    // ensureAlpha() → guarantee 4 channels (RGBA) so the buffer length == w*h*4, which is
    // exactly what jsQR expects. raw() gives us the pixel bytes with no PNG/JPEG container.
    const { data, info } = await sharp(image)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const rgba = new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength);
    const result = jsQR(rgba, info.width, info.height);
    if (result && typeof result.data === "string" && result.data.length > 0) {
      rawQr = result.data;
    }
  } catch {
    // Unsupported/corrupt image, or sharp/jsQR failure → treat as "no QR found" (manual path).
    rawQr = null;
  }

  const parsed = rawQr ? parseSlipQr(rawQr) : { transRef: null, sendingBank: null };

  return {
    foundQr: rawQr !== null,
    rawQr,
    transRef: parsed.transRef,
    sendingBank: parsed.sendingBank,
    imageHash,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────────
// EMVCo TLV parsing (best-effort). Thai slip-verify QRs follow the EMVCo tag-length-value
// grammar: each field is a 2-char tag, a 2-char (decimal) length, then `length` chars of
// value. Some tags are TEMPLATES whose value is itself a TLV sequence. Fields vary by bank,
// so we walk the whole tree and pick the most plausible transaction reference / bank when
// present — and return nulls (never throw) when the payload isn't parseable as we expect.
// ─────────────────────────────────────────────────────────────────────────────────────────

interface TlvNode {
  tag: string;
  value: string;
  /** Parsed children when this node's value is itself a valid TLV sequence. */
  children: TlvNode[];
}

interface ParsedSlipQr {
  transRef: string | null;
  sendingBank: string | null;
}

/** Public for tests: parse a raw slip-QR string into a best-effort { transRef, sendingBank }. */
export function parseSlipQr(raw: string): ParsedSlipQr {
  let nodes: TlvNode[];
  try {
    nodes = parseTlv(raw);
  } catch {
    return { transRef: null, sendingBank: null };
  }
  if (nodes.length === 0) return { transRef: null, sendingBank: null };

  const flat = flatten(nodes);

  return {
    transRef: pickTransRef(flat),
    sendingBank: pickSendingBank(flat),
  };
}

/**
 * Parse one level of EMVCo TLV. Recurses one level into any value that itself looks like a
 * well-formed TLV sequence (so we can reach nested reference fields) — but a leaf that merely
 * *happens* to be even-length is kept as a leaf when its bytes don't re-parse cleanly.
 */
function parseTlv(s: string, depth = 0): TlvNode[] {
  const out: TlvNode[] = [];
  let i = 0;

  // Hard bounds so a malformed payload can never loop or recurse without end.
  if (depth > 6) return out;

  while (i + 4 <= s.length) {
    const tag = s.slice(i, i + 2);
    // Tags are digits in EMVCo; if we hit non-numeric where a tag should be, stop (not our grammar).
    if (!/^\d{2}$/.test(tag)) break;

    const lenStr = s.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) break;
    const len = parseInt(lenStr, 10);

    const start = i + 4;
    const end = start + len;
    if (end > s.length) break; // declared length overruns the buffer → stop, keep what we have.

    const value = s.slice(start, end);
    const node: TlvNode = { tag, value, children: [] };

    // Try to descend: only when the value is long enough AND fully re-parses as TLV covering
    // its whole length (guards against treating an ordinary numeric string as a template).
    if (value.length >= 4) {
      const kids = tryParseFull(value, depth + 1);
      if (kids) node.children = kids;
    }

    out.push(node);
    i = end;
  }

  return out;
}

/** Parse `value` as TLV only if the parse consumes the ENTIRE string; else null (it's a leaf). */
function tryParseFull(value: string, depth: number): TlvNode[] | null {
  let i = 0;
  const nodes: TlvNode[] = [];
  if (depth > 6) return null;

  while (i + 4 <= value.length) {
    const tag = value.slice(i, i + 2);
    if (!/^\d{2}$/.test(tag)) return null;
    const lenStr = value.slice(i + 2, i + 4);
    if (!/^\d{2}$/.test(lenStr)) return null;
    const len = parseInt(lenStr, 10);
    const start = i + 4;
    const end = start + len;
    if (end > value.length) return null;
    const inner = value.slice(start, end);
    const child: TlvNode = { tag, value: inner, children: [] };
    if (inner.length >= 4) {
      const kids = tryParseFull(inner, depth + 1);
      if (kids) child.children = kids;
    }
    nodes.push(child);
    i = end;
  }

  // Must have consumed everything and found at least one field to count as a template.
  if (i !== value.length || nodes.length === 0) return null;
  return nodes;
}

/** Depth-first flatten with a dotted path for each node (e.g. "62.05"). */
function flatten(nodes: TlvNode[], prefix = ""): { path: string; tag: string; value: string; isLeaf: boolean }[] {
  const out: { path: string; tag: string; value: string; isLeaf: boolean }[] = [];
  for (const n of nodes) {
    const path = prefix ? `${prefix}.${n.tag}` : n.tag;
    if (n.children.length > 0) {
      out.push(...flatten(n.children, path));
    } else {
      out.push({ path, tag: n.tag, value: n.value, isLeaf: true });
    }
  }
  return out;
}

type FlatField = { path: string; tag: string; value: string; isLeaf: boolean };

/**
 * Pick the transaction reference. In EMVCo, tag 62 is "Additional Data Field" and its
 * sub-tag 05 is the Reference Label / Bill Number — the field Thai apps surface as the
 * transaction ref. We prefer 62.05, then 62.01 (Bill Number) / 62.07 (Terminal), then any
 * leaf under a 62 template, and finally any long alphanumeric leaf that looks like a ref.
 * Returns null when nothing plausible is present (fields genuinely vary by bank).
 */
function pickTransRef(flat: FlatField[]): string | null {
  const byPath = (p: string) => flat.find((f) => f.path === p && f.value.trim().length > 0)?.value.trim() ?? null;

  const preferred = byPath("62.05") ?? byPath("62.01") ?? byPath("62.07");
  if (preferred) return preferred;

  // Any other leaf inside a 62 additional-data template.
  const under62 = flat.find((f) => f.path.startsWith("62.") && f.value.trim().length >= 6);
  if (under62) return under62.value.trim();

  // Last resort: a long-ish alphanumeric leaf (typical ref length) that isn't obviously the
  // payload-format/point-of-init/currency/country boilerplate at the top level.
  const boilerplate = new Set(["00", "01", "52", "53", "58", "59", "60", "63"]);
  const candidate = flat.find(
    (f) => f.isLeaf && f.value.trim().length >= 10 && /^[A-Za-z0-9]+$/.test(f.value.trim()) && !boilerplate.has(f.tag)
  );
  return candidate ? candidate.value.trim() : null;
}

/**
 * Pick the sending bank. Not standardized across Thai banks in the slip QR, so this is
 * strictly best-effort: look for a merchant/acquirer account template (tags 26–51) and, if
 * present, surface its sub-tag 00 (globally-unique identifier / bank AID) as the bank hint.
 * Returns null when nothing suitable is present.
 */
function pickSendingBank(flat: FlatField[]): string | null {
  // A bank/PromptPay account template's sub-tag 00 carries the bank identifier.
  for (let tagNum = 26; tagNum <= 51; tagNum++) {
    const tag = String(tagNum).padStart(2, "0");
    const sub00 = flat.find((f) => f.path === `${tag}.00` && f.value.trim().length > 0);
    if (sub00) return sub00.value.trim();
  }
  return null;
}
