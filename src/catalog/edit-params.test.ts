// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The single read path Loupe and Export share with Develop: resolve a photo's
// persisted edit to normalized params plus a sanitised extension param bag, or
// to as-shot defaults when it was never edited. Driven through a real
// CatalogStorage implementation rather than a module mock. Run with `npm test`.

import { afterEach, describe, expect, it } from "vitest";
import { loadSavedEdit, loadSavedParams } from "./edit-params";
import { setCatalogStorage, type CatalogStorage } from "./storage";
import {
  DEFAULT_DEVELOP_PARAMS,
  NEUTRAL_TEMPERATURE_K,
  type DevelopParams,
  type EditSnapshot,
  type EditState,
} from "./types";
import { registerStageParams, unregisterStageParams } from "@/extensions/param-registry";

const PHOTO = "photo-1";

function install(edit: EditState | undefined): void {
  const storage: CatalogStorage = {
    getAllPhotos: async () => [],
    putPhoto: async () => {},
    putPhotos: async () => {},
    deletePhoto: async () => {},
    getEditState: async (photoId) => (photoId === edit?.photoId ? edit : undefined),
    getAllEditStates: async () => (edit ? [edit] : []),
    putEditState: async () => {},
  };
  setCatalogStorage(storage);
}

// A persisted snapshot. `params` is deliberately typed as a partial cast: stacks
// written by older builds are missing whatever fields did not exist yet, and
// surviving that is the point of the normalization step.
function snapshot(
  params: Partial<DevelopParams>,
  paramBag?: Record<string, unknown>,
): EditSnapshot {
  return { timestamp: 0, label: "Edit", params: params as DevelopParams, paramBag };
}

const stackOf = (snaps: EditSnapshot[], currentIndex = snaps.length - 1): EditState => ({
  photoId: PHOTO,
  stack: snaps,
  currentIndex,
});

afterEach(() => setCatalogStorage(null));

