// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Characterization tests for the mask / retouch data mutations — the part of the
// develop store that edits params.masks and params.retouch. These had no
// coverage before the store was sliced. We drive the slice through a real
// zustand store seeded with only the surface the mutations touch (params +
// photoId), and stub the broadcast side effect. Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The mutations call broadcast() to live-refresh the renderer; that's a side
// effect we don't exercise here, so stub the whole module (also avoids depending
// on a BroadcastChannel in the test environment).
vi.mock("../broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { create } from "zustand";
import { createMaskSlice } from "./mask-slice.ts";
import {
  DEFAULT_DEVELOP_PARAMS,
  defaultHSL,
  defaultLumRange,
  defaultToneCurves,
} from "@/catalog/types";
import type { BrushDab, MaskComponent, RetouchSpot } from "@/catalog/types";
import {
  registerStageParams,
  unregisterStageParams,
} from "@/extensions/param-registry";
import type { DevelopState } from "../develop-store";

// A store carrying only what the mask mutations read or write. The rest of
// DevelopState is irrelevant to mask logic, so we seed a partial and assert it
// is store-shaped rather than stubbing ~60 unrelated members.
function makeStore() {
  return create<DevelopState>()(
    (set, get, store) =>
      ({
        ...createMaskSlice(set, get, store),
        photoId: "photo-1",
        params: { ...DEFAULT_DEVELOP_PARAMS, masks: [], retouch: [] },
      }) as unknown as DevelopState,
  );
}

let store: ReturnType<typeof makeStore>;
beforeEach(() => {
  store = makeStore();
});
afterEach(() => {
  vi.clearAllMocks();
});

const spot = (id: string): RetouchSpot => ({
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

describe("addRangeComponent", () => {
  it("creates a new mask when none is selected", () => {
    store.getState().addRangeComponent("lumRange");
    const { masks } = store.getState().params;
    expect(masks).toHaveLength(1);
    expect(masks[0].name).toBe("Luminance");
    expect(masks[0].components).toHaveLength(1);
    expect(masks[0].components[0].kind).toBe("lumRange");
    expect(masks[0].components[0].mode).toBe("add");
    expect(store.getState().selectedMaskId).toBe(masks[0].id);
  });

  it("appends an intersect component to the selected mask", () => {
    store.getState().addRangeComponent("lumRange"); // creates + selects a mask
    store.getState().addRangeComponent("colorRange"); // confines the same mask
    const { masks } = store.getState().params;
    expect(masks).toHaveLength(1);
    expect(masks[0].components).toHaveLength(2);
    expect(masks[0].components[1].kind).toBe("colorRange");
    expect(masks[0].components[1].mode).toBe("intersect");
  });
});

describe("component mutations", () => {
  it("addComponent appends to a mask and selects it", () => {
    store.getState().addRangeComponent("lumRange");
    const maskId = store.getState().params.masks[0].id;
    const extra: MaskComponent = {
      id: "extra-comp",
      kind: "lumRange",
      mode: "subtract",
      invert: false,
      lumRange: defaultLumRange(),
    };
    store.getState().addComponent(maskId, extra);
    expect(store.getState().params.masks[0].components).toHaveLength(2);
    expect(store.getState().selectedComponentId).toBe("extra-comp");
  });

  it("cycleComponentMode cycles add -> subtract -> intersect -> add", () => {
    store.getState().addRangeComponent("lumRange");
    const mask = store.getState().params.masks[0];
    const compId = mask.components[0].id;
    const modeNow = () => store.getState().params.masks[0].components[0].mode;
    expect(modeNow()).toBe("add");
    store.getState().cycleComponentMode(mask.id, compId);
    expect(modeNow()).toBe("subtract");
    store.getState().cycleComponentMode(mask.id, compId);
    expect(modeNow()).toBe("intersect");
    store.getState().cycleComponentMode(mask.id, compId);
    expect(modeNow()).toBe("add");
  });

  it("removeComponent drops a component, and removing the last drops the mask", () => {
    store.getState().addRangeComponent("lumRange");
    store.getState().addRangeComponent("colorRange"); // same mask, 2 components
    const mask = store.getState().params.masks[0];
    const [c0, c1] = mask.components;

    store.getState().removeComponent(mask.id, c0.id);
    expect(store.getState().params.masks).toHaveLength(1);
    expect(store.getState().params.masks[0].components).toHaveLength(1);

    store.getState().removeComponent(mask.id, c1.id);
    expect(store.getState().params.masks).toHaveLength(0);
    expect(store.getState().selectedMaskId).toBeNull();
  });
});

describe("mask mutations", () => {
  it("updateMask patches fields", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().updateMask(id, { visible: false, opacity: 42 });
    const m = store.getState().params.masks[0];
    expect(m.visible).toBe(false);
    expect(m.opacity).toBe(42);
  });

  it("updateMaskAdj merges into the mask's adjustments", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().updateMaskAdj(id, { exposure: 0.7 });
    expect(store.getState().params.masks[0].adj.exposure).toBe(0.7);
    // other adjustments untouched
    expect(store.getState().params.masks[0].adj.contrast).toBe(0);
  });

  it("renameMask sets the name", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().renameMask(id, "Sky");
    expect(store.getState().params.masks[0].name).toBe("Sky");
  });

  it("removeMask removes it and clears selection", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().removeMask(id);
    expect(store.getState().params.masks).toHaveLength(0);
    expect(store.getState().selectedMaskId).toBeNull();
  });

  it("caps masks at MAX_MASKS (16)", () => {
    for (let i = 0; i < 20; i++) {
      store.getState().selectMask(null); // force a new mask each time
      store.getState().addRangeComponent("lumRange");
    }
    expect(store.getState().params.masks).toHaveLength(16);
  });
});

