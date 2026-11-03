// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension contributions: modules (tab order, official ids, labels),
// processing stages, and the per-extension sweep. Lives in the dom project
// because the registry's import graph reaches stores that expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROBE_BUILTIN_ID, installProbeBuiltin } from "./builtin.test-support";
import {
  collectPresetStages,
  emitEditCommit,
  emitMetadataChange,
  emitPhotoImport,
  emitPhotoRemove,
  fallbackModule,
  hasModule,
  moduleLabel,
  moduleTabs,
  panelTitle,
  registerExportProcessor,
  registerFilenameTemplate,
  registerGridFilter,
  registerGridMenuItem,
  registerLayout,
  registerLibrarySort,
  registerModule,
  registerPanel,
  registerPanelHeaderAccessory,
  registerPipeline,
  registerPresetImporter,
  registerCatalogHooks,
  registerProcessingStage,
  registerSliderIcon,
  registerSlot,
  registerStylesheet,
  registerTheme,
  runGridFilterClears,
  unregisterExtension,
  unregisterProcessingStage,
  useRegistry,
} from "./registry";
import { getStageTextures, setStageTexture } from "@/rendering/render-bridge";
import { CALLBACK_FAILURE_LIMIT, CATALOG_HOOK_TIMEOUT_MS, useCallbackFailures } from "./guard";
import { getAllDescriptors, getParamDescriptor, setExtensionName, unregisterStageParams } from "./param-registry";
import { BUILTIN_DENOISE_ID } from "@/rendering/webgl/builtin-denoise";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { CORE_EXTENSION_ID } from "./core-extension";
import { extensionKinds, forgetExtension } from "./extension-kinds";
import { makeScopedAPI } from "./host";
import type {
  ExportProcessorContribution,
  PanelContribution,
  ProcessingPhase,
  ProcessingStageContribution,
  StageTextureData,
} from "./types";

const View = () => null;

beforeEach(() => {
  useRegistry.setState({ modules: {} });
});

