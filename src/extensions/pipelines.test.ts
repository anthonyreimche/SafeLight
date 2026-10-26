// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which display transform a photo renders with: its own pick while that
// transform is installed, else the Preferences default, else the built-in.
// A pick is never erased when its extension goes away, so re-enabling the
// extension brings the look back.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeParams, type DevelopParams } from "@/catalog/types";
import { helperPrefix, uniformPrefix } from "@/rendering/webgl/shader-compiler";
import { getParamDescriptor, normalizeParamBag, registerStageParams } from "./param-registry";
import { registerPipeline, unregisterExtension, useRegistry } from "./registry";
import {
  BUILTIN_RESOLVED,
  DEFAULT_PIPELINE,
  derivedKey,
  effectivePipelineId,
  resolveDefaultPipeline,
  resolvePipelineFor,
  setPhotoParams,
  transformParamKeys,
  transformPresetField,
  usePipelineStore,
  withPipeline,
  type ResolvedPipeline,
} from "./pipelines";

const AGX = {
  id: "test.agx",
  name: "AgX",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }",
  skipBaseCurve: true,
};
const FILMIC = {
  id: "test.filmic",
  name: "Filmic",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 0.5; }",
};

const useDefault = (id: string) => usePipelineStore.setState({ activeId: id });

beforeEach(() => {
  useRegistry.setState({ pipelines: {} });
  registerPipeline("core", { id: DEFAULT_PIPELINE, name: "Built-in" });
  registerPipeline("test", AGX);
  registerPipeline("test", FILMIC);
  useDefault(DEFAULT_PIPELINE);
});

afterEach(() => {
  vi.restoreAllMocks();
  unregisterExtension("test");
  useRegistry.setState({ pipelines: {} });
  useDefault(DEFAULT_PIPELINE);
});

describe("effectivePipelineId", () => {
  it("uses the photo's own pick while it is installed", () => {
    useDefault(FILMIC.id);
    expect(effectivePipelineId(AGX.id)).toBe(AGX.id);
  });

  it("follows the Preferences default when the photo has no pick", () => {
    useDefault(FILMIC.id);
    expect(effectivePipelineId(null)).toBe(FILMIC.id);
  });

  it("falls back to the default when the pick's extension is gone", () => {
    useDefault(FILMIC.id);
    expect(effectivePipelineId("gone.film")).toBe(FILMIC.id);
  });

  it("falls back to the built-in when the default is gone too", () => {
    useDefault("gone.default");
    expect(effectivePipelineId("gone.film")).toBe(DEFAULT_PIPELINE);
  });
});

