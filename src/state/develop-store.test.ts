// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The edit store's history contract: what loadEdit restores from a stored
// stack, what commitEdit snapshots, and how undo/redo step through it. The
// renderer broadcast and the grid-thumbnail regen are edge side effects, so
// they're stubbed and observed; catalog persistence runs against an in-memory
// CatalogStorage, and the extension hook against a real registry entry.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./broadcast", () => ({
  broadcast: vi.fn(),
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));
vi.mock("./edited-thumbnail", () => ({ regenerateEditedThumbnail: vi.fn() }));

import { useDevelopStore } from "./develop-store";
import { broadcast } from "./broadcast";
import { regenerateEditedThumbnail } from "./edited-thumbnail";
import { useCatalogStore } from "./catalog-store";
import { setCatalogStorage } from "@/catalog/storage";
import { installMemoryStorage, photo, type MemoryEdits } from "@/catalog/stored-edit.fixtures";
import { registerCatalogHooks, useRegistry } from "@/extensions/registry";
import {
  registerStageParams,
  unregisterStageParams,
} from "@/extensions/param-registry";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_MASK_PANELS,
  LEGACY_PROCESS_VERSION,
  NEUTRAL_TEMPERATURE_K,
  defaultMaskAdjustments,
  freshParams,
  normalizeParams,
} from "@/catalog/types";
import type {
  BrushDab,
  DevelopParams,
  EditSnapshot,
  EditState,
  Mask,
  RetouchSpot,
} from "@/catalog/types";
import type { CatalogHooksContribution } from "@/extensions/types";

type EditCommitCtx = Parameters<
  NonNullable<CatalogHooksContribution["onEditCommit"]>
>[0];

const PHOTO_ID = "photo-1";

const snapshot =(label: string, params: Partial<DevelopParams>): EditSnapshot => ({
  timestamp: 1_700_000_000_000,
  label,
  params: normalizeParams(params),
  paramBag: {},
});

// A snapshot written by an older build: the on-disk shape is looser than
// today's DevelopParams, which is exactly what normalizeParams exists for.
const legacySnapshot = (
  label: string,
  params: Partial<DevelopParams>,
  paramBag?: Record<string, unknown>,
): EditSnapshot => ({
  timestamp: 1_700_000_000_000,
  label,
  params: params as DevelopParams,
  paramBag,
});

const editState = (stack: EditSnapshot[], currentIndex: number): EditState => ({
  photoId: PHOTO_ID,
  stack,
  currentIndex,
});

const s = () => useDevelopStore.getState();
const params = () => s().params;
const labels = () => s().history.map((h) => h.label);

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL = useDevelopStore.getState();

let storage: MemoryEdits;

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo(PHOTO_ID)] });
  storage = installMemoryStorage();
  vi.mocked(broadcast).mockClear();
  vi.mocked(regenerateEditedThumbnail).mockClear();
});

afterEach(() => {
  setCatalogStorage(null);
  useRegistry.setState({ catalogHooks: {} });
});