// Every import and save waits on the catalogue hooks, one after another, so one
// that throws or never finishes is logged and skipped and the rest still run.
describe("catalogue hooks", () => {
  const importCtx = {} as Parameters<typeof emitPhotoImport>[0];
  const metadataCtx = {} as Parameters<typeof emitMetadataChange>[0];
  const editCtx = {} as Parameters<typeof emitEditCommit>[0];
  const removeCtx = {} as Parameters<typeof emitPhotoRemove>[0];
  const hang = () => new Promise<never>(() => {});
  const timedOut = new Error(`acme.stuck did not finish within ${CATALOG_HOOK_TIMEOUT_MS / 1000} s`);
  const fail = (): never => {
    throw new Error("boom");
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    unregisterExtension("acme.stuck");
    unregisterExtension("acme.broken");
    unregisterExtension("acme.fine");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("skip a handler that throws or never finishes and run the rest", async () => {
    const fine = {
      onMetadataChange: vi.fn(async () => {}),
      onEditCommit: vi.fn(async () => {}),
      onPhotoRemove: vi.fn(async () => {}),
    };
    registerCatalogHooks("acme.stuck", {
      id: "acme.stuck.hooks",
      onPhotoImport: hang,
      onMetadataChange: hang,
      onEditCommit: hang,
      onPhotoRemove: hang,
    });
    registerCatalogHooks("acme.broken", {
      id: "acme.broken.hooks",
      onPhotoImport: fail,
      onMetadataChange: fail,
      onEditCommit: fail,
      onPhotoRemove: fail,
    });
    // A slow lookup, such as a geocoder, that takes longer than a start may.
    const slow = () =>
      new Promise<{ label: "red" }>((resolve) => setTimeout(() => resolve({ label: "red" }), 20_000));
    registerCatalogHooks("acme.fine", {
      id: "acme.fine.hooks",
      onPhotoImport: async () => ({ rating: 3, ...(await slow()) }),
      ...fine,
    });

    let settled = false;
    const run = Promise.all([
      emitPhotoImport(importCtx),
      emitMetadataChange(metadataCtx),
      emitEditCommit(editCtx),
      emitPhotoRemove(removeCtx),
    ]).finally(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CATALOG_HOOK_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(CATALOG_HOOK_TIMEOUT_MS);

    const [merged] = await run;
    expect(merged).toEqual({ rating: 3, label: "red" });
    expect(fine.onMetadataChange).toHaveBeenCalledWith(metadataCtx);
    expect(fine.onEditCommit).toHaveBeenCalledWith(editCtx);
    expect(fine.onPhotoRemove).toHaveBeenCalledWith(removeCtx);
    expect(console.warn).toHaveBeenCalledWith(
      "[ext:acme.stuck] onPhotoImport timed out; its catalogue hooks are skipped until it is reloaded:",
      timedOut,
    );
    expect(console.warn).toHaveBeenCalledWith("[ext:acme.broken] onPhotoImport failed:", new Error("boom"));
  });

  // An import calls onPhotoImport once per photo, so an extension whose hook
  // hung once would otherwise cost every photo after it the whole wait.
  it("skip an extension's hooks once one timed out, until it registers them again", async () => {
    const stuck = {
      id: "acme.stuck.hooks",
      onPhotoImport: vi.fn(hang),
      onEditCommit: vi.fn(async () => {}),
    };
    registerCatalogHooks("acme.stuck", stuck);
    registerCatalogHooks("acme.fine", { id: "acme.fine.hooks", onPhotoImport: async () => ({ rating: 3 }) });

    const first = emitPhotoImport(importCtx);
    await vi.advanceTimersByTimeAsync(CATALOG_HOOK_TIMEOUT_MS);
    await first;

    await expect(emitPhotoImport(importCtx)).resolves.toEqual({ rating: 3 });
    await emitEditCommit(editCtx);
    expect(stuck.onPhotoImport).toHaveBeenCalledOnce();
    expect(stuck.onEditCommit).not.toHaveBeenCalled();
    expect(vi.mocked(console.warn).mock.calls.filter(([m]) => String(m).includes("acme.stuck"))).toHaveLength(1);

    registerCatalogHooks("acme.stuck", stuck);
    await emitEditCommit(editCtx);
    expect(stuck.onEditCommit).toHaveBeenCalledWith(editCtx);
  });
});

describe("registerModule", () => {
  it("lists Library and Develop first, then the other modules by order, then label", () => {
    registerModule("ext.a", { id: "slideshow", label: "Slideshow", component: View, order: 200 });
    registerModule("safelight.develop", { id: "develop", label: "Develop", component: View });
    registerModule("ext.b", { id: "map", label: "Map", component: View, order: 100 });
    registerModule("ext.c", { id: "book", label: "Book", component: View, order: -5 });
    registerModule("safelight.library", { id: "library", label: "Library", component: View });
    expect(moduleTabs().map((m) => m.id)).toEqual([
      "library",
      "develop",
      "book",
      "map",
      "slideshow",
    ]);
  });

  it("accepts Library and Develop only from the official extension its list row names", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerModule("ext", { id: "library", label: "Not Library", component: View });
    registerModule("ext", { id: "develop", label: "Not Develop", component: View });
    registerModule("safelight.develop", { id: "library", label: "Not Library", component: View });
    registerModule("safelight.library", { id: "develop", label: "Not Develop", component: View });
    expect(useRegistry.getState().modules).toEqual({});
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();

    registerModule("safelight.library", { id: "library", label: "Library", component: View });
    registerModule("safelight.develop", { id: "develop", label: "Develop", component: View });
    expect(moduleTabs().map((m) => m.id)).toEqual(["library", "develop"]);
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

  it("labels registered modules, and falls back to the id", () => {
    registerModule("safelight.library", { id: "library", label: "Library", component: View });
    registerModule("ext", { id: "map", label: "Map", component: View });
    expect(moduleLabel("library")).toBe("Library");
    expect(moduleLabel("map")).toBe("Map");
    expect(moduleLabel("develop")).toBe("develop");
  });

  it("is swept with the rest of the extension's contributions", () => {
    registerModule("ext", { id: "map", label: "Map", component: View });
    registerModule("other", { id: "book", label: "Book", component: View });
    unregisterExtension("ext");
    expect(moduleTabs().map((m) => m.id)).toEqual(["book"]);
    expect(hasModule("map")).toBe(false);
    expect(hasModule("book")).toBe(true);
  });
});

describe("fallbackModule", () => {
  it("is the first tab other than the one that went away", () => {
    registerModule("safelight.library", { id: "library", label: "Library", component: View });
    registerModule("safelight.develop", { id: "develop", label: "Develop", component: View });
    registerModule("ext", { id: "map", label: "Map", component: View });
    expect(fallbackModule()).toBe("library");
    expect(fallbackModule("library")).toBe("develop");
  });

  it("is the first other module without Library and Develop", () => {
    registerModule("ext.b", { id: "map", label: "Map", component: View });
    registerModule("ext.a", { id: "book", label: "Book", component: View });
    expect(fallbackModule()).toBe("book");
    expect(fallbackModule("book")).toBe("map");
  });

  it("is null when there is no other tab", () => {
    expect(fallbackModule()).toBeNull();
    registerModule("ext", { id: "map", label: "Map", component: View });
    expect(fallbackModule("map")).toBeNull();
  });
});

describe("panelTitle", () => {
  beforeEach(() => useRegistry.setState({ panels: {} }));

  it("names an extension's only panel after the extension", () => {
    setExtensionName("vectorscope", "Vectorscope");
    registerPanel("vectorscope", { id: "vectorscope.panel", title: "Scopes", component: View });
    expect(panelTitle(useRegistry.getState().panels, "vectorscope.panel")).toBe("Vectorscope");
  });

  it("keeps each panel's own title when the extension has several", () => {
    setExtensionName("acme", "Acme Tools");
    registerPanel("acme", { id: "acme.one", title: "One", component: View });
    registerPanel("acme", { id: "acme.two", title: "Two", component: View });
    const panels = useRegistry.getState().panels;
    expect(panelTitle(panels, "acme.one")).toBe("One");
    expect(panelTitle(panels, "acme.two")).toBe("Two");
  });

  it("keeps the panel's title when the extension's name is unknown, and the id for no panel", () => {
    registerPanel("nameless", { id: "nameless.panel", title: "Nameless", component: View });
    const panels = useRegistry.getState().panels;
    expect(panelTitle(panels, "nameless.panel")).toBe("Nameless");
    expect(panelTitle(panels, "gone")).toBe("gone");
  });
});

// Preview-off resets each owned key to its default every frame, so a key with
// no default would throw there.
describe("registerPanel: owns", () => {
  beforeEach(() => useRegistry.setState({ panels: {} }));
  afterEach(() => vi.restoreAllMocks());

  it("keeps the develop params a panel owns and drops unknown keys, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const owns = ["exposure", "nope", "vignette"] as unknown as PanelContribution["owns"];
    registerPanel("acme", { id: "acme.tone", title: "Tone", component: View, owns });
    expect(useRegistry.getState().panels["acme.tone"].owns).toEqual(["exposure", "vignette"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"nope"'));
  });

  it("drops an owns that isn't a list, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const owns = "exposure" as unknown as PanelContribution["owns"];
    registerPanel("acme", { id: "acme.tone", title: "Tone", component: View, owns });
    expect(useRegistry.getState().panels["acme.tone"].owns).toBeUndefined();
    expect(warn).toHaveBeenCalled();
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
    unregisterStageParams("acme.first");
  });

  it("registers a maskable stage, keeping its mask field", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", plain({ mask: { maskable: true } }));
    expect(useRegistry.getState().processingStages["acme.stage"]?.mask).toEqual({ maskable: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns about a mask its phase can't have, and still registers the stage", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerProcessingStage("acme", plain({ phase: "decode", mask: { maskable: true } }));
    expect(useRegistry.getState().processingStages["acme.stage"]).toBeDefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/\[extensions\] acme: .*decode stages run before mask coverage/);
  });

  it("refuses a stage producing a variable another stage produces", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessingStage("acme", plain({ id: "acme.first", produces: [{ name: "shared", glslType: "float" }] }));
    registerProcessingStage("other", plain({ id: "other.second", produces: [{ name: "shared", glslType: "float" }] }));
    expect(useRegistry.getState().processingStages["acme.first"]).toBeDefined();
    expect(useRegistry.getState().processingStages["other.second"]).toBeUndefined();
    expect(error.mock.calls[0][0]).toMatch(
      /\[extensions\] other: stage "other\.second": inter-stage variable "shared" is already produced by stage "acme\.first"; stage not registered/,
    );
  });

  it("lets a stage re-register with the variable it already produces", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const producer = plain({ produces: [{ name: "mine", glslType: "vec2", producer: "vec2(1.0)" }] });
    registerProcessingStage("acme", producer);
    registerProcessingStage("acme", { ...producer, glsl: "lin *= 2.0;" });
    expect(useRegistry.getState().processingStages["acme.stage"]?.glsl).toBe("lin *= 2.0;");
    expect(error).not.toHaveBeenCalled();
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
  const OWN = [BUILTIN_DENOISE_ID];
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

  it("leaves Safelight's own stages out of the preset fields, and lists an extension's", () => {
    activateCore();
    registerProcessingStage("acme", {
      ...plain("acme.look"),
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    });
    expect(collectPresetStages({}).map((s) => s.stageId)).toEqual(["acme.look"]);
  });

  // A built-in is one of BUILTIN_EXTENSIONS, whatever its id: the official
  // extensions that replace them keep ids outside "core" and their stage params
  // are preset fields like any other extension's.
  it("leaves a built-in's stages out of the preset fields by membership, not by id", () => {
    const look = (id: string): ProcessingStageContribution => ({
      ...plain(id),
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    });
    const probe = installProbeBuiltin();
    registerProcessingStage(PROBE_BUILTIN_ID, look("probe.look"));
    registerProcessingStage("core.unlisted", look("unlisted.look"));
    try {
      expect(collectPresetStages({}).map((s) => s.stageId)).toEqual(["unlisted.look"]);
    } finally {
      unregisterExtension(PROBE_BUILTIN_ID);
      unregisterExtension("core.unlisted");
      probe.remove();
    }
  });

  it("keeps the stage that holds the id, and its params, against another extension", () => {
    const error = quiet("error");
    activateCore();
    const denoise = registered()[BUILTIN_DENOISE_ID];
    expect(denoise).toBeDefined();
    registerProcessingStage("acme", {
      ...plain(BUILTIN_DENOISE_ID),
      glsl: "c = vec3(0.0);",
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    });
    expect(registered()[BUILTIN_DENOISE_ID]).toBe(denoise);
    expect(getParamDescriptor(`${BUILTIN_DENOISE_ID}.amount`)).toBeUndefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

// A stage that derives its values (Safelight's own, an official extension's)
// takes them from the photo's DevelopParams: they never ride the param bag, so
// they are no bag params (preset fields, mask-copy seeds, api.params).
describe("registerProcessingStage: derived values", () => {
  const AMOUNT = { key: "uAmount", glslType: "float", default: 0 } as const;
  const stage = (derive?: ProcessingStageContribution["derive"]): ProcessingStageContribution => ({
    id: "safelight.effects.look",
    name: "Look",
    phase: "effects",
    glsl: "",
    uniforms: [AMOUNT],
    ...(derive ? { derive } : {}),
  });

  beforeEach(() => {
    useRegistry.setState({ processingStages: {} });
  });

  afterEach(() => {
    unregisterExtension("safelight.effects");
    unregisterExtension(CORE_EXTENSION_ID);
  });

  it("registers no params for an official stage that derives them", () => {
    registerProcessingStage("safelight.effects", stage(() => ({ uAmount: 1 })));
    expect(useRegistry.getState().processingStages["safelight.effects.look"]).toBeDefined();
    expect(getParamDescriptor("safelight.effects.look.uAmount")).toBeUndefined();
    expect(collectPresetStages({})).toEqual([]);
  });

  it("registers an official stage's params when it derives none", () => {
    registerProcessingStage("safelight.effects", stage());
    expect(getParamDescriptor("safelight.effects.look.uAmount")).toBeDefined();
  });

  it("registers none for the core extension's stages", () => {
    const core = BUILTIN_EXTENSIONS.find((e) => e.id === CORE_EXTENSION_ID);
    if (!core) throw new Error("no core built-in extension");
    core.activate(makeScopedAPI(core.id));
    expect([...getAllDescriptors().values()].filter((d) => d.extensionId === CORE_EXTENSION_ID)).toEqual([]);
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

// An export processor works on the pixels before encode, on the encoded file,
// or both; one that declares neither has nothing to run.
describe("registerExportProcessor", () => {
  beforeEach(() => {
    useRegistry.setState({ exportProcessors: {} });
    forgetExtension("acme");
  });

  it("registers a processor with only a pixel hook", () => {
    const processPixels = async () => undefined;
    registerExportProcessor("acme", { id: "acme.mat", label: "Mat", processPixels });
    expect(useRegistry.getState().exportProcessors["acme.mat"]).toMatchObject({
      processPixels,
      extensionId: "acme",
      order: 0,
    });
    expect(extensionKinds().acme).toBe("pixels");
  });

  // Plain JavaScript can declare a method that isn't a function.
  it("refuses a processor with neither process nor processPixels as a function, naming it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerExportProcessor("acme", { id: "acme.nothing", label: "Nothing" });
    const broken = { id: "acme.broken", label: "Broken", process: "watermark" };
    registerExportProcessor("acme", broken as unknown as ExportProcessorContribution);
    expect(useRegistry.getState().exportProcessors).toEqual({});
    expect(warn.mock.calls.map((call) => call[0])).toEqual([
      expect.stringMatching(/\[extensions\] acme: .*"acme\.nothing" declares neither process nor processPixels as a function/),
      expect.stringMatching(/\[extensions\] acme: .*"acme\.broken" declares neither process nor processPixels as a function/),
    ]);
    // A refused processor renders nothing, so saved layouts may still switch its extension.
    expect(Object.hasOwn(extensionKinds(), "acme")).toBe(false);
    warn.mockRestore();
  });
});

// An id names one contribution for the whole app, so the extension that holds
// it keeps it: another extension registering the same id is refused with a
// warning, and the holder re-registering is how an update replaces its own.
describe("register*: contribution ids belong to their extension", () => {
  type RegistryKey = keyof ReturnType<typeof useRegistry.getState>;
  const stageParts: Omit<ProcessingStageContribution, "id"> = { name: "Stage", phase: "scene-linear", glsl: "", uniforms: [] };
  const kinds: [string, RegistryKey, (owner: string, id: string, tag: string) => void][] = [
    ["registerPanel", "panels", (o, id, tag) => registerPanel(o, { id, title: tag, component: View })],
    ["registerTheme", "themes", (o, id, tag) => registerTheme(o, { id, name: tag, vars: {} })],
    ["registerSliderIcon", "sliderIcons", (o, id, tag) => registerSliderIcon(o, { id, svg: tag })],
    ["registerLayout", "layouts", (o, id, tag) => registerLayout(o, { id, name: tag })],
    ["registerModule", "modules", (o, id, tag) => registerModule(o, { id, label: tag, component: View })],
    ["registerPipeline", "pipelines", (o, id, tag) => registerPipeline(o, { id, name: tag })],
    ["registerExportProcessor", "exportProcessors", (o, id, tag) =>
      registerExportProcessor(o, { id, label: tag, processPixels: async () => undefined })],
    ["registerFilenameTemplate", "filenameTemplates", (o, id, tag) =>
      registerFilenameTemplate(o, { id, label: tag, template: tag })],
    ["registerProcessingStage", "processingStages", (o, id, tag) =>
      registerProcessingStage(o, { ...stageParts, id, name: tag })],
    ["registerCatalogHooks", "catalogHooks", (o, id) => registerCatalogHooks(o, { id })],
    ["registerPresetImporter", "presetImporters", (o, id, tag) =>
      registerPresetImporter(o, { id, label: tag, extensions: [".xmp"], parse: async () => null })],
    ["registerGridFilter", "gridFilters", (o, id) => registerGridFilter(o, { id, test: () => true })],
    ["registerGridMenuItem", "gridMenuItems", (o, id, tag) =>
      registerGridMenuItem(o, { id, label: tag, onClick: () => {} })],
    ["registerSlot", "slots", (o, id) => registerSlot(o, { id, slot: "library-toolbar", component: View })],
    ["registerPanelHeaderAccessory", "panelHeaderAccessories", (o, id) =>
      registerPanelHeaderAccessory(o, { id, component: View })],
    ["registerLibrarySort", "librarySorts", (o, id, tag) =>
      registerLibrarySort(o, { id, label: tag, compare: () => 0 })],
    ["registerStylesheet", "stylesheets", (o, id, tag) => registerStylesheet(o, { id, css: tag })],
  ];

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    unregisterExtension("acme");
    unregisterExtension("other");
    unregisterExtension(CORE_EXTENSION_ID);
    forgetExtension("acme");
    forgetExtension("other");
  });

  const held = (key: RegistryKey, id: string) =>
    (useRegistry.getState()[key] as Record<string, { extensionId: string }>)[id];

  it.each(kinds)("%s keeps the first owner's contribution and names both owners", (call, key, register) => {
    register("acme", "shared.id", "first");
    const before = held(key, "shared.id");
    register("other", "shared.id", "second");
    expect(held(key, "shared.id")).toBe(before);
    expect(held(key, "shared.id").extensionId).toBe("acme");
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(
      new RegExp(`other.*"shared\\.id".*acme.*${call} ignored`),
    ));
  });

  it.each(kinds)("%s lets the owner register its id again, replacing the earlier one", (_call, key, register) => {
    register("acme", "shared.id", "first");
    const before = held(key, "shared.id");
    register("acme", "shared.id", "second");
    expect(held(key, "shared.id")).not.toBe(before);
    expect(held(key, "shared.id").extensionId).toBe("acme");
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("protects the core extension's contributions the same way", () => {
    registerTheme(CORE_EXTENSION_ID, { id: "core.theme", name: "Core", vars: {} });
    registerTheme("acme", { id: "core.theme", name: "Hijack", vars: {} });
    expect(useRegistry.getState().themes["core.theme"]).toMatchObject({ extensionId: CORE_EXTENSION_ID, name: "Core" });
  });

  it("lets an id that only inherits from Object.prototype register", () => {
    registerPanel("acme", { id: "constructor", title: "Odd", component: View });
    expect(held("panels", "constructor")?.extensionId).toBe("acme");
  });

  it("frees an id when its extension is swept", () => {
    registerSlot("acme", { id: "shared.id", slot: "library-toolbar", component: View });
    unregisterExtension("acme");
    registerSlot("other", { id: "shared.id", slot: "library-toolbar", component: View });
    expect(useRegistry.getState().slots["shared.id"]?.extensionId).toBe("other");
  });

  it("does not mark an extension as rendering pixels for a stage or transform that is refused", () => {
    registerProcessingStage("acme", { ...stageParts, id: "shared.stage" });
    registerProcessingStage("other", { ...stageParts, id: "shared.stage" });
    registerProcessingStage("other", { ...stageParts, id: "other.bad", space: { encoding: "log" } } as unknown as ProcessingStageContribution);
    registerPipeline("other", { id: "other.bad", name: "Bad", params: [{ key: "gain", glslType: "float", default: 1 }] });
    expect(Object.hasOwn(extensionKinds(), "other")).toBe(false);
  });

  it("keeps a refused stage's params with the stage that holds the id", () => {
    registerProcessingStage("acme", {
      ...stageParts,
      id: "shared.stage",
      uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    });
    registerProcessingStage("other", { ...stageParts, id: "shared.stage" });
    expect(getParamDescriptor("shared.stage.amount")?.extensionId).toBe("acme");
  });
});

// A stage's textures ride the stage, so only the extension that registered the
// stage may set them.
describe("setStageTexture: stage textures belong to the stage's extension", () => {
  const tex: StageTextureData = { data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, format: "rgba8", version: 1 };
  const stage: ProcessingStageContribution = {
    id: "acme.film",
    name: "Film",
    phase: "scene-linear",
    glsl: "",
    uniforms: [],
  };

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    registerProcessingStage("acme", stage);
  });
  afterEach(() => {
    for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
    vi.restoreAllMocks();
    unregisterExtension("acme");
    unregisterExtension("other");
    forgetExtension("acme");
    forgetExtension("other");
  });

  it("sets a texture on a stage the extension registered", () => {
    makeScopedAPI("acme").setStageTexture("acme.film", "lut", tex);
    expect(getStageTextures()["acme.film.lut"]).toBe(tex);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("refuses to set or clear a texture on another extension's stage, and says so", () => {
    makeScopedAPI("acme").setStageTexture("acme.film", "lut", tex);
    const other = makeScopedAPI("other");
    other.setStageTexture("acme.film", "lut", { ...tex, version: 2 });
    other.setStageTexture("acme.film", "lut", null);
    expect(getStageTextures()["acme.film.lut"]).toBe(tex);
    expect(console.warn).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/other.*"acme\.film".*acme.*setStageTexture ignored/));
  });

  it("refuses a texture for a stage nobody registered", () => {
    makeScopedAPI("acme").setStageTexture("acme.unknown", "lut", tex);
    expect(getStageTextures()["acme.unknown.lut"]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses a key that spills into a longer stage id another extension holds", () => {
    registerProcessingStage("other", { ...stage, id: "acme.film.grade" });
    makeScopedAPI("acme").setStageTexture("acme.film", "grade.lut", tex);
    expect(getStageTextures()["acme.film.grade.lut"]).toBeUndefined();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("lets the extension clear its textures after unregistering the stage", () => {
    const api = makeScopedAPI("acme");
    api.setStageTexture("acme.film", "lut", tex);
    api.unregisterProcessingStage("acme.film");
    api.setStageTexture("acme.film", "lut", null);
    expect(getStageTextures()["acme.film.lut"]).toBeUndefined();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("runGridFilterClears", () => {
  it(`stops calling an onClear after ${CALLBACK_FAILURE_LIMIT} throws, and calls it on its filter`, () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const onClear = vi.fn(function (this: { id: string }) {
      throw new Error(`broken clear of ${this.id}`);
    });
    registerGridFilter("acme.clear", { id: "acme.clear.filter", test: () => true, onClear });
    try {
      for (let i = 0; i < CALLBACK_FAILURE_LIMIT + 2; i++) runGridFilterClears();
      expect(onClear).toHaveBeenCalledTimes(CALLBACK_FAILURE_LIMIT);
      expect(useCallbackFailures.getState()["acme.clear"]?.error).toBe("broken clear of acme.clear.filter");
    } finally {
      unregisterExtension("acme.clear");
      error.mockRestore();
    }
  });
});
