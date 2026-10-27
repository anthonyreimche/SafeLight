// TEMPORARY probe config (camera-match investigation, 2026-10-27); delete after use.
import { mergeConfig } from "vite";
import base from "./vitest.webgl.config";

export default mergeConfig(base, {
  server: {
    fs: { allow: [".", "D:/Photos"] },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  test: {
    name: "probe",
    include: ["src/raw/zz-camera-match.probe.ts"],
    testTimeout: 120_000,
  },
});
