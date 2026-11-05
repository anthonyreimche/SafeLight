// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage of Safelight's or of an official extension can derive its uniform
// values from the photo's DevelopParams. deriveStageValues runs the stages'
// derive in the window and keys what they return by the stages' qualified
// keys; the values then travel with the params they came from
// (render-bridge.test.tsx, stage-types.webgl.test.ts). The render worker gets
// the stages without derive.

import { afterEach, describe, expect, it, vi } from "vitest";
import { freshParams, type DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution, StageDeriveContext } from "@/extensions/types";
import { registerProcessingStage, unregisterExtension } from "@/extensions/registry";
import { checkStageContract } from "@/extensions/stage-validation";
import { setExtSetting } from "@/extensions/ext-settings";
import { useRunningPlugins } from "@/extensions/running-plugins";
import { deriveStageValues } from "./stage-derive";
import { paramsForDerive, windowDeriveContext as inWindow } from "./window-derive";
import { stagesForWorker } from "./render-bridge";

const EXPOSURE: ProcessingStageContribution & { extensionId: string } = {
  id: "safelight.basic.tone",
  name: "Tone",
  phase: "scene-linear",
  glsl: "lin *= exp2(uToneExposure);",
  uniforms: [{ key: "uToneExposure", glslType: "float", default: 0 }],
  derive: (p) => ({ uToneExposure: p.exposure }),
  extensionId: "safelight.basic",
};

const with_ = (extra: Partial<ProcessingStageContribution>) => ({ ...EXPOSURE, ...extra });
const params = (extra: Partial<DevelopParams> = {}): DevelopParams => ({ ...freshParams(), ...extra });

