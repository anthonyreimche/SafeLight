// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Without EXT_color_buffer_float several intermediates quietly become 8-bit and
// clip to [0, 1]. The renderer says so once per path and lists the paths, so a
// report of banded or clipped output from such a GPU is explained by the log.

import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  type DevelopParams,
  type RetouchSpot,
} from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { StageResultLayers } from "./stage-result-layers";
import {
  LINEAR_PROBE_PIPELINE,
  basicStagesFor,
  floatImage,
  glHarness,
  healStagesFor,
  identityParams,
  markerStage,
  takingStages,
  withRenderer,
} from "./webgl.test-support";

const V2 = identityParams({ processVersion: CURRENT_PROCESS_VERSION });
const V1 = identityParams({ processVersion: LEGACY_PROCESS_VERSION });
const SOURCE = floatImage(16, 16, () => [0.2, 0.2, 0.2]);

const HEAL: RetouchSpot = {
  id: "spot",
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.25,
  srcY: 0.25,
  radius: 0.1,
  feather: 0,
  opacity: 100,
};

let restore: (() => void) | null = null;
let warn: MockInstance<typeof console.warn> | null = null;

afterEach(() => {
  restore?.();
  restore = null;
  warn?.mockRestore();
  warn = null;
});

/** Hides EXT_color_buffer_float from renderers built after this, as a GPU or VM
 *  without it would, and collects what they warn. */
function withoutFloatTargets(): void {
  const { gl } = glHarness();
  const getExtension = gl.getExtension.bind(gl);
  gl.getExtension = ((name: string) =>
    name === "EXT_color_buffer_float" ? null : getExtension(name)) as typeof gl.getExtension;
  restore = () => {
    gl.getExtension = getExtension;
  };
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
}

function warnings(about: RegExp): string[] {
  return (warn?.mock.calls ?? []).map((c) => String(c[0])).filter((m) => about.test(m));
}

function drawn(
  stages: ProcessingStageContribution[],
  params: DevelopParams,
  bag: Record<string, number> = {},
  frames = 2,
): string[] {
  return withRenderer(
    { stages, pipeline: LINEAR_PROBE_PIPELINE, highBitDepth: false },
    (r) => {
      r.setImage(SOURCE);
      r.setParams(params);
      r.setContributedParams(bag);
      for (let i = 0; i < frames; i++) r.render();
      return r.reducedPrecision();
    },
  );
}

const PREPASS = /prepass/i;
const RESULTS = /stage results/i;
const COPY = /heal and clone/i;

