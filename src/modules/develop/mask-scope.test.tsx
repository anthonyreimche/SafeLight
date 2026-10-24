// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One panel component serves the dock and any number of masks: useParamScope
// hands it the photo's bag outside a mask and the mask's inside one, behind
// the same reads and writes.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store's mutations broadcast to sibling windows; that side effect is not
// under test and needs no BroadcastChannel here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import type { ReactNode } from "react";
import { act, renderHook } from "@testing-library/react";
import { defaultMaskAdjustments, normalizeParams, type Mask } from "@/catalog/types";
import { registerStageParams, unregisterStageParams } from "@/extensions/param-registry";
import { useDevelopStore } from "@/state/develop-store";
import { MaskScopeProvider, useMaskScope, useParamScope } from "./mask-scope";

const MASK: Mask = {
  id: "m1",
  name: "Mask 1",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [
    { id: "c1", kind: "linear", mode: "add", invert: false, linear: { x0: 0, y0: 0, x1: 1, y1: 0 } },
  ],
};

function seed(bag: Record<string, unknown> = {}, maskBag?: Record<string, unknown>) {
  const params = normalizeParams({ masks: [{ ...MASK, ...(maskBag ? { bag: maskBag } : {}) }] });
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: bag,
    history: [{ timestamp: 0, label: "Original", params, paramBag: bag }],
    historyIndex: 0,
  });
}

const inMask = ({ children }: { children: ReactNode }) => (
  <MaskScopeProvider maskId="m1">{children}</MaskScopeProvider>
);
const maskBag = () => useDevelopStore.getState().params.masks[0].bag;

beforeEach(() => {
  registerStageParams("acme.gain", "Gain", "acme", [{ key: "amount", glslType: "float", default: 1 }]);
});

afterEach(() => unregisterStageParams("acme.gain"));

describe("useParamScope", () => {
  describe("outside a mask", () => {
    it("reads the photo's bag, falling back to the registered default", () => {
      seed({ "acme.gain.other": 3 });
      const { result } = renderHook(() => useParamScope());
      expect(result.current.maskId).toBeNull();
      expect(result.current.getParam("acme.gain.amount")).toBe(1);
      expect(result.current.getParam("acme.gain.other")).toBe(3);
    });

    it("writes the photo's bag and commits one undo step", () => {
      seed();
      const { result } = renderHook(() => useParamScope());
      act(() => result.current.setParams({ "acme.gain.amount": 2, "acme.gain.other": 4 }));
      act(() => result.current.commit("Gain"));
      const state = useDevelopStore.getState();
      expect(state.paramBag).toMatchObject({ "acme.gain.amount": 2, "acme.gain.other": 4 });
      expect(state.history.at(-1)?.label).toBe("Gain");
      expect(maskBag()).toBeUndefined();
    });
  });

  describe("inside a mask", () => {
    it("reads the mask's bag, falling back to the registered default", () => {
      seed({ "acme.gain.amount": 5 }, { "acme.gain.other": 3 });
      const { result } = renderHook(() => useParamScope(), { wrapper: inMask });
      expect(result.current.maskId).toBe("m1");
      expect(result.current.getParam("acme.gain.amount")).toBe(1);
      expect(result.current.getParam("acme.gain.other")).toBe(3);
    });

    it("writes the mask's bag, leaving the photo's alone", () => {
      seed({ "acme.gain.amount": 5 });
      const { result } = renderHook(() => useParamScope(), { wrapper: inMask });
      act(() => result.current.setParams({ "acme.gain.amount": 2 }));
      expect(maskBag()).toEqual({ "acme.gain.amount": 2 });
      expect(useDevelopStore.getState().paramBag).toEqual({ "acme.gain.amount": 5 });
    });

    it("is the mask's own scope", () => {
      seed();
      const { result } = renderHook(() => ({ any: useParamScope(), mask: useMaskScope() }), {
        wrapper: inMask,
      });
      expect(result.current.any).toBe(result.current.mask);
    });
  });
});

// Drags outrun React's renders, so a handler starts each step from what the
// scope holds now, not from the scope its render was handed.
describe("reads in a handler", () => {
  it.each([
    ["outside a mask", undefined],
    ["inside a mask", inMask],
  ])("see a write made since the render, %s", (_label, wrapper) => {
    seed({}, {});
    const { result } = renderHook(() => useParamScope(), { wrapper });
    const rendered = result.current;
    rendered.setParams({ "acme.gain.amount": 2, "acme.gain.other": 4 });
    expect(rendered.getParam("acme.gain.amount")).toBe(2);
    expect(rendered.getParams()).toMatchObject({ "acme.gain.amount": 2, "acme.gain.other": 4 });
  });

  it("hand back the stored values only, defaults left to the reader", () => {
    seed({ "acme.gain.other": 3 }, { "acme.gain.other": 5 });
    const photo = renderHook(() => useParamScope()).result.current;
    const masked = renderHook(() => useParamScope(), { wrapper: inMask }).result.current;
    expect(photo.getParams()).toEqual({ "acme.gain.other": 3 });
    expect(masked.getParams()).toEqual({ "acme.gain.other": 5 });
  });
});

describe("the mask scope's setParams", () => {
  it("writes every value in one store update", () => {
    seed();
    const { result } = renderHook(() => useMaskScope(), { wrapper: inMask });
    let updates = 0;
    const stop = useDevelopStore.subscribe(() => updates++);
    act(() => result.current.setParams({ "acme.gain.amount": 2, "acme.gain.other": 4 }));
    stop();
    expect(updates).toBe(1);
    expect(maskBag()).toEqual({ "acme.gain.amount": 2, "acme.gain.other": 4 });
  });

  it("deletes a key set to undefined", () => {
    seed({}, { "acme.gain.amount": 2, "acme.gain.other": 4 });
    const { result } = renderHook(() => useMaskScope(), { wrapper: inMask });
    act(() => result.current.setParams({ "acme.gain.other": undefined }));
    expect(maskBag()).toEqual({ "acme.gain.amount": 2 });
  });
});
