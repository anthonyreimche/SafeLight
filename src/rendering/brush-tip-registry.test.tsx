// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Brush tips an extension registers (api.develop.registerBrushTip): what the
// window accepts, who may hold an id, that the render worker is handed the set
// (and again after a sweep), and that stopping the extension takes its tips away.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrushTipContribution } from "@/extensions/api/contributions";
import { makeScopedAPI } from "@/extensions/host";
import { unregisterExtension } from "@/extensions/registry";
import { brushTip, setActiveBrushTips } from "./webgl/brush-tips";
import { brushTips, dropBrushTips, registerBrushTip, unwireBrushTips, wireBrushTips } from "./brush-tip-registry";

const tip = (id: string, over: Partial<BrushTipContribution["alpha"]> = {}): BrushTipContribution => ({
  id,
  label: id,
  alpha: { width: 2, height: 2, data: new Uint8Array([0, 255, 255, 0]), ...over },
});

const settled = () => Promise.resolve();

describe("brush tip registry", () => {
  const sink = { setBrushTips: vi.fn(), render: vi.fn() };

  beforeEach(() => {
    sink.setBrushTips.mockClear();
    sink.render.mockClear();
    wireBrushTips(sink);
  });

  afterEach(() => {
    unregisterExtension("acme.brushes");
    unregisterExtension("other.brushes");
    unwireBrushTips();
    setActiveBrushTips({});
    vi.restoreAllMocks();
  });

  it("makes a registered tip available to the bake in this thread", () => {
    registerBrushTip("acme.brushes", tip("chalk"));
    expect(brushTip("chalk")?.label).toBe("chalk");
  });

  it("posts the whole set once for a run of registrations, then redraws", async () => {
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("acme.brushes", tip("sponge"));
    expect(sink.setBrushTips).not.toHaveBeenCalled();
    await settled();
    expect(sink.setBrushTips).toHaveBeenCalledTimes(1);
    expect(Object.keys(sink.setBrushTips.mock.calls[0][0] as object).sort()).toEqual(["chalk", "sponge"]);
    expect(sink.render).toHaveBeenCalledTimes(1);
  });

  it("hands a bridge wired later the tips already registered", () => {
    unwireBrushTips();
    registerBrushTip("acme.brushes", tip("chalk"));
    wireBrushTips(sink);
    expect(Object.keys(sink.setBrushTips.mock.calls[0][0] as object)).toEqual(["chalk"]);
  });

  it.each<[string, BrushTipContribution, RegExp]>([
    ["an empty id", tip(""), /id/],
    ["more than 128 px", tip("big", { width: 129, height: 1, data: new Uint8Array(129) }), /128/],
    ["a fractional width", tip("frac", { width: 1.5 }), /width and height/],
    ["too few values", tip("short", { data: new Uint8Array(3) }), /holds 3 values.*takes 4/],
    ["the wrong array", Object.assign(tip("floats"), { alpha: { width: 2, height: 2, data: new Float32Array(4) } }), /Uint8Array/],
  ])("refuses a tip with %s, and keeps the rest", async (_what, bad, reason) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("acme.brushes", bad);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme\.brushes/);
    expect(warn.mock.calls[0][0]).toMatch(reason);
    expect(brushTip(bad.id)).toBeUndefined();
    expect(brushTip("chalk")).toBeDefined();
  });

  it.each<[string, unknown]>([
    ["no tip at all", null],
    ["no alpha", { id: "bare" }],
  ])("refuses %s with a warning, without throwing", (_what, bad) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const register: (extensionId: string, tip: unknown) => void = registerBrushTip as never;
    expect(() => register("acme.brushes", bad)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme\.brushes/);
    expect(brushTip("bare")).toBeUndefined();
  });

  it("lets an extension replace its own tip but not take another's id", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("acme.brushes", { ...tip("chalk"), label: "Chalk 2" });
    expect(brushTip("chalk")?.label).toBe("Chalk 2");
    registerBrushTip("other.brushes", { ...tip("chalk"), label: "Theirs" });
    expect(brushTip("chalk")?.label).toBe("Chalk 2");
    expect(warn.mock.calls[0][0]).toMatch(/other\.brushes.*chalk.*acme\.brushes/);
  });

  it("drops only one extension's tips, and posts the rest", async () => {
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("other.brushes", tip("sponge"));
    await settled();
    sink.setBrushTips.mockClear();
    dropBrushTips("acme.brushes");
    expect(brushTip("chalk")).toBeUndefined();
    expect(brushTip("sponge")).toBeDefined();
    await settled();
    expect(Object.keys(sink.setBrushTips.mock.calls[0][0] as object)).toEqual(["sponge"]);
  });

  it("is swept when the extension is", () => {
    registerBrushTip("acme.brushes", tip("chalk"));
    unregisterExtension("acme.brushes");
    expect(brushTip("chalk")).toBeUndefined();
  });

  it("is reached as api.develop.registerBrushTip", () => {
    makeScopedAPI("acme.brushes").develop.registerBrushTip(tip("chalk"));
    expect(brushTip("chalk")).toBeDefined();
  });
});