describe("loadEdit", () => {
  it("seeds an untouched photo with one Original snapshot at the as-shot WB", async () => {
    await s().loadEdit(PHOTO_ID, 5200);
    expect(labels()).toEqual(["Original"]);
    expect(s().historyIndex).toBe(0);
    expect(s().asShotTemperature).toBe(5200);
    expect(params().temperature).toBe(5200);
    expect(s().canUndo()).toBe(false);
    expect(s().canRedo()).toBe(false);
  });

  it("defaults the as-shot WB to neutral when the caller omits it", async () => {
    // Documented contract, not an oversight: a caller with no EXIF temperature
    // (batch operations) gets a neutral 6500 K baseline rather than a guess.
    await s().loadEdit(PHOTO_ID);
    expect(s().asShotTemperature).toBe(NEUTRAL_TEMPERATURE_K);
    expect(params().temperature).toBe(NEUTRAL_TEMPERATURE_K);
  });

  it("carries the as-shot WB into the thumbnail regen on commit", async () => {
    await s().loadEdit(PHOTO_ID, 3200);
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    expect(vi.mocked(regenerateEditedThumbnail).mock.calls[0][2]).toBe(3200);
  });

  it("restores a stored stack at its stored cursor", async () => {
    installMemoryStorage(
      editState(
        [
          snapshot("Original", { temperature: 5000 }),
          snapshot("Exposure", { temperature: 5000, exposure: 1.5 }),
          snapshot("Contrast", { temperature: 5000, exposure: 1.5, contrast: 20 }),
        ],
        1,
      ),
    );
    await s().loadEdit(PHOTO_ID, 5000);
    expect(s().historyIndex).toBe(1);
    expect(params().exposure).toBe(1.5);
    expect(params().contrast).toBe(0);
    expect(s().canUndo()).toBe(true);
    expect(s().canRedo()).toBe(true);
  });

  it("prepends an Original to a legacy stack and keeps the stored step current", async () => {
    installMemoryStorage(editState([snapshot("Exposure", { exposure: 1.5 })], 0));
    await s().loadEdit(PHOTO_ID, 4800);
    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(s().historyIndex).toBe(1);
    expect(params().exposure).toBe(1.5);
    // The seeded Original is the photo's as-shot look, so undo reaches it.
    expect(s().history[0].params.temperature).toBe(4800);
    expect(s().canUndo()).toBe(true);
  });

  it("clamps a stored cursor that falls outside its stack", async () => {
    const stack = [snapshot("Original", {}), snapshot("Exposure", { exposure: 2 })];
    installMemoryStorage(editState(stack, 7));
    await s().loadEdit(PHOTO_ID);
    expect(s().historyIndex).toBe(1);
    expect(params().exposure).toBe(2);

    installMemoryStorage(editState(stack, -3));
    await s().loadEdit(PHOTO_ID);
    expect(s().historyIndex).toBe(0);
    expect(params().exposure).toBe(0);
  });

  it("opens on the newest snapshot when the stored cursor is NaN", async () => {
    const stack = [snapshot("Original", {}), snapshot("Exposure", { exposure: 2 })];
    installMemoryStorage(editState(stack, NaN));
    await s().loadEdit(PHOTO_ID);
    expect(s().historyIndex).toBe(1);
    expect(params().exposure).toBe(2);
  });

  it("opens on the newest snapshot after the seeded Original when the cursor is NaN", async () => {
    const stack = [
      snapshot("Exposure", { exposure: 1.5 }),
      snapshot("Contrast", { exposure: 1.5, contrast: 20 }),
    ];
    installMemoryStorage(editState(stack, NaN));
    await s().loadEdit(PHOTO_ID);
    expect(labels()).toEqual(["Original", "Exposure", "Contrast"]);
    expect(s().historyIndex).toBe(2);
    expect(params().contrast).toBe(20);
  });

  it("clears the previous photo's preview and tool selection", async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    s().addRangeComponent("lumRange");
    s().setActiveTool("mask");
    s().setPreviewParams({ exposure: 3 }, { "ext.stage.amount": 1 });
    s().setGuidedEditing(true);

    await s().loadEdit("photo-2", 5000);
    expect(s().previewParams).toBeNull();
    expect(s().previewParamBag).toBeNull();
    expect(s().selectedMaskId).toBeNull();
    expect(s().selectedComponentId).toBeNull();
    expect(s().selectedSpotId).toBeNull();
    expect(s().activeTool).toBe("none");
    expect(s().guidedEditing).toBe(false);
    expect(params().masks).toEqual([]);
  });
});

const brushMask = (): Mask => ({
  id: "m1",
  name: "Brush",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [...DEFAULT_MASK_PANELS],
  components: [
    {
      id: "c1",
      kind: "brush",
      mode: "add",
      invert: false,
      brush: { dabs: [], feather: 0.5 },
    },
  ],
});

const dab = (x: number): BrushDab => ({
  x,
  y: 0.5,
  radius: 0.05,
  erase: false,
  feather: 0.5,
});

const healSpot = (id: string): RetouchSpot => ({
  id,
  shape: "circle",
  mode: "heal",
  visible: true,
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.4,
  srcY: 0.4,
  radius: 0.04,
  feather: 50,
  opacity: 100,
});

