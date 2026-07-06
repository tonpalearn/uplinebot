import { dirname, join } from "path";
import { createRequire } from "module";
import sharp from "sharp";

/**
 * Self-hosted OCR amount gate (Phase 1.5) — read the baht amount printed on a Thai transfer
 * slip so the money route can auto-activate ONLY when the paid amount >= the plan price.
 * No paid OCR API; runs on the default Vercel Node serverless runtime.
 *
 * Two hard constraints shape this file:
 *
 *  1) NO runtime downloads. tesseract.js will, by default, fetch the language traineddata AND
 *     its core wasm from a CDN — fatal on serverless (no reliable egress / no writable cache
 *     dir). We defeat every fetch path:
 *       • traineddata: we point `langPath` at the LOCAL directory of the bundled
 *         `@tesseract.js-data/eng` package (the one holding `eng.traineddata.gz`). In Node,
 *         tesseract's loader detects a non-URL path (via `is-url`) and reads the file straight
 *         off disk with `fs.readFile` — no network. (We resolve the dir with require.resolve so
 *         it works under the Next bundler; the dir is force-bundled — see next.config.js.)
 *       • core wasm: in Node, tesseract loads the core via `require('tesseract.js-core/...')`
 *         (a local require, not a fetch) and the worker via `worker_threads` pointing at the
 *         local `worker-script/node/index.js`. Nothing is fetched. We only must make sure those
 *         files are BUNDLED into the function — done via `experimental.outputFileTracingIncludes`
 *         in next.config.js (the dynamic require string + the .gz asset aren't auto-traced).
 *       • cacheMethod:'none' so it never tries to write `./eng.traineddata` to the read-only FS.
 *     We only need Latin digits (Thai slips render the amount in Arabic numerals), so `eng`
 *     alone is enough — we deliberately do NOT pull the large `tha` model.
 *
 *  2) Vercel Hobby caps a function at 10s. A cold start pays the one-time core+lang init, which
 *     can be slow. We race the WHOLE OCR against an ~8s timeout and resolve to `{ detected:null }`
 *     BEFORE the platform 504s, so a slow slip degrades to manual review instead of erroring. We
 *     also cache the worker at module scope so only the first (cold) request pays the init cost,
 *     and we try/catch everything — ocrSlipAmount never throws. (Measured locally: cold worker
 *     init ~200ms + recognize on a small grayscale slip ~60ms, so the 8s budget is generous.)
 */

// ── Tunables ───────────────────────────────────────────────────────────────────────────────
// Resize target: smaller grayscale input = dramatically faster OCR. Thai slip amounts stay
// legible well below the original resolution; we never UPSCALE (sharp `withoutEnlargement`).
const OCR_TARGET_WIDTH = 1100;
// Overall OCR budget. Vercel Hobby hard-kills at 10s; leave headroom for JSON + DB work around us.
const OCR_TIMEOUT_MS = 8000;

export interface OcrAmountResult {
  /** Best single amount read from the slip, or null when OCR found nothing usable / timed out. */
  detected: number | null;
  /** Every distinct amount parsed from the text (money-formatted first, then weak integers). */
  amounts: number[];
  /** Raw OCR text, truncated — for admin/debug only. */
  text: string;
}

// ── Pure amount parser (exported for unit tests — no tesseract needed) ───────────────────────

/** A baht amount printed with 2 decimals and optional thousands separators, e.g. 1,234.56 */
const MONEY_RE = /\d{1,3}(?:,\d{3})*\.\d{2}/g;
/** A bare integer (weak fallback) — at least 1 digit, optional thousands separators. */
const INT_RE = /\d{1,3}(?:,\d{3})*(?!\d)|\d+/g;

function toNumber(token: string): number {
  return parseFloat(token.replace(/,/g, ""));
}

