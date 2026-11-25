// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Mask component kinds an extension registers (api.develop.registerMaskComponentKind):
// what the window accepts, who owns a type, guarded callbacks, generations, the
// sweep on stop, and the one channel rule for raster components.

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mask } from "@/catalog/types";
import { makeScopedAPI } from "@/extensions/host";
import { unregisterExtension } from "@/extensions/registry";
import {
  maskComponentKind,
  maskComponentKinds,
  maskRasterChannels,
  refreshMaskCoverage,
  registerMaskComponentKind,
  subscribeMaskComponentKinds,
  unregisterMaskComponentKind,
  unregisterMaskComponentKindsOf,
  useMaskComponentKinds,
  type MaskComponentKindContribution,
} from "./mask-component-kinds";

const kind = (name: string, over: Partial<MaskComponentKindContribution> = {}): MaskComponentKindContribution => ({
  name,
  label: name,
  create: () => ({ seeds: [] }),
  coverage: async () => null,
  ...over,
});

const quiet = () => vi.spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
  unregisterMaskComponentKindsOf("acme.fuzzy");
  unregisterMaskComponentKindsOf("other.fuzzy");
  unregisterExtension("acme.fuzzy");
  unregisterExtension("other.fuzzy");
  vi.restoreAllMocks();
});

describe("registering a mask component kind", () => {
  it("holds it under {owner}.{name}", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    const held = maskComponentKind("acme.fuzzy.pick");
    expect(held?.owner).toBe("acme.fuzzy");
    expect(held?.type).toBe("acme.fuzzy.pick");
    expect(held?.label).toBe("pick");
    expect(maskComponentKinds().map((k) => k.type)).toEqual(["acme.fuzzy.pick"]);
  });

  it.each<[string, unknown, RegExp]>([
    ["an upper-case name", kind("Pick"), /name/],
    ["an empty name", kind(""), /name/],
    ["a leading dash", kind("-x"), /name/],
    ["no label", kind("pick", { label: "" }), /label/],
    ["no create", { ...kind("pick"), create: undefined }, /create/],
    ["no coverage", { ...kind("pick"), coverage: undefined }, /coverage/],
    ["nothing at all", null, /object/],
  ])("refuses %s with a warning, without throwing", (_what, bad, reason) => {
    const warn = quiet();
    const register: (owner: string, k: unknown) => void = registerMaskComponentKind as never;
    expect(() => register("acme.fuzzy", bad)).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/acme\.fuzzy/);
    expect(warn.mock.calls[0][0]).toMatch(reason);
    expect(maskComponentKinds()).toEqual([]);
  });

  it("lets an owner replace its own kind, and two owners use the same name", () => {
    const warn = quiet();
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    registerMaskComponentKind("acme.fuzzy", kind("pick", { label: "Pick 2" }));
    expect(maskComponentKind("acme.fuzzy.pick")?.label).toBe("Pick 2");
    registerMaskComponentKind("other.fuzzy", kind("pick"));
    expect(maskComponentKinds()).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("unregisters only by its owner", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    unregisterMaskComponentKind("other.fuzzy", "pick");
    expect(maskComponentKind("acme.fuzzy.pick")).toBeDefined();
    unregisterMaskComponentKind("acme.fuzzy", "pick");
    expect(maskComponentKind("acme.fuzzy.pick")).toBeUndefined();
  });

  it("sweeps one owner's kinds", () => {
    registerMaskComponentKind("acme.fuzzy", kind("a"));
    registerMaskComponentKind("acme.fuzzy", kind("b"));
    registerMaskComponentKind("other.fuzzy", kind("c"));
    unregisterMaskComponentKindsOf("acme.fuzzy");
    expect(maskComponentKinds().map((k) => k.type)).toEqual(["other.fuzzy.c"]);
  });

  it("is swept when the extension stops", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    unregisterExtension("acme.fuzzy");
    expect(maskComponentKind("acme.fuzzy.pick")).toBeUndefined();
  });
});

describe("generations and listeners", () => {
  it("notifies on register, refresh and unregister, and bumps the generation on refresh", () => {
    const listener = vi.fn();
    const off = subscribeMaskComponentKinds(listener);
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    const g = maskComponentKind("acme.fuzzy.pick")?.generation ?? NaN;
    expect(listener).toHaveBeenCalledTimes(1);
    refreshMaskCoverage("acme.fuzzy", "pick");
    expect(maskComponentKind("acme.fuzzy.pick")?.generation).toBe(g + 1);
    expect(listener).toHaveBeenCalledTimes(2);
    unregisterMaskComponentKind("acme.fuzzy", "pick");
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps the generation rising when an owner replaces its kind", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    const g = maskComponentKind("acme.fuzzy.pick")?.generation ?? NaN;
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    expect(maskComponentKind("acme.fuzzy.pick")?.generation).toBeGreaterThan(g);
  });

  it("does not refresh a kind its caller does not own", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    const g = maskComponentKind("acme.fuzzy.pick")?.generation;
    refreshMaskCoverage("other.fuzzy", "pick");
    expect(maskComponentKind("acme.fuzzy.pick")?.generation).toBe(g);
  });

  it("re-renders a hook as kinds come and go", () => {
    const { result } = renderHook(() => useMaskComponentKinds());
    expect(result.current).toEqual([]);
    act(() => registerMaskComponentKind("acme.fuzzy", kind("pick")));
    expect(result.current.map((k) => k.type)).toEqual(["acme.fuzzy.pick"]);
    const before = result.current;
    act(() => refreshMaskCoverage("acme.fuzzy", "pick"));
    expect(result.current).not.toBe(before);
    expect(maskComponentKinds()).toBe(result.current);
  });
});

