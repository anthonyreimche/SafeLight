// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which display transform a photo renders with: its own pick while that
// transform is installed, else the Preferences default, else the built-in.
// A pick is never erased when its extension goes away, so re-enabling the
// extension brings the look back.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizeParams, type DevelopParams } from "@/catalog/types";
import { registerPipeline, useRegistry } from "./registry";
import {
  BUILTIN_RESOLVED,
  DEFAULT_PIPELINE,
  effectivePipelineId,
  resolveDefaultPipeline,
  resolvePipelineFor,
  setPhotoParams,
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