describe("live edits", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    vi.mocked(broadcast).mockClear();
  });

  // Every tick used to post the whole params object (brush dabs included) to
  // other windows, and the only reader re-loads the saved edit. Only commits,
  // undo/redo and stored edits announce.
  it("applies a slider tick without announcing it or writing history", () => {
    s().setParam("exposure", 1.5);
    expect(params().exposure).toBe(1.5);
    expect(s().history).toHaveLength(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stays silent through a whole slider drag", () => {
    for (let i = 1; i <= 10; i++) s().setParam("exposure", i / 10);
    expect(params().exposure).toBe(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stays silent for extension parameters", () => {
    s().setDynParam("ext.stage.amount", 40);
    s().setDynParams({ "ext.stage.amount": 41, "ext.stage.size": 3 });
    expect(s().paramBag).toEqual({ "ext.stage.amount": 41, "ext.stage.size": 3 });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stays silent through ten brush dabs", () => {
    s().addMask(brushMask());
    for (let i = 1; i <= 10; i++) s().addBrushDab("m1", "c1", dab(i / 20));
    expect(params().masks[0].components[0].brush?.dabs).toHaveLength(10);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stays silent for every mask and retouch mutation", () => {
    s().addMask(brushMask());
    s().addComponent("m1", {
      id: "c2",
      kind: "brush",
      mode: "add",
      invert: false,
      brush: { dabs: [], feather: 0.5 },
    });
    s().cycleComponentMode("m1", "c2");
    s().updateComponent("m1", "c2", { invert: true });
    s().updateMask("m1", { visible: false });
    s().updateMaskAdj("m1", { exposure: 0.5 });
    s().updateMaskBag("m1", { "ext.stage.amount": 5 });
    s().renameMask("m1", "Sky");
    s().removeComponent("m1", "c2");
    s().addSpot(healSpot("s1"));
    s().updateSpot("s1", { opacity: 80 });
    s().removeSpot("s1");
    s().removeMask("m1");
    expect(params().masks).toEqual([]);
    expect(params().retouch).toEqual([]);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("coalesces a whole gesture into a single history entry", async () => {
    for (const v of [0.1, 0.4, 0.9, 1.2, 1.5]) s().setParam("exposure", v);
    await s().commitEdit("Exposure");
    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(s().history[1].params.exposure).toBe(1.5);
  });

  it("applies nested tone-curve and HSL edits without announcing them", () => {
    s().setToneCurve("red", [
      { x: 0, y: 0 },
      { x: 1, y: 0.8 },
    ]);
    expect(params().toneCurve.red).toHaveLength(2);
    s().setHslValue("saturation", "blue", -30);
    expect(params().hsl.saturation.blue).toBe(-30);
    expect(params().hsl.hue.blue).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
    expect(s().history).toHaveLength(1);
  });

  it("announces a whole gesture once, when it commits", async () => {
    for (let i = 1; i <= 10; i++) s().setParam("exposure", i / 10);
    expect(broadcast).not.toHaveBeenCalled();
    await s().commitEdit("Exposure");
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "edit-update",
      payload: { photoId: PHOTO_ID, params: params() },
    });
  });

  it("announces an undo once", async () => {
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    vi.mocked(broadcast).mockClear();

    s().undo();
    expect(params().exposure).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "edit-update",
      payload: { photoId: PHOTO_ID, params: params() },
    });
  });

  it("announces a redo once", async () => {
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    s().undo();
    vi.mocked(broadcast).mockClear();

    s().redo();
    expect(params().exposure).toBe(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });
});