/** De-dupe while preserving order. */
function uniq(nums: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const n of nums) {
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/**
 * Extract candidate amounts from raw OCR text.
 *
 * Returns:
 *  - `amounts`: money-formatted tokens (with a `.dd` decimal) first, then bare integers >= 1 as a
 *    weak fallback, all deduped.
 *  - `detected`: the amount we trust as THE slip total — the MAX money-formatted token when any
 *    exist (a real transfer slip always prints the amount with 2 decimals); only if there is NO
 *    decimal token at all do we fall back to the max integer >= 1.
 *
 * Pure & deterministic. This is the unit under test; the tesseract call just feeds it text.
 */
export function extractAmounts(text: string): { detected: number | null; amounts: number[] } {
  const src = typeof text === "string" ? text : "";

  const moneyTokens = src.match(MONEY_RE) ?? [];
  const money = uniq(moneyTokens.map(toNumber).filter((n) => Number.isFinite(n) && n > 0));

  // Integers are only a WEAK fallback. Blank out the money tokens first so neither the integer
  // part nor the fraction of e.g. "1,234.56" leaks back in as a bogus "1234" or "56".
  const withoutMoney = src.replace(MONEY_RE, " ");
  const intTokens = withoutMoney.match(INT_RE) ?? [];
  const ints = uniq(intTokens.map(toNumber).filter((n) => Number.isFinite(n) && n >= 1));

  const amounts = uniq([...money, ...ints]);

  let detected: number | null = null;
  if (money.length > 0) {
    detected = Math.max(...money);
  } else if (ints.length > 0) {
    detected = Math.max(...ints);
  }

  return { detected, amounts };
}

// ── tesseract worker (cached at module scope; created once per warm instance) ────────────────

// Loaded lazily so importing this module (e.g. in unrelated code paths / tests) is cheap and so
// a tesseract import failure can't crash the route on load.
type TesseractWorker = {
  setParameters: (p: Record<string, string | number>) => Promise<unknown>;
  recognize: (image: Buffer) => Promise<{ data: { text: string } }>;
  terminate: () => Promise<unknown>;
};

let workerPromise: Promise<TesseractWorker> | null = null;

/** Local directory holding the bundled `eng.traineddata.gz` — passed to tesseract as `langPath`. */
function engLangDir(): string {
  // Resolve the package via its JS main (`@tesseract.js-data/eng` → index.js), then join the data
  // subdir. We must NOT `require.resolve` the binary `.gz` directly: webpack statically analyzes
  // `require.resolve(<literal>)` and tries to PARSE the .gz as a module → `next build` fails with
  // "Module parse failed: Unexpected character". Resolving the JS main is safe; the .gz (under 4.0.0/)
  // is shipped into the function via outputFileTracingIncludes (next.config.js) and read off disk here.
  const req = createRequire(__filename);
  const pkgRoot = dirname(req.resolve("@tesseract.js-data/eng"));
  return join(pkgRoot, "4.0.0");
}

async function getWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      // Import lazily; tesseract.js is CJS, so grab the named export off default/interop.
      const tesseract = (await import("tesseract.js")) as unknown as {
        createWorker: (
          langs: unknown,
          oem?: number,
          options?: Record<string, unknown>
        ) => Promise<TesseractWorker>;
      };
      // oem=1 (LSTM_ONLY) → loads the smaller *-lstm core variants and needs only the LSTM data.
      const worker = await tesseract.createWorker("eng", 1, {
        langPath: engLangDir(), // LOCAL dir → tesseract reads eng.traineddata.gz off disk (no fetch)
        cacheMethod: "none", // never read/write a traineddata cache on the read-only serverless FS
        gzip: true, // the bundled data is gzipped
        legacyCore: false,
        legacyLang: false,
        logger: () => {},
        errorHandler: () => {},
      });
      // Latin digits + separators only, and SPARSE_TEXT (PSM 11) — the amount is a few isolated
      // numeric tokens on a busy slip, not prose.
      await worker.setParameters({
        tessedit_char_whitelist: "0123456789,.",
        tessedit_pageseg_mode: "11", // PSM.SPARSE_TEXT
        preserve_interword_spaces: "1",
      });
      return worker;
    })().catch((err) => {
      // Reset so a later (warm) request can retry init instead of being stuck on a failed promise.
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout()), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout());
      }
    );
  });
}

/**
 * OCR the slip and return the detected baht amount.
 *
 * Never throws. Always resolves within ~OCR_TIMEOUT_MS. On any failure (init error, decode error,
 * timeout) resolves to `{ detected:null, amounts:[], text:"" }` so the caller degrades to manual.
 */
export async function ocrSlipAmount(image: Buffer): Promise<OcrAmountResult> {
  const empty: OcrAmountResult = { detected: null, amounts: [], text: "" };

  const run = async (): Promise<OcrAmountResult> => {
    // Preprocess with sharp BEFORE OCR: downscale (never upscale), grayscale + normalize contrast.
    // A small high-contrast grayscale PNG is what makes cold-start OCR fast enough for Hobby.
    let pre: Buffer;
    try {
      pre = await sharp(image)
        .resize({ width: OCR_TARGET_WIDTH, withoutEnlargement: true })
        .grayscale()
        .normalize()
        .png()
        .toBuffer();
    } catch {
      pre = image; // if preprocessing fails, let tesseract try the original bytes
    }

    const worker = await getWorker();
    const { data } = await worker.recognize(pre);
    const text = typeof data?.text === "string" ? data.text : "";
    const { detected, amounts } = extractAmounts(text);
    // Keep stored/returned text short — it's only for admin/debug.
    return { detected, amounts, text: text.replace(/\s+/g, " ").trim().slice(0, 300) };
  };

  try {
    return await withTimeout(run(), OCR_TIMEOUT_MS, () => empty);
  } catch {
    return empty;
  }
}
