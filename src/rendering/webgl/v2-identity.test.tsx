// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 2 is frozen. Safelight 3.0.0 and 3.0.1 made every new edit
// a version 2 edit, and those photos must keep rendering as they did. Every
// piece of the version 2 program, and the metadata that drives it, must stay
// the tokens 3.0.1 built (v2-reference.ts holds their SHA-256), apart from the
// one deliberate change recorded there. A failure here means a version 2 photo
// would change: fix the code, never the reference.

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { V2_IDENTITY_CONFIGS, v2Snapshot } from "./v2-identity.fixtures";
import { V2_REFERENCE } from "./v2-reference";
import { buildStageInjection } from "./stage-injection";
import { V2_VARIANT } from "./shaders";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("process version 2 stays frozen", () => {
  const snapshot = v2Snapshot();

  it("freezes the same pieces 3.0.1 built", () => {
    expect(Object.keys(snapshot).sort()).toEqual(Object.keys(V2_REFERENCE).sort());
  });

  it("builds every piece token-for-token as 3.0.1 did", () => {
    const changed = Object.keys(V2_REFERENCE).filter((key) => sha256(snapshot[key] ?? "") !== V2_REFERENCE[key]);
    expect(changed).toEqual([]);
  });
});

// A fixture that misses its branch freezes nothing, so each must reach it.
describe("the version 2 fixtures reach their branches", () => {
  const built = (name: string) =>
    buildStageInjection(V2_IDENTITY_CONFIGS[name].stages(), V2_VARIANT, V2_IDENTITY_CONFIGS[name].samplerBudget);

  it("legacyExtensions clips ahead of its legacy display stages", () => {
    expect(built("legacyExtensions").injection.effects).toContain("c = clamp(c, 0.0, 1.0);");
  });
  it("spaced converts into its declared spaces", () => {
    expect(built("spaced").injection.sceneLinear).toContain("SL_REC709_TO_REC2020");
  });
  // Version 2 also makes the built-in denoiser a reader once a decode stage
  // precedes it, so four stages of ours give five exits.
  it("splits exits at every cut and for the built-in denoiser", () => {
    const { injection, prepass } = built("splits");
    expect(injection.splitCount).toBe(5);
    expect(prepass.map((p) => [p.stageId, p.split?.cut])).toEqual([
      ["split.decode", "decode"],
      ["builtin.denoise", "decode"],
      ["split.scene", "scene"],
      ["split.display", "display"],
      ["split.effects", "display"],
    ]);
  });
  it("sceneLuma reads slSceneLuma", () => {
    expect(built("sceneLuma").injection.effects).toContain("slSceneLuma");
  });
  it("layered reads its results from layers", () => {
    const { prepass } = built("layered");
    expect(prepass).not.toEqual([]);
    expect(prepass.every((p) => p.layerUniform)).toBe(true);
  });
});
