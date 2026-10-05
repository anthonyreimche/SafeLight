// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension contributions: modules (tab order, built-in protection, labels),
// processing stages, and the per-extension sweep. Lives in the dom project
// because the registry's import graph reaches stores that expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  moduleLabel,
  moduleTabs,
  registerModule,
  registerProcessingStage,
  unregisterExtension,
  unregisterProcessingStage,
  useRegistry,
} from "./registry";
import { getParamDescriptor, unregisterStageParams } from "./param-registry";
import { BUILTIN_DENOISE_ID } from "@/rendering/webgl/builtin-denoise";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { CORE_EXTENSION_ID } from "./core-extension";
import { makeScopedAPI } from "./host";
import type { ProcessingPhase, ProcessingStageContribution } from "./types";

const View = () => null;

beforeEach(() => {
  useRegistry.setState({ modules: {} });
});

describe("registerModule", () => {
  it("lists the built-ins first, then registered modules by order, then label", () => {
    registerModule("ext.a", { id: "slideshow", label: "Slideshow", component: View, order: 200 });
    registerModule("ext.b", { id: "map", label: "Map", component: View, order: 100 });
    registerModule("ext.c", { id: "book", label: "Book", component: View, order: 100 });
    expect(moduleTabs().map((m) => m.id)).toEqual([
      "library",
      "develop",
      "book",
      "map",
      "slideshow",
    ]);
  });

  it("refuses the built-in ids", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerModule("ext", { id: "library", label: "Not Library", component: View });
    registerModule("ext", { id: "develop", label: "Not Develop", component: View });
    expect(useRegistry.getState().modules).toEqual({});
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("refuses an id that its pop-out window's URL and name cannot carry", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const id of ["My Map", "", "a&b", "a b"])
      registerModule("ext", { id, label: "Map", component: View });
    expect(useRegistry.getState().modules).toEqual({});
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it("re-registering an id replaces the earlier contribution", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    registerModule("ext", { id: "map", label: "Map 2", component: View });
    expect(moduleTabs().filter((m) => m.id === "map").map((m) => m.label)).toEqual(["Map 2"]);
  });

  it("labels built-ins and registered modules, and falls back to the id", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    expect(moduleLabel("library")).toBe("Library");
    expect(moduleLabel("develop")).toBe("Develop");
    expect(moduleLabel("map")).toBe("Map");
    expect(moduleLabel("print")).toBe("print");
  });

  it("is swept with the rest of the extension's contributions", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    registerModule("other", { id: "book", label: "Book", component: View });
    unregisterExtension("ext");
    expect(moduleTabs().map((m) => m.id)).toEqual(["library", "develop", "book"]);
  });
});

describe("registerProcessingStage: space and reads", () => {
  beforeEach(() => {
    useRegistry.setState({ processingStages: {} });
  });

  // Param descriptors live outside the registry state the hook above resets.
  afterEach(() => {
    unregisterStageParams("acme.stage");
  });

  const stage = (fields: Record<string, unknown>) =>
    // Plain-JS extensions can pass anything; the registry must cope.
    ({ id: "acme.stage", name: "Stage", phase: "scene-linear", glsl: "", uniforms: [], ...fields }) as Parameters<
      typeof registerProcessingStage
    >[1];

  it("refuses a stage whose space it can't honour", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessingStage("acme", stage({ space: { encoding: "log" } }));
    expect(useRegistry.getState().processingStages).toEqual({});
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("registers a stage asking for the current image without passes as a source reader, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", stage({ reads: "current" }));
    expect(useRegistry.getState().processingStages["acme.stage"]?.reads).toBe("source");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("keeps a valid space and reads as given", () => {
    registerProcessingStage(
      "acme",
      stage({ space: { encoding: "linear", primaries: "rec2020" }, reads: "current", passes: [{ glsl: "" }] }),
    );
    const s = useRegistry.getState().processingStages["acme.stage"];
    expect(s?.space).toEqual({ encoding: "linear", primaries: "rec2020" });
    expect(s?.reads).toBe("current");
  });

  it("does not register param descriptors for a refused stage, even if it declares uniforms", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessingStage(
      "acme",
      stage({
        uniforms: [{ key: "amount", glslType: "float", default: 0 }],
        space: { encoding: "log" },
      }),
    );
    expect(getParamDescriptor("acme.stage.amount")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("keeps the registered stage and its param descriptors when a re-registration is refused", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const original = stage({ uniforms: [{ key: "amount", glslType: "float", default: 0 }] });
    registerProcessingStage("acme", original);
    registerProcessingStage(
      "acme",
      stage({
        uniforms: [{ key: "other", glslType: "float", default: 0 }],
        space: { encoding: "log" },
      }),
    );
    expect(useRegistry.getState().processingStages["acme.stage"]?.uniforms).toEqual(
      original.uniforms,
    );
    expect(getParamDescriptor("acme.stage.amount")).toBeDefined();
    expect(getParamDescriptor("acme.stage.other")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });

  it("logs warnings for non-fatal contract issues and still registers the stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", stage({ space: { encoding: "linear", primary: "rec2020" } }));
    expect(useRegistry.getState().processingStages["acme.stage"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\[extensions\] acme:/);
    expect(warn.mock.calls[0][0]).toMatch(/primary/);
    warn.mockRestore();
  });
});

// Two parts of the contract the core doesn't act on. The stage still registers;
// the author hears about it.
describe("registerProcessingStage: parts of the contract the core ignores", () => {
  // Plain JavaScript can name any phase; the type lists only the real ones.
  const phaseNamed = (name: string): ProcessingPhase => name as ProcessingPhase;
  const plain = (over: Partial<ProcessingStageContribution>): ProcessingStageContribution => ({
    id: "acme.stage",
    name: "Stage",
    phase: "scene-linear",
    glsl: "",
    uniforms: [],
    ...over,
  });

  beforeEach(() => {
    useRegistry.setState({ processingStages: {} });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    unregisterStageParams("acme.stage");
  });

  it("warns about a reserved field, and still registers the stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", plain({ consumes: ["refT"] }));
    expect(useRegistry.getState().processingStages["acme.stage"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\[extensions\] acme: .*consumes is reserved/);
  });

  it("warns about a phase the pipeline doesn't have, and still registers the stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", plain({ phase: phaseNamed("post-effects") }));
    expect(useRegistry.getState().processingStages["acme.stage"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/phase "post-effects"/);
  });
});