describe("resolvePipelineFor", () => {
  it("carries the picked transform's shader and base-curve choice", () => {
    const p = resolvePipelineFor(AGX.id);
    expect(p).toMatchObject({ id: AGX.id, glsl: AGX.glsl, skipBaseCurve: true });
  });

  it("resolves the built-in transform to the stock program", () => {
    expect(resolvePipelineFor(null)).toBe(BUILTIN_RESOLVED);
  });

  it("is the default's resolution when asked for the default", () => {
    useDefault(FILMIC.id);
    expect(resolveDefaultPipeline()).toBe(resolvePipelineFor(null));
    expect(resolveDefaultPipeline().id).toBe(FILMIC.id);
  });

  it("keeps the core tone shoulder for the built-in and unflagged transforms", () => {
    expect(BUILTIN_RESOLVED.skipToneShoulder).toBe(false);
    expect(resolvePipelineFor(AGX.id).skipToneShoulder).toBe(false);
  });

  it("carries a tone-shoulder opt-out declared without a shader", () => {
    registerPipeline("test", { id: "test.rolloff", name: "Roll-off", skipToneShoulder: true });
    const p = resolvePipelineFor("test.rolloff");
    expect(p).not.toBe(BUILTIN_RESOLVED);
    expect(p).toMatchObject({
      id: "test.rolloff",
      glsl: null,
      skipBaseCurve: false,
      skipToneShoulder: true,
    });
  });

  it("signs each flag combination of one transform apart", () => {
    const sigs = new Set<string>();
    for (const glsl of [undefined, AGX.glsl]) {
      for (const skipBaseCurve of [false, true]) {
        for (const skipToneShoulder of [false, true]) {
          registerPipeline("test", { ...AGX, glsl, skipBaseCurve, skipToneShoulder });
          sigs.add(resolvePipelineFor(AGX.id).sig);
        }
      }
    }
    expect(sigs.size).toBe(8);
  });

  it("returns the same object until the registry changes", () => {
    const first = resolvePipelineFor(AGX.id);
    expect(resolvePipelineFor(AGX.id)).toBe(first);
    registerPipeline("test", { ...AGX, glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 2.0; }" });
    const next = resolvePipelineFor(AGX.id);
    expect(next).not.toBe(first);
    expect(next.sig).not.toBe(first.sig);
  });
});

describe("setPhotoParams", () => {
  it("hands the renderer the photo's transform along with its params", () => {
    const calls: string[] = [];
    const target = {
      setActivePipeline: (p: ResolvedPipeline) => {
        calls.push(`pipeline:${p.id}`);
      },
      setParams: (p: DevelopParams) => {
        calls.push(`params:${p.exposure}`);
      },
    };
    setPhotoParams(target, normalizeParams({ exposure: 1, displayTransform: AGX.id }));
    expect(calls).toEqual([`pipeline:${AGX.id}`, "params:1"]);
  });
});

describe("withPipeline", () => {
  const live: ResolvedPipeline = { ...BUILTIN_RESOLVED, id: "live", sig: "live" };
  const other: ResolvedPipeline = { ...BUILTIN_RESOLVED, id: "other", sig: "other" };

  function recorder() {
    const seen: string[] = [];
    const target = {
      setActivePipeline: (p: ResolvedPipeline) => {
        seen.push(p.id);
      },
    };
    return { seen, target };
  }

  it("renders with the given pipeline and puts the live one back", () => {
    const { seen, target } = recorder();
    const out = withPipeline(target, other, live, () => {
      seen.push("render");
      return 7;
    });
    expect(out).toBe(7);
    expect(seen).toEqual(["other", "render", "live"]);
  });

  it("puts the live pipeline back when the render throws", () => {
    const { seen, target } = recorder();
    expect(() =>
      withPipeline(target, other, live, () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(seen).toEqual(["other", "live"]);
  });
});

describe("a transform with params", () => {
  const TUNED = {
    id: "test.tuned",
    name: "Tuned",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return gain * lin; }",
    params: [{ key: "gain", glslType: "float" as const, default: 1, range: { min: 0, max: 4 } }],
  };

  it("registers a descriptor for each param", () => {
    registerPipeline("test", TUNED);
    expect(getParamDescriptor("test.tuned.gain")).toMatchObject({ default: 1, glslType: "float" });
    expect(transformParamKeys(TUNED.id)).toEqual(["test.tuned.gain"]);
  });

  it("replaces its descriptors when registered again", () => {
    registerPipeline("test", TUNED);
    registerPipeline("test", { ...TUNED, params: [{ key: "lift", glslType: "float", default: 0 }] });
    expect(getParamDescriptor("test.tuned.gain")).toBeUndefined();
    expect(transformParamKeys(TUNED.id)).toEqual(["test.tuned.lift"]);
  });

  it("drops its descriptors with its extension but keeps a photo's values", () => {
    registerPipeline("test", TUNED);
    unregisterExtension("test");
    expect(getParamDescriptor("test.tuned.gain")).toBeUndefined();
    expect(normalizeParamBag({ "test.tuned.gain": 2 })).toEqual({ "test.tuned.gain": 2 });
  });

  it("drops its descriptors when registered again without params", () => {
    registerPipeline("test", TUNED);
    registerPipeline("test", { ...TUNED, params: undefined });
    expect(getParamDescriptor("test.tuned.gain")).toBeUndefined();
  });

  // A stage and a transform shouldn't share an id; when they do, a transform
  // that never declared params has no descriptors of its own to replace.
  it("leaves a stage's descriptors under its id alone when it declares no params", () => {
    registerStageParams("test.shared", "Shared", "test", [{ key: "amount", glslType: "float", default: 0 }]);
    registerPipeline("test", { id: "test.shared", name: "Shared", glsl: FILMIC.glsl });
    expect(getParamDescriptor("test.shared.amount")).toMatchObject({ stageId: "test.shared", default: 0 });
  });

  it("is refused, and logged, when its contract is broken", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerPipeline("test", { ...TUNED, glsl: undefined });
    expect(useRegistry.getState().pipelines[TUNED.id]).toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/transform "test\.tuned".*not registered/));
  });

  it("has no param keys when it declares none or isn't registered", () => {
    expect(transformParamKeys(AGX.id)).toEqual([]);
    expect(transformParamKeys("gone.transform")).toEqual([]);
  });

  it("offers its params and their defaults to the Display transform preset field, changed once one moves", () => {
    registerPipeline("test", TUNED);
    const offered = { bagKeys: ["test.tuned.gain"], bagDefaults: { "test.tuned.gain": 1 } };
    expect(transformPresetField(TUNED.id, {})).toEqual({ ...offered, changed: false });
    expect(transformPresetField(TUNED.id, { "test.tuned.gain": 1 })).toEqual({ ...offered, changed: false });
    expect(transformPresetField(TUNED.id, { "test.tuned.gain": 2 })).toEqual({ ...offered, changed: true });
  });

  it("reads a key the bag holds as undefined as unmoved, as a stage's field does", () => {
    registerPipeline("test", TUNED);
    expect(transformPresetField(TUNED.id, { "test.tuned.gain": undefined }).changed).toBe(false);
  });

  it("offers the default transform's params to a photo without a pick", () => {
    registerPipeline("test", TUNED);
    useDefault(TUNED.id);
    expect(transformPresetField(null, {}).bagKeys).toEqual(["test.tuned.gain"]);
  });
});

