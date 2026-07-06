/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  experimental: {
    // Force these non-JS / dynamically-required assets into the verify-slip serverless function
    // so the OCR amount gate (lib/payments/slip-ocr.ts) needs ZERO runtime downloads on Vercel:
    //   • @tesseract.js-data/eng .......... the bundled eng.traineddata.gz we read with fs
    //   • tesseract.js-core ............... the wasm cores, loaded via require('tesseract.js-core/…')
    //   • tesseract.js worker-script ...... the worker_threads entry tesseract spawns in Node
    // @vercel/nft can't statically trace the dynamic core require string or the .gz data file,
    // so we include them explicitly. Globs are relative to the project root.
    outputFileTracingIncludes: {
      "/api/subscribe/verify-slip": [
        // eng LSTM traineddata (.gz) — read off disk via langPath.
        "./node_modules/@tesseract.js-data/eng/4.0.0/**",
        // Only the LSTM core variants are ever loaded at oem=1 (getCore picks relaxedsimd / simd /
        // plain -lstm by CPU wasm-feature detection), so we ship just those (~20M) — not the full
        // 43M of core (the non-LSTM variants would only load at oem=0, which we never use).
        "./node_modules/tesseract.js-core/*-lstm.*",
        "./node_modules/tesseract.js-core/package.json",
        // The worker_threads entry tesseract spawns in Node.
        "./node_modules/tesseract.js/src/worker-script/**",
      ],
    },
  },
};

module.exports = nextConfig;