describe("listing brush tips", () => {
  afterEach(() => {
    unregisterExtension("acme.brushes");
    unregisterExtension("other.brushes");
    setActiveBrushTips({});
    vi.restoreAllMocks();
  });

  it("lists every extension's tips in the order they were registered", () => {
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("other.brushes", { ...tip("sponge"), group: "Wet" });
    const listed = makeScopedAPI("other.brushes").develop.brushTips();
    expect(listed.map((t) => t.id)).toEqual(["chalk", "sponge"]);
    expect(listed[1].group).toBe("Wet");
    expect(brushTips()).toBe(brushTips());
  });

  it("re-renders a useBrushTips reader when tips come and go", () => {
    const { result } = renderHook(() => makeScopedAPI("other.brushes").develop.useBrushTips());
    expect(result.current).toEqual([]);
    act(() => registerBrushTip("acme.brushes", tip("chalk")));
    expect(result.current.map((t) => t.id)).toEqual(["chalk"]);
    act(() => dropBrushTips("acme.brushes"));
    expect(result.current).toEqual([]);
  });

  it("lets an extension take back one tip of its own, and not another's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerBrushTip("acme.brushes", tip("chalk"));
    registerBrushTip("acme.brushes", tip("sponge"));
    makeScopedAPI("other.brushes").develop.unregisterBrushTip("chalk");
    expect(brushTip("chalk")).toBeDefined();
    expect(warn.mock.calls[0][0]).toMatch(/other\.brushes.*chalk.*acme\.brushes/);
    makeScopedAPI("acme.brushes").develop.unregisterBrushTip("chalk");
    expect(brushTip("chalk")).toBeUndefined();
    expect(brushTips().map((t) => t.id)).toEqual(["sponge"]);
  });

  it("keeps a tip's brush settings, clamped into their ranges", () => {
    registerBrushTip("acme.brushes", {
      ...tip("cloud"),
      brush: { spacing: 0, scatter: 40, count: 2.6, sizeJitter: 1.5, angleJitter: -1, flowJitter: 0.25, angle: 7, followStroke: true },
    });
    expect(brushTip("cloud")?.brush).toEqual({
      spacing: 0.01,
      scatter: 10,
      count: 3,
      sizeJitter: 1,
      angleJitter: 0,
      flowJitter: 0.25,
      angle: 7 - 2 * Math.PI,
      followStroke: true,
    });
  });

  it("drops brush settings that aren't numbers, and keeps the tip", () => {
    registerBrushTip("acme.brushes", {
      ...tip("odd"),
      brush: { spacing: Number.NaN, count: "two", followStroke: "yes" } as never,
      group: 7 as never,
    });
    expect(brushTip("odd")?.brush).toEqual({});
    expect(brushTip("odd")?.group).toBeUndefined();
  });
});
