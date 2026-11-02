// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The mask value edits core keeps for its mask scope: a mask's fields, its
// adjustments, its extension bag, and the seeding of a sub-panel's values. We
// drive the slice through a real zustand store seeded with only the surface the
// edits touch (params + photoId), and stub the broadcast side effect.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The edits never broadcast, but the store module imports it; stub the whole
// module (also avoids depending on a BroadcastChannel in the test environment).
vi.mock("../broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { create } from "zustand";
import { createMaskSlice } from "./mask-slice.ts";
import {
  DEFAULT_DEVELOP_PARAMS,
  DEFAULT_MASK_PANELS,
  defaultHSL,
  defaultLumRange,
  defaultMaskAdjustments,
  defaultToneCurves,
} from "@/catalog/types";
import type { Mask } from "@/catalog/types";
import { registerStageParams, unregisterStageParams } from "@/extensions/param-registry";
import type { DevelopState } from "../develop-store";

const MASK: Mask = {
  id: "m1",
  name: "Luminance",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [...DEFAULT_MASK_PANELS],
  components: [{ id: "c1", kind: "lumRange", mode: "add", invert: false, lumRange: defaultLumRange() }],
};

// A store carrying only what the edits read or write. The rest of DevelopState
// is irrelevant to them, so we seed a partial and assert it is store-shaped
// rather than stubbing ~60 unrelated members.
function makeStore() {
  return create<DevelopState>()(
    (set, get, store) =>
      ({
        ...createMaskSlice(set, get, store),
        photoId: "photo-1",
        params: { ...DEFAULT_DEVELOP_PARAMS, masks: [MASK], retouch: [] },
      }) as unknown as DevelopState,
  );
}

let store: ReturnType<typeof makeStore>;
const mask = () => store.getState().params.masks[0];
beforeEach(() => {
  store = makeStore();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("mask edits", () => {
  it("updateMask patches fields", () => {
    store.getState().updateMask("m1", { visible: false, opacity: 42 });
    expect(mask().visible).toBe(false);
    expect(mask().opacity).toBe(42);
  });

  it("updateMask drops a block patched to undefined", () => {
    store.getState().updateMask("m1", { hsl: defaultHSL() });
    store.getState().updateMask("m1", { hsl: undefined });
    expect(mask()).not.toHaveProperty("hsl");
  });

  it("updateMaskAdj merges into the mask's adjustments", () => {
    store.getState().updateMaskAdj("m1", { exposure: 0.7 });
    expect(mask().adj.exposure).toBe(0.7);
    // other adjustments untouched
    expect(mask().adj.contrast).toBe(0);
  });
});

describe("updateMaskBag", () => {
  it("merges values, deletes undefined keys, and drops an empty bag", () => {
    store.getState().updateMaskBag("m1", { "ext.stage.amount": 40 });
    store.getState().updateMaskBag("m1", { "ext.stage.radius": 2 });
    expect(mask().bag).toEqual({ "ext.stage.amount": 40, "ext.stage.radius": 2 });

    store.getState().updateMaskBag("m1", { "ext.stage.radius": undefined });
    expect(mask().bag).toEqual({ "ext.stage.amount": 40 });

    store.getState().updateMaskBag("m1", { "ext.stage.amount": undefined });
    expect(mask().bag).toBeUndefined();
  });
});

describe("mask sub-panel seed / clear (owns interpretation)", () => {
  // A registered stage param gives seeding a default to restore.
  beforeEach(() => {
    registerStageParams("teststage", "Test Stage", "test-ext", [
      { key: "amount", glslType: "float", default: 25 },
    ]);
  });
  afterEach(() => unregisterStageParams("teststage"));

  it("seeds owned blocks with defaults and bag keys with registered defaults", () => {
    store.getState().seedMaskPanelValues("m1", ["hsl", "toneCurve", "teststage.amount"]);
    expect(mask().hsl).toEqual(defaultHSL());
    expect(mask().toneCurve).toEqual(defaultToneCurves());
    expect(mask().bag).toEqual({ "teststage.amount": 25 });
  });

  it("clear zeroes owned adjustments and strips blocks and bag keys", () => {
    store.getState().updateMaskAdj("m1", { exposure: 50, tint: -20 });
    store.getState().seedMaskPanelValues("m1", ["hsl", "toneCurve", "teststage.amount"]);

    store.getState().clearMaskPanelValues("m1", ["exposure", "hsl", "toneCurve", "teststage.amount"]);
    expect(mask().adj.exposure).toBe(0);
    expect(mask().adj.tint).toBe(-20); // not owned by the removed sub-panel
    expect(mask().hsl).toBeUndefined();
    expect(mask().toneCurve).toBeUndefined();
    expect(mask().bag).toBeUndefined();
  });

  it("seeding an unregistered bag key stores nothing", () => {
    store.getState().seedMaskPanelValues("m1", ["gone-ext.stage.k"]);
    expect(mask().bag).toBeUndefined();
  });
});

describe("the sharpening preview", () => {
  it("is set and cleared", () => {
    store.getState().setSharpenViz(2);
    expect(store.getState().sharpenViz).toBe(2);
    store.getState().setSharpenViz(0);
    expect(store.getState().sharpenViz).toBe(0);
  });
});
