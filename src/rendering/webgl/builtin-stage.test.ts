// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which stages are Safelight's own. One id set answers two questions: is a
// stage built in at all (the renderer's stock program, who may register it), and
// is it a core stage (the injection's raw-uniform path). The built-in denoiser
// is the one id the two answer differently.

import { describe, expect, it } from "vitest";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { isBuiltInStage, isCoreStage } from "./builtin-stage";

const stageOf = (id: string) => ({ id });

describe("built-in stage ids", () => {
  it.each(["core.vignette", "core.grain", "core.a.b"])(
    "counts %s as built in and as core",
    (id) => {
      expect(isBuiltInStage(stageOf(id))).toBe(true);
      expect(isCoreStage(stageOf(id))).toBe(true);
    },
  );

  it("counts the built-in denoiser as built in, and not as core", () => {
    expect(isBuiltInStage(stageOf(BUILTIN_DENOISE_ID))).toBe(true);
    expect(isCoreStage(stageOf(BUILTIN_DENOISE_ID))).toBe(false);
  });

  it.each([
    "acme.look",
    "core",
    "corex.look",
    "xcore.look",
    "Core.look",
    "my.core.look",
    `${BUILTIN_DENOISE_ID}.extra`,
    `x.${BUILTIN_DENOISE_ID}`,
  ])("counts %s as neither", (id) => {
    expect(isBuiltInStage(stageOf(id))).toBe(false);
    expect(isCoreStage(stageOf(id))).toBe(false);
  });
});