describe("loadSavedEdit — photo with no stored edit", () => {
  it("returns normalized defaults and an empty param bag", async () => {
    install(undefined);
    const { params, paramBag } = await loadSavedEdit(PHOTO);
    expect(params.exposure).toBe(0);
    expect(params.sharpening).toBe(DEFAULT_DEVELOP_PARAMS.sharpening);
    expect(params.temperature).toBe(NEUTRAL_TEMPERATURE_K);
    expect(params.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(params.masks).toEqual([]);
    expect(paramBag).toEqual({});
  });

  it("seeds the as-shot white balance so an unedited RAW renders as the camera saw it", async () => {
    install(undefined);
    expect((await loadSavedEdit(PHOTO, 3200)).params.temperature).toBe(3200);
  });

  it("falls back to neutral when the as-shot temperature is absent or zero", async () => {
    install(undefined);
    expect((await loadSavedEdit(PHOTO)).params.temperature).toBe(NEUTRAL_TEMPERATURE_K);
    expect((await loadSavedEdit(PHOTO, 0)).params.temperature).toBe(NEUTRAL_TEMPERATURE_K);
  });

  it("clamps an as-shot temperature outside the supported Kelvin range", async () => {
    install(undefined);
    expect((await loadSavedEdit(PHOTO, 1500)).params.temperature).toBe(2000);
    expect((await loadSavedEdit(PHOTO, 80000)).params.temperature).toBe(50000);
    // Below 1000 K reads as a bad value rather than a clamp candidate.
    expect((await loadSavedEdit(PHOTO, 999)).params.temperature).toBe(NEUTRAL_TEMPERATURE_K);
  });

  it("treats a stored-but-empty edit stack as unedited", async () => {
    install({ photoId: PHOTO, stack: [], currentIndex: 0 });
    const { params, paramBag } = await loadSavedEdit(PHOTO, 3200);
    expect(params.temperature).toBe(3200);
    expect(paramBag).toEqual({});
  });

  it("ignores an edit stack belonging to a different photo", async () => {
    install(stackOf([snapshot({ exposure: 1.5 })]));
    expect((await loadSavedEdit("photo-2")).params.exposure).toBe(0);
  });
});

describe("loadSavedEdit — photo with a stored edit", () => {
  it("returns the snapshot at currentIndex, not the top of the stack", async () => {
    install(
      stackOf(
        [snapshot({ exposure: 0 }), snapshot({ exposure: 0.5 }), snapshot({ exposure: 2 })],
        1,
      ),
    );
    expect((await loadSavedEdit(PHOTO)).params.exposure).toBe(0.5);
  });

  it("lets the persisted white balance win over the as-shot temperature", async () => {
    install(stackOf([snapshot({ temperature: 4000 })]));
    expect((await loadSavedEdit(PHOTO, 3200)).params.temperature).toBe(4000);
  });

  it("backfills fields a legacy snapshot never stored", async () => {
    install(stackOf([snapshot({ exposure: 0.75 })]));
    const { params } = await loadSavedEdit(PHOTO);
    expect(params.exposure).toBe(0.75);
    expect(params.colorNR).toBe(DEFAULT_DEVELOP_PARAMS.colorNR);
    expect(params.crop).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(params.hsl.saturation.red).toBe(0);
    expect(params.uprightMode).toBe("off");
    expect(params.masks).toEqual([]);
    expect(params.retouch).toEqual([]);
  });

  it("clamps persisted values that fall outside their allowed range", async () => {
    install(stackOf([snapshot({ temperature: 80000, tint: 900, straighten: 90 })]));
    const { params } = await loadSavedEdit(PHOTO);
    expect(params.temperature).toBe(50000);
    expect(params.tint).toBe(150);
    expect(params.straighten).toBe(45);
  });

  it("does not hand back the stored snapshot object, so callers cannot corrupt it", async () => {
    const snap = snapshot({ exposure: 1, masks: [] });
    install(stackOf([snap]));
    const { params } = await loadSavedEdit(PHOTO);
    params.exposure = 99;
    expect(snap.params.exposure).toBe(1);
    expect(params.masks).not.toBe(snap.params.masks);
  });
});

describe("loadSavedEdit — extension param bag", () => {
  const STAGE = "test-denoise";

  afterEach(() => unregisterStageParams(STAGE));

  it("returns an empty bag for a snapshot written before paramBag existed", async () => {
    install(stackOf([snapshot({ exposure: 1 })]));
    expect((await loadSavedEdit(PHOTO)).paramBag).toEqual({});
  });

  it("preserves keys belonging to an extension that is not currently loaded", async () => {
    install(stackOf([snapshot({}, { "absent-ext.stage.amount": 40, "absent-ext.stage.on": true })]));
    expect((await loadSavedEdit(PHOTO)).paramBag).toEqual({
      "absent-ext.stage.amount": 40,
      "absent-ext.stage.on": true,
    });
  });

  it("drops a registered key whose persisted value has the wrong GLSL type", async () => {
    registerStageParams(STAGE, "Test Denoise", "test-ext", [
      { key: "amount", glslType: "float", default: 25 },
      { key: "enabled", glslType: "bool", default: false },
      { key: "tint", glslType: "vec3", default: [0, 0, 0] },
    ]);
    install(
      stackOf([
        snapshot(
          {},
          {
            [`${STAGE}.amount`]: "loud", // string where a float is declared
            [`${STAGE}.enabled`]: true,
            [`${STAGE}.tint`]: [0.1, 0.2, 0.3],
          },
        ),
      ]),
    );
    expect((await loadSavedEdit(PHOTO)).paramBag).toEqual({
      [`${STAGE}.enabled`]: true,
      [`${STAGE}.tint`]: [0.1, 0.2, 0.3],
    });
  });
});

describe("loadSavedParams", () => {
  it("is the params half of loadSavedEdit", async () => {
    install(stackOf([snapshot({ exposure: 0.75, contrast: 12 }, { "ext.stage.k": 1 })]));
    const params = await loadSavedParams(PHOTO);
    expect(params.exposure).toBe(0.75);
    expect(params.contrast).toBe(12);
    expect(params).toEqual((await loadSavedEdit(PHOTO)).params);
  });

  it("threads the as-shot temperature through for unedited photos", async () => {
    install(undefined);
    expect((await loadSavedParams(PHOTO, 2850)).temperature).toBe(2850);
  });
});