describe("guarded callbacks", () => {
  it("answers safe values when an extension's callbacks throw, and logs the extension", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = () => {
      throw new Error("nope");
    };
    registerMaskComponentKind(
      "acme.fuzzy",
      kind("pick", {
        create: boom,
        onPoint: boom,
        markers: boom,
        coverage: async () => {
          throw new Error("async nope");
        },
      }),
    );
    const held = maskComponentKind("acme.fuzzy.pick");
    expect(held?.create()).toEqual({});
    expect(held?.onPoint?.({}, { u: 0, v: 0, alt: false, shift: false })).toBeNull();
    expect(held?.markers?.({})).toEqual([]);
    await expect(
      held?.coverage({ photoId: "p", componentId: "c", values: {}, signal: new AbortController().signal }),
    ).resolves.toBeNull();
    expect(error.mock.calls.some((c) => String(c[0]).includes("acme.fuzzy"))).toBe(true);
  });

  it("passes working callbacks through", async () => {
    const bitmap = { width: 1, height: 1, data: new Uint8Array([255]) };
    registerMaskComponentKind(
      "acme.fuzzy",
      kind("pick", {
        create: () => ({ a: 1 }),
        onPoint: (v, p) => ({ ...v, u: p.u }),
        markers: () => [{ u: 0.5, v: 0.5 }],
        coverage: async () => bitmap,
      }),
    );
    const held = maskComponentKind("acme.fuzzy.pick");
    expect(held?.create()).toEqual({ a: 1 });
    expect(held?.onPoint?.({}, { u: 0.25, v: 0, alt: false, shift: false })).toEqual({ u: 0.25 });
    expect(held?.markers?.({})).toEqual([{ u: 0.5, v: 0.5 }]);
    await expect(
      held?.coverage({ photoId: "p", componentId: "c", values: {}, signal: new AbortController().signal }),
    ).resolves.toBe(bitmap);
  });

  it("leaves optional callbacks absent when the extension gave none", () => {
    registerMaskComponentKind("acme.fuzzy", kind("pick"));
    const held = maskComponentKind("acme.fuzzy.pick");
    expect(held?.onPoint).toBeUndefined();
    expect(held?.markers).toBeUndefined();
  });
});

describe("api.develop", () => {
  it("reaches the registry as the extension, own kinds only", () => {
    const api = makeScopedAPI("acme.fuzzy").develop;
    api.registerMaskComponentKind(kind("pick"));
    expect(api.maskComponentKinds().map((k) => k.type)).toEqual(["acme.fuzzy.pick"]);
    const g = maskComponentKind("acme.fuzzy.pick")?.generation ?? NaN;
    api.refreshMaskCoverage("pick");
    expect(maskComponentKind("acme.fuzzy.pick")?.generation).toBe(g + 1);
    makeScopedAPI("other.fuzzy").develop.unregisterMaskComponentKind("pick");
    expect(maskComponentKind("acme.fuzzy.pick")).toBeDefined();
    api.unregisterMaskComponentKind("pick");
    expect(maskComponentKind("acme.fuzzy.pick")).toBeUndefined();
  });

  it("offers the shared channel rule", () => {
    expect(makeScopedAPI("acme.fuzzy").develop.maskRasterChannels).toBe(maskRasterChannels);
  });
});

const extComponent = (id: string, withExtension = true) => ({
  id,
  kind: "extension" as const,
  mode: "add" as const,
  invert: false,
  ...(withExtension ? { extension: { type: "a.b", values: {} } } : {}),
});
const lin = (id: string) => ({ id, kind: "linear" as const, mode: "add" as const, invert: false });
const maskOf = (...components: Mask["components"]): Mask => ({ id: "m", components }) as Mask;

describe("maskRasterChannels", () => {
  it("numbers extension components across masks in order, 0..3", () => {
    const masks = [maskOf(lin("l"), extComponent("a"), extComponent("b")), maskOf(extComponent("c"))];
    expect(maskRasterChannels(masks)).toEqual({ a: 0, b: 1, c: 2 });
  });

  it("gives the fifth and later -1", () => {
    const masks = [maskOf(...["a", "b", "c", "d", "e", "f"].map((id) => extComponent(id)))];
    expect(maskRasterChannels(masks)).toEqual({ a: 0, b: 1, c: 2, d: 3, e: -1, f: -1 });
  });

  it("skips components with no extension set, and other kinds", () => {
    const masks = [maskOf(extComponent("x", false), lin("l"), extComponent("a"))];
    expect(maskRasterChannels(masks)).toEqual({ a: 0 });
  });

  it("is empty for no masks, and the same object for the same array", () => {
    expect(maskRasterChannels([])).toEqual({});
    const masks = [maskOf(extComponent("a"))];
    expect(maskRasterChannels(masks)).toBe(maskRasterChannels(masks));
  });
});