// Ids under "core." and the built-in denoiser's id get core treatment in the
// injection, so only the core extension may register them. The extension id is
// the one place the registry learns who is registering.
describe("registerProcessingStage: Safelight's own stage ids", () => {
  const OWN = ["core.vignette", "core.grain", BUILTIN_DENOISE_ID];
  const registered = () => useRegistry.getState().processingStages;
  const plain = (id: string): ProcessingStageContribution => ({
    id,
    name: "Stage",
    phase: "scene-linear",
    glsl: "",
    uniforms: [],
  });
  const quiet = (method: "error" | "warn") =>
    vi.spyOn(console, method).mockImplementation(() => {});

  beforeEach(() => {
    useRegistry.setState({ processingStages: {} });
  });

  // Stage params live outside the registry state reset above.
  afterEach(() => {
    vi.restoreAllMocks();
    unregisterExtension(CORE_EXTENSION_ID);
    unregisterExtension("acme");
  });

  /** Runs the core extension's own activate through the scoped API, as boot does. */
  function activateCore(): void {
    const core = BUILTIN_EXTENSIONS.find((e) => e.id === CORE_EXTENSION_ID);
    if (!core) throw new Error("no core built-in extension");
    core.activate(makeScopedAPI(core.id));
  }

  it("lets the core extension register its own stages, without a complaint", () => {
    const error = quiet("error");
    const warn = quiet("warn");
    activateCore();
    for (const id of OWN) expect(registered()[id]?.extensionId, id).toBe(CORE_EXTENSION_ID);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(OWN)("refuses %s from any other extension, and says why", (id) => {
    const error = quiet("error");
    registerProcessingStage("acme", plain(id));
    expect(registered()[id]).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0][0]).toMatch(new RegExp(`acme: stage "${id}".*not registered`));
  });

  it("keeps the stage that holds the id, and its params, against another extension", () => {
    const error = quiet("error");
    activateCore();
    const vignette = registered()["core.vignette"];
    registerProcessingStage("acme", {
      ...plain("core.vignette"),
      glsl: "c = vec3(0.0);",
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    });
    expect(registered()["core.vignette"]).toBe(vignette);
    expect(getParamDescriptor("core.vignette.uVignetteAmount")).toBeDefined();
    expect(getParamDescriptor("core.vignette.amount")).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

// The renderer's injection memo and the render bridge both tell a stage change
// from "nothing changed" by comparing the processingStages object itself, so
// every change must hand out a new one, never edit it in place.
describe("processingStages identity", () => {
  beforeEach(() => {
    useRegistry.setState({ processingStages: {} });
  });

  const STAGE: ProcessingStageContribution = {
    id: "acme.stage",
    name: "Stage",
    phase: "scene-linear",
    glsl: "",
    uniforms: [],
  };

  it("is a new object after a stage registers", () => {
    const before = useRegistry.getState().processingStages;
    registerProcessingStage("acme", STAGE);
    expect(useRegistry.getState().processingStages).not.toBe(before);
  });

  it("is a new object when a stage registers again under the same id", () => {
    registerProcessingStage("acme", STAGE);
    const before = useRegistry.getState().processingStages;
    registerProcessingStage("acme", { ...STAGE, helpers: "float scale() { return 2.0; }" });
    expect(useRegistry.getState().processingStages).not.toBe(before);
  });

  it("is a new object after a stage unregisters", () => {
    registerProcessingStage("acme", STAGE);
    const before = useRegistry.getState().processingStages;
    unregisterProcessingStage("acme", "acme.stage");
    const after = useRegistry.getState().processingStages;
    expect(after).not.toBe(before);
    expect(after).toEqual({});
  });

  it("is a new object after an extension is swept", () => {
    registerProcessingStage("acme", STAGE);
    const before = useRegistry.getState().processingStages;
    unregisterExtension("acme");
    const after = useRegistry.getState().processingStages;
    expect(after).not.toBe(before);
    expect(after).toEqual({});
  });
});
