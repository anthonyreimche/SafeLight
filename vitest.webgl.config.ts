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
    include: ["src/**/*.webgl.test.ts"],
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
