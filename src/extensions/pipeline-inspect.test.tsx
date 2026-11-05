// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The data Developer Tools' Pipeline tab draws, through api.devtools.pipeline:
// the open photo's process version, the rows of the program a version builds,
// and the space the frames are drawn in.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { DEFAULT_DEVELOP_PARAMS, defaultMaskAdjustments, type DevelopParams, type Mask } from "@/catalog/types";
import { useDisplayProfile } from "@/rendering/display-profile-store";
import type { PipelineRow } from "@/rendering/webgl/pipeline-description";
import type { ProcessVersion } from "@/rendering/webgl/shaders";
import { useDevelopStore } from "@/state/develop-store";
import { useRegistry } from "./registry";
import type { ProcessingStageContribution } from "./types";
import { useOpenProcessVersion, usePipelineRows, usePipelineScreen } from "./pipeline-inspect";

const REGISTRY = useRegistry.getState();
const DEVELOP = useDevelopStore.getState();
const PROFILE = useDisplayProfile.getState();

afterEach(() => {
  useRegistry.setState(REGISTRY, true);
  useDevelopStore.setState(DEVELOP, true);
  useDisplayProfile.setState(PROFILE, true);
  vi.unstubAllGlobals();
});

const WASH: ProcessingStageContribution = {
  id: "acme.wash",
  name: "Wash",
  phase: "display-adjust",
  glsl: "c *= washAmount;",
  uniforms: [{ key: "washAmount", glslType: "float", default: 1 }],
  mask: { maskable: true },
};

function register(...stages: ProcessingStageContribution[]): void {
  const processingStages = Object.fromEntries(stages.map((s) => [s.id, { ...s, extensionId: "acme" }]));
  act(() => useRegistry.setState({ processingStages }));
}

function openPhoto(params: Partial<DevelopParams>, photoId = "p1"): void {
  act(() => useDevelopStore.setState({ photoId, params: { ...DEFAULT_DEVELOP_PARAMS, ...params } }));
}

function edit(params: Partial<DevelopParams>): void {
  act(() => {
    const current = useDevelopStore.getState().params;
    useDevelopStore.setState({ params: { ...current, ...params } });
  });
}

const mask = (id: string, bag: Record<string, unknown>): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [],
  bag,
});

const stageRow = (rows: PipelineRow[], id: string) =>
  rows.find((r): r is Extract<PipelineRow, { kind: "stage" }> => r.kind === "stage" && r.id === id);

/** A screen that reaches P3, and a browser whose WebGL drawing buffer can be
 *  tagged with a colour space or not (the renderer's own feature test). */
function onP3Screen(canTag: boolean): void {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  vi.stubGlobal(
    "WebGL2RenderingContext",
    canTag
      ? class {
          get drawingBufferColorSpace() {
            return "srgb";
          }
        }
      : class {},
  );
}

describe("useOpenProcessVersion", () => {
  it("answers the current default's version while no photo is open", () => {
    const { result } = renderHook(() => useOpenProcessVersion());
    expect(result.current).toEqual({ photoId: null, version: 2 });
  });

  it("follows the open photo's version", () => {
    openPhoto({ processVersion: 1 });
    const { result } = renderHook(() => useOpenProcessVersion());
    expect(result.current).toEqual({ photoId: "p1", version: 1 });
  });
});

describe("usePipelineRows", () => {
  it("counts the copies the photo's masks run of a maskable stage", () => {
    register(WASH);
    openPhoto({ processVersion: 2, masks: ["a", "b"].map((id) => mask(id, { "acme.wash.washAmount": 0.5 })) });
    const { result } = renderHook(() => usePipelineRows(2));
    expect(stageRow(result.current, "acme.wash")?.copies).toBe(2);
  });

  it("keeps the rows for an edit that leaves the masks' copies alone", () => {
    register(WASH);
    const a = mask("a", { "acme.wash.washAmount": 0.5 });
    openPhoto({ processVersion: 2, masks: [a] });
    const { result } = renderHook(() => usePipelineRows(2));
    const before = result.current;
    edit({ exposure: 1 });
    edit({ masks: [{ ...a, opacity: 50 }] });
    expect(result.current).toBe(before);
    edit({ masks: [a, mask("b", { "acme.wash.washAmount": 0.2 })] });
    expect(result.current).not.toBe(before);
    expect(stageRow(result.current, "acme.wash")?.copies).toBe(2);
  });

  it("builds the version asked for", () => {
    openPhoto({ processVersion: 2 });
    const { result, rerender } = renderHook(({ v }: { v: ProcessVersion }) => usePipelineRows(v), {
      initialProps: { v: 2 },
    });
    const output = () => result.current.find((r) => r.kind === "output");
    expect(output()).toMatchObject({ mapped: false });
    rerender({ v: 3 });
    expect(output()).toMatchObject({ mapped: true });
  });
});

describe("usePipelineScreen", () => {
  it("names the screen's space where the drawing buffer can be tagged", () => {
    onP3Screen(true);
    const { result } = renderHook(() => usePipelineScreen());
    expect(result.current).toEqual({ space: "display-p3", profile: null });
  });

  it("names sRGB where the drawing buffer can't be tagged, or there is no WebGL2", () => {
    onP3Screen(false);
    expect(renderHook(() => usePipelineScreen()).result.current.space).toBe("srgb");
    vi.stubGlobal("WebGL2RenderingContext", undefined);
    expect(renderHook(() => usePipelineScreen()).result.current.space).toBe("srgb");
  });

  it("names the active monitor profile", () => {
    act(() =>
      useDisplayProfile.setState(
        {
          status: "active",
          path: "/icc/dell.icc",
          description: "Dell U2723QE",
          transform: { matrix: new Float32Array(9), curve: "srgb" },
        },
        true,
      ),
    );
    expect(renderHook(() => usePipelineScreen()).result.current.profile).toBe("Dell U2723QE");
  });
});