describe("commitEdit", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    vi.mocked(broadcast).mockClear();
    vi.mocked(regenerateEditedThumbnail).mockClear();
  });

  it("appends a snapshot, advances the cursor, and persists the stack", async () => {
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    expect(s().historyIndex).toBe(1);
    expect(storage.written).toHaveLength(1);
    expect(storage.written[0].currentIndex).toBe(1);
    expect(storage.written[0].stack).toHaveLength(2);
    expect(storage.written[0].photoId).toBe(PHOTO_ID);
  });

  it("hands the committed look to the thumbnail regen and announces it", async () => {
    s().setParam("exposure", 1);
    s().setDynParam("ext.stage.amount", 40);
    await s().commitEdit("Exposure");
    expect(regenerateEditedThumbnail).toHaveBeenCalledWith(
      PHOTO_ID,
      params(),
      5000,
      { "ext.stage.amount": 40 },
    );
    expect(vi.mocked(broadcast).mock.lastCall?.[0]).toEqual({
      type: "edit-update",
      payload: { photoId: PHOTO_ID, params: params() },
    });
  });

  it("emits the committed stack to catalog extensions", async () => {
    const onEditCommit = vi.fn(async (_ctx: EditCommitCtx) => {});
    registerCatalogHooks("test-ext", { id: "test.hooks", onEditCommit });
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    expect(onEditCommit).toHaveBeenCalledTimes(1);
    const ctx = onEditCommit.mock.calls[0][0];
    expect(ctx.photo.id).toBe(PHOTO_ID);
    expect(ctx.editState.currentIndex).toBe(1);
    expect(ctx.editState.stack[1].params.exposure).toBe(1);
  });

  it("is a no-op with no photo loaded", async () => {
    useDevelopStore.setState({ photoId: null });
    await s().commitEdit("Exposure");
    expect(s().history).toHaveLength(1);
    expect(storage.written).toHaveLength(0);
    expect(regenerateEditedThumbnail).not.toHaveBeenCalled();
  });

  it("snapshots the look, so later edits never rewrite history", async () => {
    s().setParam("exposure", 1);
    s().setDynParam("ext.stage.amount", 40);
    await s().commitEdit("Exposure");

    s().setParam("exposure", 3);
    s().setDynParam("ext.stage.amount", 80);
    s().setHslValue("luminance", "red", 50);
    s().addRangeComponent("lumRange");

    const committed = s().history[1];
    expect(committed.params.exposure).toBe(1);
    expect(committed.params.hsl.luminance.red).toBe(0);
    expect(committed.params.masks).toEqual([]);
    expect(committed.paramBag).toEqual({ "ext.stage.amount": 40 });
  });

  it("drops the redo tail when committing after an undo", async () => {
    s().setParam("exposure", 1);
    await s().commitEdit("Exposure");
    s().setParam("contrast", 20);
    await s().commitEdit("Contrast");
    s().undo();
    s().setParam("saturation", 10);
    await s().commitEdit("Saturation");

    expect(labels()).toEqual(["Original", "Exposure", "Saturation"]);
    expect(s().historyIndex).toBe(2);
    expect(s().canRedo()).toBe(false);
  });
});

describe("undo / redo", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
  });

  async function commit(label: string, exposure: number): Promise<void> {
    s().setParam("exposure", exposure);
    await s().commitEdit(label);
  }

  it("steps back and forward through the whole stack", async () => {
    await commit("A", 1);
    await commit("B", 2);
    await commit("C", 3);

    s().undo();
    expect(params().exposure).toBe(2);
    s().undo();
    expect(params().exposure).toBe(1);
    s().undo();
    expect(params().exposure).toBe(0);
    expect(s().historyIndex).toBe(0);

    s().redo();
    s().redo();
    expect(params().exposure).toBe(2);
    expect(s().historyIndex).toBe(2);
  });

  it("stops at the Original snapshot and at the newest entry", async () => {
    await commit("A", 1);
    s().undo();
    expect(s().canUndo()).toBe(false);
    s().undo();
    expect(s().historyIndex).toBe(0);
    expect(params().exposure).toBe(0);

    s().redo();
    expect(s().canRedo()).toBe(false);
    s().redo();
    expect(s().historyIndex).toBe(1);
  });

  it("restores the extension param bag alongside the params", async () => {
    s().setDynParam("ext.stage.amount", 40);
    await s().commitEdit("A");
    s().setDynParams({ "ext.stage.amount": 80, "ext.stage.radius": 2 });
    await s().commitEdit("B");

    s().undo();
    expect(s().paramBag).toEqual({ "ext.stage.amount": 40 });
    s().undo();
    expect(s().paramBag).toEqual({});
    s().redo();
    s().redo();
    expect(s().paramBag).toEqual({
      "ext.stage.amount": 80,
      "ext.stage.radius": 2,
    });
  });

  it("persists the moved cursor and refreshes the grid thumbnail", async () => {
    await commit("A", 1);
    storage.written.length = 0;
    vi.mocked(regenerateEditedThumbnail).mockClear();

    s().undo();
    expect(storage.written).toHaveLength(1);
    expect(storage.written[0].currentIndex).toBe(0);
    expect(storage.written[0].stack).toHaveLength(2); // the redo tail survives
    expect(regenerateEditedThumbnail).toHaveBeenCalledWith(
      PHOTO_ID,
      params(),
      5000,
      {},
    );
  });

  it("fills today's defaults when stepping into an older build's snapshot", async () => {
    registerStageParams("teststage", "Test Stage", "test-ext", [
      { key: "amount", glslType: "float", default: 25 },
    ]);
    installMemoryStorage(
      editState(
        [
          snapshot("Original", { temperature: 5000 }),
          legacySnapshot("Exposure", { exposure: 1.5 }, {
            "teststage.amount": "not-a-float",
          }),
          snapshot("Contrast", { temperature: 5000, contrast: 20 }),
        ],
        2,
      ),
    );
    await s().loadEdit(PHOTO_ID, 5000);
    s().undo();

    expect(params().exposure).toBe(1.5);
    expect(params().grain).toEqual(DEFAULT_DEVELOP_PARAMS.grain);
    expect(params().crop).toEqual(DEFAULT_DEVELOP_PARAMS.crop);
    expect(params().toneCurve).toEqual(DEFAULT_DEVELOP_PARAMS.toneCurve);
    expect(params().masks).toEqual([]);
    // A bag value whose type no longer matches its descriptor is dropped, the
    // same as it would be on load.
    expect(s().paramBag).toEqual({});
    unregisterStageParams("teststage");
  });

  it("does nothing with no history at all", () => {
    useDevelopStore.setState({ history: [], historyIndex: -1 });
    s().undo();
    s().redo();
    expect(s().historyIndex).toBe(-1);
    expect(s().canUndo()).toBe(false);
    expect(s().canRedo()).toBe(false);
  });
});

