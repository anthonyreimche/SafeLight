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

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  optimizeDeps: {
    exclude: ["libraw-wasm"],
  },
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
});
