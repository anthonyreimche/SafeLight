import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Single source of truth for the app version: package.json (the same field
// electron-builder uses to name the installer). Inlined into the bundle as the
// __APP_VERSION__ global so the About panel never drifts from the build.
const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

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
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
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
  build: {
    rollupOptions: {
      output: {
        // Split heavy vendors into long-lived, separately-cached chunks so the
        // entry bundle stays under Vite's 500 kB warning threshold. libraw-wasm
        // is intentionally not matched here — it ships its own worker/.wasm.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("dockview")) return "dockview";
          if (
            id.includes("react-dom") ||
            id.includes("react-router") ||
            id.includes("/scheduler/") ||
            /node_modules\/react\//.test(id)
          )
            return "react";
          return "vendor";
        },
      },
    },
  },
});
