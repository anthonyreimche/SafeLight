// `slu` as one Node file: src/cli/main.ts → dist-cli/slu.mjs, run by Electron's
// binary as plain Node (ELECTRON_RUN_AS_NODE=1). No React, no app chunks; the
// electron/*.cjs it uses are bundled in, and Node built-ins stay imports.
import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vite";

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

export default defineConfig({
  publicDir: false,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Lets main.ts run itself only in this bundle, never when a test imports it.
    __SLU_BIN__: "true",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  ssr: {
    target: "node",
    noExternal: true,
  },
  build: {
    ssr: "src/cli/main.ts",
    outDir: "dist-cli",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: {
      external: [/^node:/],
      output: {
        format: "es",
        entryFileNames: "slu.mjs",
        codeSplitting: false,
      },
    },
  },
});
