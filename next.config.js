/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    // Keep the OCR stack OUT of the webpack bundle — load it via a plain Node require at runtime.
    // Without this, webpack follows slip-ocr.ts's `require.resolve('…/eng.traineddata.gz')` and tries
    // to PARSE the binary .gz as a module → "Module parse failed: Unexpected character" → build fails.
    // Marking them external (+ the tracing includes below shipping the files) is the working combo.
    serverComponentsExternalPackages: ["tesseract.js", "tesseract.js-core", "@tesseract.js-data/eng"],

    // Force these non-JS / dynamically-required assets into the verify-slip serverless function
    // so the OCR amount gate (lib/payments/slip-ocr.ts) needs ZERO runtime downloads on Vercel:
    //   • @tesseract.js-data/eng .......... the bundled eng.traineddata.gz we read with fs
    //   • tesseract.js-core ............... the wasm cores, loaded via require('tesseract.js-core/…')
    //   • tesseract.js worker-script ...... the worker_threads entry tesseract spawns in Node
    // @vercel/nft can't statically trace the dynamic core require string or the .gz data file,
    // so we include them explicitly. Globs are relative to the project root.
    outputFileTracingIncludes: {
      "/api/subscribe/verify-slip": [
        // Whole eng data package — the .gz (read via langPath) PLUS index.js/package.json so
        // `require.resolve("@tesseract.js-data/eng")` (in engLangDir) works in the traced function.
        "./node_modules/@tesseract.js-data/eng/**",
        // Ship ALL core variants + their .wasm. tesseract picks a core by CPU wasm-feature detection
        // at RUNTIME (e.g. tesseract-core-relaxedsimd.wasm) — a narrower glob left the actually-loaded
        // .wasm missing → "failed to prepare wasm: ENOENT …relaxedsimd.wasm" → an UNCAUGHT wasm abort
        // that crashed the function (exit 129). The full core dir (~43M) stays well under the 250M limit.
        "./node_modules/tesseract.js-core/**",
        // The worker_threads entry tesseract spawns in Node.
        "./node_modules/tesseract.js/src/worker-script/**",
      ],
    },
  },
};

module.exports = nextConfig;