afterEach(() => {
  unregisterExtension("safelight.basic");
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("deriveStageValues", () => {
  it("keys what each stage derives by its qualified keys", () => {
    expect(deriveStageValues(params({ exposure: 1.5 }), [EXPOSURE], inWindow)).toEqual({
      "safelight.basic.tone.uToneExposure": 1.5,
    });
  });

  it("hands a stage its extension's settings", () => {
    const seen: StageDeriveContext[] = [];
    setExtSetting("safelight.basic", "style", 0.5);
    const stage = with_({ derive: (_, ctx) => (seen.push(ctx), { uToneExposure: ctx.settings("style", 1) }) });
    expect(deriveStageValues(params(), [stage], inWindow)).toEqual({ "safelight.basic.tone.uToneExposure": 0.5 });
    expect(seen[0].settings("missing", 7)).toBe(7);
  });

  // The render worker has no stored settings: the caller says where they come from.
  it("reads the settings from the context it is handed", () => {
    setExtSetting("safelight.basic", "style", 0.5);
    const stage = with_({ derive: (_, ctx) => ({ uToneExposure: ctx.settings("style", 1) }) });
    const handed = { settingsFor: (id: string) => (id === "safelight.basic" ? { style: 3 } : {}) };
    expect(deriveStageValues(params(), [stage], handed)).toEqual({ "safelight.basic.tone.uToneExposure": 3 });
  });

  it("derives again only for new params or changed settings", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure }));
    const stage = with_({ derive });
    const p = params({ exposure: 1 });
    deriveStageValues(p, [stage], inWindow);
    deriveStageValues(p, [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(1);
    setExtSetting("safelight.basic", "style", 2);
    deriveStageValues(p, [stage], inWindow);
    deriveStageValues(params({ exposure: 2 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(3);
  });

  it("keeps a stage's values, the same objects, while the params it read are the same", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure, uCurve: [p.exposure] }));
    const stage = with_({ derive, uniforms: [...EXPOSURE.uniforms, { key: "uCurve", glslType: "float", length: 1, default: [0] }] });
    const first = deriveStageValues(params({ exposure: 1 }), [stage], inWindow);
    const other = deriveStageValues(params({ exposure: 1, contrast: 20 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(other["safelight.basic.tone.uCurve"]).toBe(first["safelight.basic.tone.uCurve"]);
    deriveStageValues(params({ exposure: 2, contrast: 20 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(2);
  });

  // A capture or a thumbnail derives another photo's params between the live
  // photo's frames; the live values must stay the same objects, or the bridge
  // posts them to the worker again.
  it("keeps the live params' values while other params are derived in between", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure, uCurve: [p.exposure] }));
    const stage = with_({ derive, uniforms: [...EXPOSURE.uniforms, { key: "uCurve", glslType: "float", length: 1, default: [0] }] });
    const live = params({ exposure: 1 });
    const first = deriveStageValues(live, [stage], inWindow);
    for (const exposure of [2, 3, 4, 5, 6]) {
      deriveStageValues(params({ exposure }), [stage], inWindow);
      expect(deriveStageValues(live, [stage], inWindow)["safelight.basic.tone.uCurve"]).toBe(first["safelight.basic.tone.uCurve"]);
    }
    expect(derive).toHaveBeenCalledTimes(6);
    deriveStageValues(params({ exposure: 6 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(6);
  });

  it("keeps a stage's values for an extension that has stored no settings", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure }));
    const stage = { ...with_({ derive }), id: "safelight.crop.tone", extensionId: "safelight.crop" };
    deriveStageValues(params({ exposure: 1 }), [stage], inWindow);
    deriveStageValues(params({ exposure: 1 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(1);
  });

  // A stage registered again with the same derive can declare other uniforms.
  it("derives again for a stage registered anew with the same derive", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure, uOther: 2 }));
    const first = with_({ derive });
    const again = with_({ derive, uniforms: [...EXPOSURE.uniforms, { key: "uOther", glslType: "float", default: 0 }] });
    const p = params({ exposure: 1 });
    deriveStageValues(p, [first], inWindow);
    expect(deriveStageValues(p, [again], inWindow)).toEqual({
      "safelight.basic.tone.uToneExposure": 1,
      "safelight.basic.tone.uOther": 2,
    });
  });

  it("holds only a few params per stage", () => {
    const derive = vi.fn((p: DevelopParams) => ({ uToneExposure: p.exposure }));
    const stage = with_({ derive });
    for (let exposure = 0; exposure < 20; exposure++) deriveStageValues(params({ exposure }), [stage], inWindow);
    deriveStageValues(params({ exposure: 0 }), [stage], inWindow);
    expect(derive).toHaveBeenCalledTimes(21);
  });

  it("leaves out a stage whose derive throws, and says so once", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const stage = with_({
      derive: () => {
        throw new Error("boom");
      },
    });
    expect(deriveStageValues(params({ exposure: 1 }), [stage], inWindow)).toEqual({});
    deriveStageValues(params({ exposure: 2 }), [stage], inWindow);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toBe('[render] stage "safelight.basic.tone": derive failed (boom); its values are left out');
  });

  it("keeps only the stage's own uniforms and photo textures", () => {
    const stage = with_({ derive: () => ({ uToneExposure: 1, uExposure: 9, "acme.look.amount": 3 }) });
    expect(deriveStageValues(params(), [stage], inWindow)).toEqual({ "safelight.basic.tone.uToneExposure": 1 });
  });

  it("is ignored on any other extension's stage", () => {
    const stage = { ...EXPOSURE, id: "acme.tone", extensionId: "acme" };
    expect(deriveStageValues(params({ exposure: 1 }), [stage], inWindow)).toEqual({});
    expect(checkStageContract(stage, "acme").warnings).toContain(
      'stage "acme.tone": derive is for Safelight\'s own stages, so it is ignored',
    );
  });
});

// Develop draws a stopped essential's params at their defaults, also for the
// stages that read them (Crop's matrix reads Transform's); export and the
// Library histogram derive from the same params.
describe("paramsForDerive", () => {
  const CROP = { ...EXPOSURE, id: "safelight.crop.geometry", extensionId: "safelight.crop" };
  const keystoned = params({ transform: { ...freshParams().transform, perspectiveV: 20 } });

  afterEach(() => useRunningPlugins.setState({ ids: [] }));

  it("puts a stopped essential's params at their defaults", () => {
    useRunningPlugins.setState({ ids: ["safelight.crop"] });
    expect(paramsForDerive(keystoned, [CROP]).transform).toEqual(freshParams().transform);
  });

  it("hands back the params themselves while every essential they use runs", () => {
    const transform = { ...CROP, id: "safelight.transform.matrix", extensionId: "safelight.transform" };
    expect(paramsForDerive(keystoned, [CROP, transform])).toBe(keystoned);
  });
});

describe("the render worker", () => {
  it("is sent the stages without derive", () => {
    registerProcessingStage("safelight.basic", EXPOSURE);
    const [sent] = stagesForWorker();
    expect(sent.id).toBe(EXPOSURE.id);
    expect("derive" in sent).toBe(false);
    expect(() => structuredClone(stagesForWorker())).not.toThrow();
  });
});