describe("resetParams", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 3200);
  });

  it("resets only the listed keys, as one undoable entry", async () => {
    s().setParam("exposure", 2);
    s().setParam("contrast", 30);
    await s().resetParams(["exposure"], "Reset Basic");

    expect(params().exposure).toBe(0);
    expect(params().contrast).toBe(30);
    expect(labels()).toEqual(["Original", "Reset Basic"]);
  });

  it("restores the as-shot WB rather than the neutral default", async () => {
    s().setParam("temperature", 8000);
    await s().resetParams(["temperature"], "Reset WB");
    expect(params().temperature).toBe(3200);
  });

  it("clones nested defaults instead of aliasing the shared default object", async () => {
    await s().resetParams(["crop"], "Reset Crop");
    expect(params().crop).toEqual(DEFAULT_DEVELOP_PARAMS.crop);
    expect(params().crop).not.toBe(DEFAULT_DEVELOP_PARAMS.crop);
  });

  it("commits nothing when given no keys", async () => {
    await s().resetParams([], "Reset Nothing");
    expect(s().history).toHaveLength(1);
    expect(storage.written).toHaveLength(0);
  });
});

describe("reset", () => {
  it("returns to the as-shot look, clears the bag, and commits it", async () => {
    await s().loadEdit(PHOTO_ID, 3200);
    s().setParam("exposure", 2);
    s().setDynParam("ext.stage.amount", 40);
    await s().commitEdit("Exposure");

    await s().reset();
    expect(params()).toEqual(freshParams(3200));
    expect(s().paramBag).toEqual({});
    expect(labels()).toEqual(["Original", "Exposure", "Reset"]);
    expect(s().canUndo()).toBe(true);
  });
});

describe("applyPreset", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
  });

  it("merges the preset's bag over the live one and commits one entry", async () => {
    s().setDynParams({ "a.stage.k": 1, "b.stage.k": 2 });
    await s().applyPreset(normalizeParams({ exposure: 1.5, temperature: 5000 }), {
      "b.stage.k": 9,
      "c.stage.k": 3,
    });

    expect(params().exposure).toBe(1.5);
    expect(s().paramBag).toEqual({
      "a.stage.k": 1,
      "b.stage.k": 9,
      "c.stage.k": 3,
    });
    expect(labels()).toEqual(["Original", "Preset"]);
  });

  it("keeps the live bag when the preset contributes none", async () => {
    s().setDynParam("a.stage.k", 1);
    await s().applyPreset(normalizeParams({ exposure: 1 }));
    expect(s().paramBag).toEqual({ "a.stage.k": 1 });
  });

  it("clears an active hover preview", async () => {
    s().setPreviewParams(normalizeParams({ exposure: 3 }), { "a.stage.k": 7 });
    await s().applyPreset(normalizeParams({ exposure: 1 }));
    expect(s().previewParams).toBeNull();
    expect(s().previewParamBag).toBeNull();
  });
});