describe("updateMaskBag", () => {
  it("merges values, deletes undefined keys, and drops an empty bag", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    const bag = () => store.getState().params.masks[0].bag;

    store.getState().updateMaskBag(id, { "ext.stage.amount": 40 });
    store.getState().updateMaskBag(id, { "ext.stage.radius": 2 });
    expect(bag()).toEqual({ "ext.stage.amount": 40, "ext.stage.radius": 2 });

    store.getState().updateMaskBag(id, { "ext.stage.radius": undefined });
    expect(bag()).toEqual({ "ext.stage.amount": 40 });

    store.getState().updateMaskBag(id, { "ext.stage.amount": undefined });
    expect(bag()).toBeUndefined();
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
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().seedMaskPanelValues(id, ["hsl", "toneCurve", "teststage.amount"]);
    const m = store.getState().params.masks[0];
    expect(m.hsl).toEqual(defaultHSL());
    expect(m.toneCurve).toEqual(defaultToneCurves());
    expect(m.bag).toEqual({ "teststage.amount": 25 });
  });

  it("clear zeroes owned adjustments and strips blocks and bag keys", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().updateMaskAdj(id, { exposure: 50, tint: -20 });
    store.getState().seedMaskPanelValues(id, ["hsl", "toneCurve", "teststage.amount"]);

    store
      .getState()
      .clearMaskPanelValues(id, ["exposure", "hsl", "toneCurve", "teststage.amount"]);
    const m = store.getState().params.masks[0];
    expect(m.adj.exposure).toBe(0);
    expect(m.adj.tint).toBe(-20); // not owned by the removed sub-panel
    expect(m.hsl).toBeUndefined();
    expect(m.toneCurve).toBeUndefined();
    expect(m.bag).toBeUndefined();
  });

  it("seeding an unregistered bag key stores nothing", () => {
    store.getState().addRangeComponent("lumRange");
    const id = store.getState().params.masks[0].id;
    store.getState().seedMaskPanelValues(id, ["gone-ext.stage.k"]);
    expect(store.getState().params.masks[0].bag).toBeUndefined();
  });
});

describe("addBrushDab", () => {
  it("appends a dab to a brush component", () => {
    store.getState().addRangeComponent("lumRange");
    const mask = store.getState().params.masks[0];
    const compId = mask.components[0].id;
    // Give the component a brush geometry so dabs can land on it.
    store.getState().updateComponent(mask.id, compId, {
      brush: { dabs: [], feather: 0.5 },
    });
    const dab: BrushDab = { x: 0.5, y: 0.5, radius: 0.05, erase: false, feather: 0.5 };
    store.getState().addBrushDab(mask.id, compId, dab);
    expect(store.getState().params.masks[0].components[0].brush?.dabs).toHaveLength(1);
  });

  it("is a no-op on a component with no brush geometry", () => {
    store.getState().addRangeComponent("lumRange"); // lumRange component, no brush
    const mask = store.getState().params.masks[0];
    const compId = mask.components[0].id;
    const dab: BrushDab = { x: 0.5, y: 0.5, radius: 0.05, erase: false, feather: 0.5 };
    store.getState().addBrushDab(mask.id, compId, dab);
    expect(store.getState().params.masks[0].components[0].brush).toBeUndefined();
  });
});

describe("retouch mutations", () => {
  it("addSpot appends and selects, updateSpot patches, removeSpot clears", () => {
    store.getState().addSpot(spot("s1"));
    expect(store.getState().params.retouch).toHaveLength(1);
    expect(store.getState().selectedSpotId).toBe("s1");

    store.getState().updateSpot("s1", { opacity: 30 });
    expect(store.getState().params.retouch[0].opacity).toBe(30);

    store.getState().removeSpot("s1");
    expect(store.getState().params.retouch).toHaveLength(0);
    expect(store.getState().selectedSpotId).toBeNull();
  });

  it("caps retouch spots at MAX_RETOUCH (32)", () => {
    for (let i = 0; i < 40; i++) store.getState().addSpot(spot(`s${i}`));
    expect(store.getState().params.retouch).toHaveLength(32);
  });
});

describe("tool UI setters", () => {
  it("set the corresponding ephemeral field", () => {
    store.getState().setActiveTool("mask");
    expect(store.getState().activeTool).toBe("mask");
    store.getState().setBrushSize(0.2);
    expect(store.getState().brushSize).toBe(0.2);
    store.getState().setRetouchMode("clone");
    expect(store.getState().retouchMode).toBe("clone");
  });
});
