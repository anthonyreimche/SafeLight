// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Stages from the official extensions (electron/official-extensions.json) are
// written as Safelight's own are: their uniforms and helpers keep the names
// they declare, so a panel's block reads the same once it leaves core, and
// they may run at anchors. Their values still come from the param bag, under
// the stage's qualified keys. Raw names share one namespace with the core
// program, so a raw name the core program or another such stage already has
// is refused at registration.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { checkStageContract } from "@/extensions/stage-validation";
import { registerProcessingStage, unregisterExtension, useRegistry } from "@/extensions/registry";
import { V2_VARIANT } from "./shaders";
import { isStandIn } from "./core-reads";
import { buildStageInjection } from "./stage-injection";
import { helperPrefix, uniformPrefix } from "./shader-compiler";

/** The stage's own declarations, without core's stand-ins (core-reads.ts). */
const ownDeclarations = (uniforms: string) =>
  uniforms
    .split("\n")
    .filter((l) => !isStandIn(l))
    .join("\n");

type Owned = ProcessingStageContribution & { extensionId?: string };

const TINT: ProcessingStageContribution = {
  id: "safelight.hsl.tint",
  name: "Tint",
  phase: "display-adjust",
  glsl: "c = slTint(c, uTintAmount);",
  helpers: "vec3 slTint(vec3 c, float a) { return c * (1.0 + a); }",
  uniforms: [{ key: "uTintAmount", glslType: "float", default: 0 }],
};

const owned = (extensionId: string, s: ProcessingStageContribution = TINT): Owned => ({ ...s, extensionId });

afterEach(() => {
  unregisterExtension("safelight.hsl");
  unregisterExtension("safelight.basic");
  unregisterExtension("acme");
  vi.restoreAllMocks();
});

describe("an official extension's stage", () => {
  it("keeps the names it declares", () => {
    const { injection } = buildStageInjection([owned("safelight.hsl")], V2_VARIANT);
    expect(ownDeclarations(injection.uniforms)).toBe("uniform float uTintAmount;");
    expect(injection.helpers).toBe(TINT.helpers);
    expect(injection.effects).toContain("c = slTint(c, uTintAmount);");
  });

  it("is bound from the bag under its qualified key", () => {
    const { bindings } = buildStageInjection([owned("safelight.hsl")], V2_VARIANT);
    expect(bindings).toEqual([
      { qualifiedKey: "safelight.hsl.tint.uTintAmount", glslName: "uTintAmount", glslType: "float", default: 0 },
    ]);
  });

  it("may run at an anchor", () => {
    const { injection } = buildStageInjection([{ ...owned("safelight.hsl"), anchor: "hsl" }], V2_VARIANT);
    expect(injection.anchors).toEqual({ hsl: TINT.glsl });
    expect(checkStageContract({ ...TINT, anchor: "hsl" }, "safelight.hsl").warnings).toEqual([]);
  });

  it("is written as any extension's when the extension isn't official", () => {
    const { injection } = buildStageInjection([owned("acme", { ...TINT, id: "acme.tint" })], V2_VARIANT);
    expect(ownDeclarations(injection.uniforms)).toBe(`uniform float ${uniformPrefix("acme.tint")}uTintAmount;`);
    expect(injection.helpers).toContain(`${helperPrefix("acme.tint")}slTint`);
  });
});

describe("registering a stage with raw names", () => {
  const refused = () => vi.spyOn(console, "error").mockImplementation(() => {});

  it("refuses a uniform the core program declares", () => {
    const error = refused();
    registerProcessingStage("safelight.basic", {
      ...TINT,
      id: "safelight.basic.tone",
      uniforms: [{ key: "uAsShotTemperature", glslType: "float", default: 0 }],
    });
    expect(useRegistry.getState().processingStages["safelight.basic.tone"]).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[extensions] safelight.basic: stage "safelight.basic.tone": "uAsShotTemperature" is already a name in the develop program; stage not registered',
    );
  });

  it("refuses a helper the core program defines", () => {
    const error = refused();
    registerProcessingStage("safelight.hsl", { ...TINT, helpers: "vec3 rgb2hsl(vec3 c) { return c; }" });
    expect(useRegistry.getState().processingStages[TINT.id]).toBeUndefined();
    expect(error.mock.calls[0][0]).toContain('"rgb2hsl" is already a name in the develop program');
  });

  it("refuses a name another raw-name stage has, from any extension", () => {
    const error = refused();
    registerProcessingStage("safelight.hsl", TINT);
    registerProcessingStage("safelight.basic", { ...TINT, id: "safelight.basic.tint" });
    expect(Object.keys(useRegistry.getState().processingStages)).toContain(TINT.id);
    expect(useRegistry.getState().processingStages["safelight.basic.tint"]).toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      '[extensions] safelight.basic: stage "safelight.basic.tint": "uTintAmount" is already a name in stage "safelight.hsl.tint"; stage not registered',
    );
  });

  it("lets a stage register again under its own id", () => {
    refused();
    registerProcessingStage("safelight.hsl", TINT);
    registerProcessingStage("safelight.hsl", { ...TINT, glsl: "c = slTint(c, uTintAmount * 2.0);" });
    expect(useRegistry.getState().processingStages[TINT.id]?.glsl).toBe("c = slTint(c, uTintAmount * 2.0);");
  });

  it("leaves an extension's prefixed names alone", () => {
    const error = refused();
    registerProcessingStage("acme", { ...TINT, id: "acme.tint", uniforms: [{ key: "uExposure", glslType: "float", default: 0 }] });
    expect(useRegistry.getState().processingStages["acme.tint"]).toBeDefined();
    expect(error).not.toHaveBeenCalled();
  });
});