describe("resolving a tuned transform", () => {
  const PARAMS = {
    id: "test.gain",
    name: "Gain",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return tint(gain * lin); }",
    helpers: "vec3 tint(vec3 c) { return c * vec3(1.0, 1.0, 0.9); }",
    params: [{ key: "gain", glslType: "float" as const, default: 1 }],
  };
  const DERIVED = {
    id: "test.derived",
    name: "Derived",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return scale * lin; }",
    params: [{ key: "gain", glslType: "float" as const, default: 1 }],
    derive: {
      uniforms: [{ key: "scale", glslType: "mat3" as const, default: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
      fn: () => ({}),
    },
  };

  it("leaves a plain transform's shader and signature as they were", () => {
    const p = resolvePipelineFor(AGX.id);
    expect(p.sig).toBe(`${AGX.id}\nb-\n${AGX.glsl}`);
    expect(p.glsl).toBe(AGX.glsl);
    expect(p.uniformDecls).toBeUndefined();
    expect(p.bindings).toBeUndefined();
  });

  it("namespaces its params and helpers and binds each param from the bag", () => {
    registerPipeline("test", PARAMS);
    const p = resolvePipelineFor(PARAMS.id);
    const u = uniformPrefix(PARAMS.id);
    const h = helperPrefix(PARAMS.id);
    expect(p.glsl).toContain(`vec3 ${h}tint(vec3 c)`);
    expect(p.glsl).toContain(`return ${h}tint(${u}gain * lin);`);
    expect(p.glsl).not.toMatch(/\bgain\b/);
    expect(p.uniformDecls).toBe(`uniform float ${u}gain;`);
    expect(p.bindings).toEqual([
      { qualifiedKey: "test.gain.gain", glslName: `${u}gain`, glslType: "float", default: 1 },
    ]);
  });

  it("binds derived uniforms from their own keys, not the params'", () => {
    registerPipeline("test", DERIVED);
    const p = resolvePipelineFor(DERIVED.id);
    const u = uniformPrefix(DERIVED.id);
    expect(p.uniformDecls).toBe(`uniform mat3 ${u}scale;`);
    expect(p.bindings?.map((b) => b.qualifiedKey)).toEqual([derivedKey(DERIVED.id, "scale")]);
    expect(derivedKey(DERIVED.id, "scale")).toBe("test.derived#scale");
  });

  it("signs a change of declarations apart", () => {
    registerPipeline("test", PARAMS);
    const before = resolvePipelineFor(PARAMS.id).sig;
    registerPipeline("test", { ...PARAMS, params: [...PARAMS.params, { key: "lift", glslType: "float", default: 0 }] });
    expect(resolvePipelineFor(PARAMS.id).sig).not.toBe(before);
  });

  it("signs params-as-uniforms and derived uniforms apart", () => {
    const glsl = "vec3 pipelineToDisplay(vec3 lin) { return scale * lin; }";
    const scale = { key: "scale", glslType: "float" as const, default: 1 };
    registerPipeline("test", { id: "test.same", name: "Same", glsl, params: [scale] });
    const asParams = resolvePipelineFor("test.same").sig;
    registerPipeline("test", { id: "test.same", name: "Same", glsl, derive: { uniforms: [scale], fn: () => ({}) } });
    expect(resolvePipelineFor("test.same").sig).not.toBe(asParams);
  });
});
