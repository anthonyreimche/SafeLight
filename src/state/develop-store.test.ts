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
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { registerCatalogHooks, useRegistry } from "@/extensions/registry";
import {
  registerStageParams,
  unregisterStageParams,
} from "@/extensions/param-registry";
import {
  DEFAULT_DEVELOP_PARAMS,
  NEUTRAL_TEMPERATURE_K,
  normalizeParams,
} from "@/catalog/types";
import type {
  CatalogPhoto,
  DevelopParams,
  EditSnapshot,
  EditState,
} from "@/catalog/types";
import type { CatalogHooksContribution } from "@/extensions/types";

type EditCommitCtx = Parameters<
  NonNullable<CatalogHooksContribution["onEditCommit"]>
>[0];

const PHOTO_ID = "photo-1";

function photo(id = PHOTO_ID): CatalogPhoto {
  return {
    id,
    filename: `${id}.NEF`,
    relPath: `${id}.NEF`,
    folder: "",
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 6000,
    height: 4000,
    fileSize: 1024,
    mimeType: "image/x-nikon-nef",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
  };
}

interface MemoryStorage extends CatalogStorage {
  /** Every stack handed to putEditState, in order — the persistence assertions. */
  written: EditState[];
}

function memoryStorage(seed?: EditState): MemoryStorage {
  const states = new Map<string, EditState>();
  if (seed) states.set(seed.photoId, seed);
  const written: EditState[] = [];
  return {
    written,
    getAllPhotos: async () => [],
    putPhoto: async () => {},
    putPhotos: async () => {},
    deletePhoto: async () => {},
    getEditState: async (id) => states.get(id),
    getAllEditStates: async () => [...states.values()],
    putEditState: async (editState) => {
      states.set(editState.photoId, editState);
      written.push(editState);
    },
  };
}

const snapshot = (label: string, params: Partial<DevelopParams>): EditSnapshot => ({
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

let storage: MemoryStorage;

beforeEach(() => {
  useDevelopStore.setState(INITIAL, true);
  useCatalogStore.setState({ photos: [photo()] });
  storage = memoryStorage();
  setCatalogStorage(storage);
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
    setCatalogStorage(
      memoryStorage(
        editState(
          [
            snapshot("Original", { temperature: 5000 }),
            snapshot("Exposure", { temperature: 5000, exposure: 1.5 }),
            snapshot("Contrast", { temperature: 5000, exposure: 1.5, contrast: 20 }),
          ],
          1,
        ),
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
    setCatalogStorage(
      memoryStorage(editState([snapshot("Exposure", { exposure: 1.5 })], 0)),
    );
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
    setCatalogStorage(memoryStorage(editState(stack, 7)));
    await s().loadEdit(PHOTO_ID);
    expect(s().historyIndex).toBe(1);
    expect(params().exposure).toBe(2);

    setCatalogStorage(memoryStorage(editState(stack, -3)));
    await s().loadEdit(PHOTO_ID);
    expect(s().historyIndex).toBe(0);
    expect(params().exposure).toBe(0);
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

describe("live edits", () => {
  beforeEach(async () => {
    await s().loadEdit(PHOTO_ID, 5000);
    vi.mocked(broadcast).mockClear();
  });

  it("broadcasts the live params without writing history", () => {
    s().setParam("exposure", 1.5);
    expect(params().exposure).toBe(1.5);
    expect(s().history).toHaveLength(1);
    expect(broadcast).toHaveBeenCalledWith({
      type: "edit-update",
      payload: { photoId: PHOTO_ID, params: params() },
    });
  });

  it("coalesces a whole gesture into a single history entry", async () => {
    for (const v of [0.1, 0.4, 0.9, 1.2, 1.5]) s().setParam("exposure", v);
    await s().commitEdit("Exposure");
    expect(labels()).toEqual(["Original", "Exposure"]);
    expect(s().history[1].params.exposure).toBe(1.5);
  });

  it("broadcasts nested tone-curve and HSL edits too", () => {
    s().setToneCurve("red", [
      { x: 0, y: 0 },
      { x: 1, y: 0.8 },
    ]);
    expect(params().toneCurve.red).toHaveLength(2);
    s().setHslValue("saturation", "blue", -30);
    expect(params().hsl.saturation.blue).toBe(-30);
    expect(params().hsl.hue.blue).toBe(0);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(s().history).toHaveLength(1);
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
    setCatalogStorage(
      memoryStorage(
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
    expect(params()).toEqual(normalizeParams({ temperature: 3200 }));
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
