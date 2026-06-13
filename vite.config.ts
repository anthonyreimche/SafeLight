import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// libraw-wasm runs in a Web Worker on shared memory, which needs the page to be
// cross-origin isolated (COOP/COEP). It also ships its own worker + .wasm using
// import.meta.url, so it must be excluded from Vite's dep pre-bundling.
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

// Vendored LibRaw WASM built from ybouane/LibRaw-Wasm @ libraw 0.22.1.
// Replaces the pre-built binary in the npm package (which ships 0.20.x and
// misses Canon EOS R ISOBMFF / CR3 color-matrix support added in 0.21).
const LIBRAW_VENDOR = path.resolve(__dirname, "src/raw/vendor/libraw-wasm/index.js");

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
      "libraw-wasm": LIBRAW_VENDOR,
    },
  },
  optimizeDeps: {
    // Must stay excluded: libraw-wasm spawns a pthread Worker and references
    // libraw.wasm via import.meta.url — both break inside Vite's pre-bundler.
    exclude: ["libraw-wasm"],
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
});
