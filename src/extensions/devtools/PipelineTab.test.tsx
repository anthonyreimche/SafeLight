// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The tab reads the live stores: the registry's stages and transforms, and the
// open photo's version, masks and transform. These tests set the real stores
// and put them back after each test.

import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { DEFAULT_DEVELOP_PARAMS, defaultMaskAdjustments, type DevelopParams, type Mask } from "@/catalog/types";
import { useDisplayProfile } from "@/rendering/display-profile-store";
import { DENOISE_STAGE } from "@/rendering/webgl/builtin-denoise";
import { describePipeline } from "@/rendering/webgl/pipeline-description";
import { useDevelopStore } from "@/state/develop-store";
import { useRegistry } from "../registry";
import type { ProcessingPhase, ProcessingStageContribution } from "../types";
import { DevToolsPanel } from "./DevToolsPanel";
import { PipelineTab } from "./PipelineTab";

// Passed through, to count the builds: each one assembles the whole program.
vi.mock("@/rendering/webgl/pipeline-description", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/rendering/webgl/pipeline-description")>();
  return { ...real, describePipeline: vi.fn(real.describePipeline) };
});

const REGISTRY = useRegistry.getState();
const DEVELOP = useDevelopStore.getState();
const PROFILE = useDisplayProfile.getState();

