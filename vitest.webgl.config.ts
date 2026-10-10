/// <reference types="vitest/config" />
import path from "path";
import { readFileSync } from "fs";
import { defineConfig } from "vite";
import { playwright } from "@vitest/browser-playwright";

// The renderer needs a real WebGL2 context, which neither node nor jsdom can
// provide (headless-gl is WebGL 1.0 only, and renderer.ts hard-requires 2.0:
// `#version 300 es`, texStorage2D, VAOs, RGBA16F). These specs therefore run in
// Playwright's Chromium — the same engine Electron ships — and are kept out of
// the default `npm test` run so it stays sub-second. Run with `npm run test:webgl`.

const pkg = JSON.parse(
  readFileSync(path.resolve(__dirname, "package.json"), "utf-8"),
) as { version: string };

const LIBRAW_VENDOR = path.resolve(__dirname, "src/raw/vendor/libraw-wasm/index.js");

export default defineConfig({
  cacheDir: "node_modules/.vite-cache",
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      "libraw-wasm": LIBRAW_VENDOR,
    },
  },
  optimizeDeps: { exclude: ["libraw-wasm"] },
  test: {
    name: "webgl",
    // `.browser.test.ts` specs need Chromium's real image decoder rather than a
    // GL context, and ride along for the same reason: the engine Electron ships.
    include: ["src/**/*.webgl.test.ts", "src/**/*.browser.test.ts"],
    // One file at a time. Every page's GL goes through Chromium's one GPU
    // process, which takes the work in turn, so files run side by side only
    // queue behind each other's shader compiles: the run is no faster (136 s
    // with up to 12 files at once, 126 s one by one), and each test's 15 s
    // timer counts the other files' compiles (slowest test 22 s, against 4 s).
    fileParallelism: false,
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [
        {
          browser: "chromium",
          // SwiftShader is the only GL backend available on a headless CI box;
          // without these Chromium falls back to a null driver and getContext
          // ("webgl2") returns null.
          launch: {
            args: [
              "--use-gl=angle",
              "--use-angle=swiftshader",
              "--enable-unsafe-swiftshader",
            ],
          },
        },
      ],
    },
  },
});