describe("setPreviewParams", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    vi.mocked(broadcast).mockClear();
  });

  it("overrides the render without touching history or the renderer broadcast", () => {
    s().setPreviewParams(normalizeParams({ exposure: 3 }));
    expect(s().previewParams?.exposure).toBe(3);
    expect(params().exposure).toBe(0);
    expect(s().history).toHaveLength(1);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("previews a partial bag layered over the live one, and clears both together", () => {
    s().setDynParam("a.stage.k", 1);
    s().setPreviewParams(normalizeParams({ exposure: 3 }), { "b.stage.k": 2 });
    expect(s().previewParamBag).toEqual({ "a.stage.k": 1, "b.stage.k": 2 });

    s().setPreviewParams(null);
    expect(s().previewParams).toBeNull();
    expect(s().previewParamBag).toBeNull();
    expect(s().paramBag).toEqual({ "a.stage.k": 1 });
  });

  it("leaves the bag alone when previewing params only", () => {
    s().setDynParam("a.stage.k", 1);
    s().setPreviewParams(normalizeParams({ exposure: 3 }));
    expect(s().previewParamBag).toBeNull();
  });
});

describe("process versions", () => {
  const loadLegacy = async () => {
    storage = installMemoryStorage(editState([legacySnapshot("Exposure", { exposure: 1 })], 0));
    await s().loadEdit(PHOTO_ID, 5200);
  };

  it("starts the store on the current version, before any photo loads", () => {
    expect(INITIAL.params.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("gives a photo with no stored edit the current version, Original included", async () => {
    await s().loadEdit(PHOTO_ID, 5200);
    expect(params().processVersion).toBe(CURRENT_PROCESS_VERSION);
    expect(s().history[0].params.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("opens an edit saved before process versions at version 1, its prepended Original too", async () => {
    await loadLegacy();
    expect(params().processVersion).toBe(LEGACY_PROCESS_VERSION);
    expect(s().history[0].label).toBe("Original");
    expect(s().history[0].params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("gives a version 2 edit that has no Original a version 2 Original", async () => {
    storage = installMemoryStorage(
      editState([snapshot("Exposure", { exposure: 1, processVersion: 2 })], 0),
    );
    await s().loadEdit(PHOTO_ID, 5200);
    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(s().history[0].params.processVersion).toBe(2);
    expect(s().history[0].params.temperature).toBe(5200);
  });

  it("keeps version 2 for an edit made after undoing to that prepended Original", async () => {
    storage = installMemoryStorage(
      editState([snapshot("Exposure", { exposure: 1, processVersion: 2 })], 0),
    );
    await s().loadEdit(PHOTO_ID, 5200);
    s().undo();
    expect(params().processVersion).toBe(2);

    s().setParam("contrast", 20);
    await s().commitEdit("Contrast");
    const top = storage.written.at(-1)!.stack.at(-1)!;
    expect(top.params.processVersion).toBe(2);
  });

  it("keeps version 1 through edits and commits", async () => {
    await loadLegacy();
    s().setParam("contrast", 20);
    await s().commitEdit("Contrast");
    const top = storage.written.at(-1)!.stack.at(-1)!;
    expect(top.params.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("keeps a stored version 2 through loading and committing", async () => {
    storage = installMemoryStorage(
      editState(
        [
          snapshot("Original", { processVersion: 2 }),
          snapshot("Exposure", { exposure: 1, processVersion: 2 }),
        ],
        1,
      ),
    );
    await s().loadEdit(PHOTO_ID, 5200);
    expect(params().processVersion).toBe(2);

    s().setParam("contrast", 20);
    await s().commitEdit("Contrast");
    const top = storage.written.at(-1)!.stack.at(-1)!;
    expect(top.params.processVersion).toBe(2);
  });

  it("starts a reset photo over at the current version", async () => {
    await loadLegacy();
    await s().reset();
    expect(params().processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("never lets a preset change the version", async () => {
    await loadLegacy();
    await s().applyPreset({ ...freshParams(), exposure: 1.5 });
    expect(params().exposure).toBe(1.5);
    expect(params().processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("previews a partial at the open photo's version", async () => {
    await s().loadEdit(PHOTO_ID, 5200);
    s().setPreviewParams({ exposure: 1 });
    expect(s().previewParams?.exposure).toBe(1);
    expect(s().previewParams?.processVersion).toBe(CURRENT_PROCESS_VERSION);
  });

  it("never lets a preview change the version", async () => {
    await loadLegacy();
    s().setPreviewParams({ exposure: 1, processVersion: CURRENT_PROCESS_VERSION });
    expect(s().previewParams?.exposure).toBe(1);
    expect(s().previewParams?.processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  it("leaves the version alone when a panel reset lists it", async () => {
    await loadLegacy();
    await s().resetParams(["processVersion", "exposure"], "Reset Basic");
    expect(params().exposure).toBe(0);
    expect(params().processVersion).toBe(LEGACY_PROCESS_VERSION);
  });

  describe("updateProcessing", () => {
    const BAG = { "ext.stage.amount": 40 };

    // An edit saved before process versions existed, with a look and a bag to keep.
    const openLegacy = async () => {
      storage = installMemoryStorage(
        editState([legacySnapshot("Exposure", { exposure: 1, contrast: 20 }, BAG)], 0),
      );
      await s().loadEdit(PHOTO_ID, 5200);
      vi.mocked(broadcast).mockClear();
      vi.mocked(regenerateEditedThumbnail).mockClear();
    };
    const lastWritten = () => storage.written[storage.written.length - 1];

    it("moves a version 1 photo to the current version and keeps every other setting", async () => {
      await openLegacy();
      const before = params();
      expect(before.processVersion).toBe(LEGACY_PROCESS_VERSION);

      await s().updateProcessing();

      expect(params()).toEqual({ ...before, processVersion: CURRENT_PROCESS_VERSION });
      expect(s().paramBag).toEqual(BAG);
    });

    it("is one history step, labelled and persisted", async () => {
      await openLegacy();
      await s().updateProcessing();

      expect(labels()).toEqual(["Original", "Exposure", "Update processing"]);
      expect(s().historyIndex).toBe(2);
      expect(storage.written).toHaveLength(1);
      expect(lastWritten().currentIndex).toBe(2);
      const stored = lastWritten().stack[2];
      expect(stored.label).toBe("Update processing");
      expect(stored.params).toEqual(params());
      expect(stored.paramBag).toEqual(BAG);
    });

    it("undoes back to version 1 and redoes forward again", async () => {
      await openLegacy();
      await s().updateProcessing();

      s().undo();
      expect(params().processVersion).toBe(LEGACY_PROCESS_VERSION);
      expect(params().exposure).toBe(1);
      expect(lastWritten().currentIndex).toBe(1);

      s().redo();
      expect(params().processVersion).toBe(CURRENT_PROCESS_VERSION);
      expect(params().exposure).toBe(1);
    });

    it("announces the new version and refreshes the grid thumbnail like any commit", async () => {
      await openLegacy();
      await s().updateProcessing();

      expect(regenerateEditedThumbnail).toHaveBeenCalledWith(PHOTO_ID, params(), 5200, BAG);
      expect(vi.mocked(broadcast).mock.lastCall?.[0]).toEqual({
        type: "edit-update",
        payload: { photoId: PHOTO_ID, params: params() },
      });
    });

    it("adds no step to a photo that is already current", async () => {
      await s().loadEdit(PHOTO_ID, 5200);
      await s().updateProcessing();

      expect(labels()).toEqual(["Original"]);
      expect(storage.written).toHaveLength(0);
      expect(regenerateEditedThumbnail).not.toHaveBeenCalled();
    });

    it("does nothing with no photo open", async () => {
      await openLegacy();
      useDevelopStore.setState({ photoId: null });
      await s().updateProcessing();

      expect(params().processVersion).toBe(LEGACY_PROCESS_VERSION);
      expect(labels()).toEqual(["Original", "Exposure"]);
      expect(storage.written).toHaveLength(0);
    });
  });
});