afterEach(() => {
  useRegistry.setState(REGISTRY, true);
  useDevelopStore.setState(DEVELOP, true);
  useDisplayProfile.setState(PROFILE, true);
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

// A display stage that declares no space: version 2 clips its input to [0, 1].
const TINT: ProcessingStageContribution = {
  id: "acme.tint",
  name: "Tint",
  phase: "display-adjust",
  glsl: "c *= tintAmount;",
  uniforms: [{ key: "tintAmount", glslType: "float", default: 1 }],
};
const CLAMPED_TOOLS = ["Whites", "Blacks", "Contrast", "Dehaze"];

function register(...stages: ProcessingStageContribution[]): void {
  const processingStages = Object.fromEntries(stages.map((s) => [s.id, { ...s, extensionId: "acme" }]));
  act(() => useRegistry.setState({ processingStages }));
}

function openPhoto(params: Partial<DevelopParams>, photoId = "p1"): void {
  act(() => useDevelopStore.setState({ photoId, params: { ...DEFAULT_DEVELOP_PARAMS, ...params } }));
}

// Extensions are plain JavaScript and the registry only warns about a phase the
// table lacks, so a stage can reach the tab with one.
const unlistedPhase = (name: string): ProcessingPhase => name as ProcessingPhase;

/** The version button that is pressed. */
const shown = () =>
  ["v1", "v2", "v3"].find((v) => screen.getByRole("button", { name: v }).getAttribute("aria-pressed") === "true");

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

/** The list item a row heads (a core block, a stage, the output) or sits in. */
function item(text: string): HTMLLIElement {
  const li = screen.getByText(text).closest("li");
  if (!li) throw new Error(`"${text}" is in no list item`);
  return li;
}

const pick = (version: string) => fireEvent.click(screen.getByRole("button", { name: version }));

describe("PipelineTab", () => {
  it("lists a legacy display stage with the clip ahead of it, and the input clips of the tools that need [0, 1]", () => {
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    register(TINT);
    const tint = item("Tint");
    expect(within(tint).getByText("acme.tint")).toBeTruthy();
    expect(within(tint).getByText("input · always")).toBeTruthy();
    expect(within(tint).getByText(/Tint declares no space/)).toBeTruthy();
    for (const tool of CLAMPED_TOOLS) {
      expect(within(item(tool)).queryByText("input · while in use"), tool).not.toBeNull();
    }
  });

  it("shows the version picked: version 1 clips after the transform, version 3 maps the output", () => {
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    const afterTransform = () => item("Transform: Built-in").nextElementSibling?.textContent ?? null;
    expect(afterTransform()).toBeNull();

    pick("v1");
    for (const tool of CLAMPED_TOOLS) {
      expect(within(item(tool)).queryByText("input · while in use"), tool).toBeNull();
    }
    expect(afterTransform()).toMatch(/^result · always/);

    pick("v3");
    const output = item("Output");
    expect(within(output).getByText("mapped")).toBeTruthy();
    expect(output.textContent).toContain("On this screen: sRGB");
  });

  it("shows the denoiser's luma floor on its row, and the Heal copy's clip as each version makes it", () => {
    register(DENOISE_STAGE);
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    expect(within(item("builtin.denoise")).getByText("result · while in use")).toBeTruthy();
    expect(within(item("Heal")).getByText("result · only without float render targets or mipmaps")).toBeTruthy();
    pick("v1");
    expect(within(item("Heal")).getByText("result · while in use")).toBeTruthy();
  });

  it("shows a floor found in a stage's GLSL", () => {
    openPhoto({ processVersion: 2 });
    register({ id: "acme.film", name: "Film", phase: "scene-linear", glsl: "lin = max(lin, 0.0);", uniforms: [] });
    render(<PipelineTab />);
    expect(within(item("Film")).getByText("found in GLSL: max(lin, 0.0)")).toBeTruthy();
  });

  it("marks a maskable stage the photo's masks run again, with the number of copies", () => {
    register({ ...TINT, id: "acme.wash", name: "Wash", mask: { maskable: true } });
    openPhoto({ processVersion: 2, masks: ["a", "b"].map((id) => mask(id, { "acme.wash.tintAmount": 0.5 })) });
    render(<PipelineTab />);
    const wash = item("Wash");
    expect(within(wash).getByText("per mask, 2 copies")).toBeTruthy();
    expect(wash.textContent).toContain("Runs again inside 2 masks");
  });

  it("says whether the version shown honours the transform's skipToneShoulder", () => {
    const filmic = {
      id: "acme.filmic",
      name: "Filmic",
      glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin / (1.0 + lin); }",
      skipToneShoulder: true,
      extensionId: "acme",
    };
    openPhoto({ processVersion: 1, displayTransform: filmic.id });
    render(<PipelineTab />);
    expect(screen.getByText("Transform: Built-in")).toBeTruthy();
    act(() => useRegistry.setState({ pipelines: { [filmic.id]: filmic } }));
    expect(screen.getByText("Transform: acme.filmic")).toBeTruthy();
    expect(screen.getByText("skipToneShoulder: ignored on this version")).toBeTruthy();
    pick("v2");
    expect(screen.getByText("skipToneShoulder: honoured")).toBeTruthy();
  });

  it("is a Developer Tools tab, showing the current version while no photo is open", () => {
    render(<DevToolsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Pipeline" }));
    expect(screen.getByRole("list", { name: "Pipeline" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "v2" }).getAttribute("aria-pressed")).toBe("true");
  });

  // A typo in a phase must not take the whole Developer Tools panel down with
  // it: the Console that holds the registry's warning is in the same panel.
  it("lists a stage naming a phase the table lacks among scene values, as the injector treats it", () => {
    openPhoto({ processVersion: 2 });
    register({ id: "acme.odd", name: "Odd", phase: unlistedPhase("post-effects"), glsl: "lin *= 2.0;", uniforms: [] });
    render(<PipelineTab />);
    const odd = item("Odd");
    expect(within(odd).getByText("post-effects, priority 100")).toBeTruthy();
    expect(within(odd).getByText("scene values")).toBeTruthy();
  });

  it("forgets a version pick once its photo is left", () => {
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    pick("v3");
    expect(shown()).toBe("v3");
    openPhoto({ processVersion: 2 }, "p2");
    expect(shown()).toBe("v2");
    openPhoto({ processVersion: 2 }, "p1");
    expect(shown()).toBe("v2");
  });

  it("names the screen's space on a version 3 frame where the drawing buffer can be tagged", () => {
    onP3Screen(true);
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    pick("v3");
    expect(item("Output").textContent).toContain("On this screen: Display P3");
  });

  it("names sRGB where the drawing buffer can't be tagged, as the renderer encodes it", () => {
    onP3Screen(false);
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    pick("v3");
    expect(item("Output").textContent).toContain("On this screen: sRGB");
  });

  it("names sRGB where there is no WebGL2 at all", () => {
    onP3Screen(true);
    vi.stubGlobal("WebGL2RenderingContext", undefined);
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    pick("v3");
    expect(item("Output").textContent).toContain("On this screen: sRGB");
  });

  it("names the monitor profile whether or not the drawing buffer can be tagged", () => {
    onP3Screen(false);
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
    openPhoto({ processVersion: 2 });
    render(<PipelineTab />);
    pick("v3");
    expect(item("Output").textContent).toContain("On this screen: Dell U2723QE (monitor profile)");
  });

  it("says no photo is open in the docked panel when none is", () => {
    render(<PipelineTab />);
    expect(screen.getByText("No photo open")).toBeTruthy();
  });

  it("asks for the panel to be docked in the popped-out window, which can't see the open photo", () => {
    window.history.replaceState({}, "", "/?devtools=1");
    render(<PipelineTab />);
    expect(screen.getByText("Dock Developer Tools to see the open photo.")).toBeTruthy();
    expect(screen.queryByText("No photo open")).toBeNull();
  });

  it("doesn't render again for an edit that leaves the version, masks and transform alone", () => {
    openPhoto({ processVersion: 2 });
    let commits = 0;
    render(
      <Profiler id="pipeline" onRender={() => commits++}>
        <PipelineTab />
      </Profiler>,
    );
    const before = commits;
    act(() => {
      const { params } = useDevelopStore.getState();
      useDevelopStore.setState({ params: { ...params, exposure: 1 } });
    });
    expect(commits).toBe(before);
    act(() => {
      const { params } = useDevelopStore.getState();
      useDevelopStore.setState({ params: { ...params, masks: [mask("a", {})] } });
    });
    expect(commits).toBeGreaterThan(before);
  });

  // Every brush dab replaces the photo's masks, but the program changes only
  // when the copies they call for do.
  it("rebuilds the rows for a mask edit only when it changes the mask copies", () => {
    register({ ...TINT, id: "acme.wash", name: "Wash", mask: { maskable: true } });
    const a = mask("a", { "acme.wash.tintAmount": 0.5 });
    openPhoto({ processVersion: 2, masks: [a] });
    render(<PipelineTab />);
    const builds = vi.mocked(describePipeline);
    expect(builds).toHaveBeenCalled();
    builds.mockClear();
    const setMasks = (masks: Mask[]) =>
      act(() => {
        const { params } = useDevelopStore.getState();
        useDevelopStore.setState({ params: { ...params, masks } });
      });

    setMasks([{ ...a, opacity: 50 }]);
    expect(builds).not.toHaveBeenCalled();

    setMasks([a, mask("b", { "acme.wash.tintAmount": 0.2 })]);
    expect(builds).toHaveBeenCalledTimes(1);
    expect(within(item("Wash")).getByText("per mask, 2 copies")).toBeTruthy();
  });
});