describe("a GPU without float render targets", () => {
  it("says once that extension prepasses run at 8-bit, clipped to 0-1", () => {
    withoutFloatTargets();
    const stage = markerStage(0, 0.02);
    const reduced = drawn([stage], V2, takingStages([stage]), 3);
    expect(reduced.filter((n) => PREPASS.test(n))).toHaveLength(1);
    expect(warnings(PREPASS)).toHaveLength(1);
    expect(warnings(PREPASS)[0]).toMatch(/8-bit/);
  });

  it("says nothing about prepasses while none has run", () => {
    withoutFloatTargets();
    const stage = markerStage(0, 0.02);
    expect(drawn([stage], V2)).toEqual([]);
    expect(warnings(PREPASS)).toEqual([]);
  });

  it("says that the shared result array holds 8-bit results", () => {
    withoutFloatTargets();
    const stages = Array.from({ length: 30 }, (_, i) => markerStage(i, 0.02));
    const reduced = drawn(stages, V2, takingStages(stages));
    expect(reduced.filter((n) => RESULTS.test(n))).toHaveLength(1);
    expect(warnings(RESULTS)).toHaveLength(1);
  });

  it("says that a version 2 heal develops from an 8-bit copy", () => {
    withoutFloatTargets();
    const stages = [...basicStagesFor(V2.processVersion), ...healStagesFor(V2.processVersion)];
    const reduced = drawn(stages, { ...V2, retouch: [HEAL] });
    expect(reduced.filter((n) => COPY.test(n))).toHaveLength(1);
    expect(warnings(COPY)).toHaveLength(1);
    expect(warnings(COPY)[0]).toMatch(/8-bit/);
  });

  // The note says what the copy now holds, so a version 1 copy, which always
  // clips, takes it back.
  it("drops the heal-copy note once a version 1 heal allocates its copy", () => {
    withoutFloatTargets();
    const reduced = withRenderer(
      {
        stages: [...basicStagesFor(V2.processVersion), ...healStagesFor(V2.processVersion)],
        pipeline: LINEAR_PROBE_PIPELINE,
        highBitDepth: false,
      },
      (r) => {
        r.setImage(SOURCE);
        r.setParams({ ...V2, retouch: [HEAL] });
        r.render();
        expect(r.reducedPrecision().filter((n) => COPY.test(n))).toHaveLength(1);
        r.setStages([...basicStagesFor(V1.processVersion), ...healStagesFor(V1.processVersion)]);
        r.setImage(floatImage(24, 16, () => [0.2, 0.2, 0.2]));
        r.setParams({ ...V1, retouch: [HEAL] });
        r.render();
        return r.reducedPrecision();
      },
    );
    expect(reduced.filter((n) => COPY.test(n))).toEqual([]);
  });

  // A version 1 photo keeps the clipped copy its edits were made with.
  it("stays quiet about the heal copy on version 1, which always clips", () => {
    withoutFloatTargets();
    const stages = [...basicStagesFor(V1.processVersion), ...healStagesFor(V1.processVersion)];
    const reduced = drawn(stages, { ...V1, retouch: [HEAL] });
    expect(reduced.filter((n) => COPY.test(n))).toEqual([]);
    expect(warnings(COPY)).toEqual([]);
  });
});

describe("a GPU with float render targets", () => {
  it("lists nothing and warns of nothing", () => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stages = [
      ...basicStagesFor(V2.processVersion),
      ...healStagesFor(V2.processVersion),
      markerStage(0, 0.02),
    ];
    const reduced = drawn(stages, { ...V2, retouch: [HEAL] }, takingStages([markerStage(0, 0.02)]));
    expect(reduced).toEqual([]);
    expect(warnings(/8-bit|clipped/)).toEqual([]);
  });
});

describe("StageResultLayers", () => {
  it("reports an 8-bit array once, when it allocates one", () => {
    const { gl } = glHarness();
    const onReduced = vi.fn();
    const layers = new StageResultLayers(gl, false, onReduced);
    try {
      expect(onReduced).not.toHaveBeenCalled();
      layers.reserve(["a"], 4, 4, 1);
      expect(onReduced).toHaveBeenCalledTimes(1);
    } finally {
      layers.dispose();
    }
  });

  it("reports nothing for an 8-bit array it couldn't allocate", () => {
    const { gl } = glHarness();
    const status = gl.checkFramebufferStatus;
    gl.checkFramebufferStatus = (): number => gl.FRAMEBUFFER_UNSUPPORTED;
    const onReduced = vi.fn();
    const layers = new StageResultLayers(gl, false, onReduced);
    try {
      expect(layers.reserve(["a"], 4, 4, 1)).toBe(false);
      expect(onReduced).not.toHaveBeenCalled();
    } finally {
      gl.checkFramebufferStatus = status;
      layers.dispose();
    }
  });

  it("reports nothing for a float array", () => {
    const { gl } = glHarness();
    const onReduced = vi.fn();
    const layers = new StageResultLayers(gl, true, onReduced);
    try {
      layers.reserve(["a"], 4, 4, 1);
      expect(onReduced).not.toHaveBeenCalled();
    } finally {
      layers.dispose();
    }
  });
});

// The renderer is what enables float colour buffers in the app; the layer tests
// above that want RGBA16F renderable do the same.
glHarness().gl.getExtension("EXT_color_buffer_float");
