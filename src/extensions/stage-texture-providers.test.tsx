// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.setStageTextureProvider: stage texture variants made when a frame first
// needs them, held within the extension's texture budget, the least recently
// bound let go first. In the dom project, as stage-texture-variants.test.tsx is.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerProcessingStage, unregisterExtension } from "./registry";
import {
  flushStageTextures,
  getStageTextures,
  needStageVariants,
  noteLiveStageBag,
  setExtensionTextureBudget,
  setStageTexture,
  STAGE_VARIANT_TIMEOUT_MS,
} from "@/rendering/render-bridge";
import { unwireBridge, wireBridge } from "@/rendering/render-bridge/wiring";
import { forgetExtension } from "./extension-kinds";
import { makeScopedAPI } from "./host";
import type { ProcessingStageContribution, StageTextureData } from "./types";

const KEY = "acme.calib.table";
const tex = (): StageTextureData => ({ data: new Uint8Array([0, 0, 0, 255]), width: 1, height: 1, format: "rgba8", version: 1 });
const stage: ProcessingStageContribution = {
  id: "acme.calib",
  name: "Calibration",
  phase: "decode",
  glsl: "",
  uniforms: [],
  textures: [
    { key: "table", kind: "dynamic", format: "rgba8" },
    { key: "other", kind: "dynamic", format: "rgba8" },
  ],
};
const held = () => Object.keys(getStageTextures()).sort();
const bagFor = (variant: string): Record<string, unknown> => ({ [KEY]: variant });
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Draws a frame of `bag`: waits for what it needs, then lets go. */
async function frame(bag: Record<string, unknown>): Promise<string | null> {
  const lease = await needStageVariants(bag);
  lease?.release();
  return lease?.failure ?? null;
}

function fakeBridge() {
  return {
    render: vi.fn(),
    setStageTextures: vi.fn(),
    patchStageTextures: vi.fn(),
    setCacheBudget: vi.fn(),
    setMonitorTransform: vi.fn(),
    setDisplaySpace: vi.fn(),
    syncStages: vi.fn(),
    syncPipeline: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  registerProcessingStage("acme", stage);
});

afterEach(() => {
  unwireBridge();
  noteLiveStageBag({});
  setExtensionTextureBudget(null);
  for (const key of Object.keys(getStageTextures())) setStageTexture(key, null);
  unregisterExtension("acme");
  unregisterExtension("other");
  forgetExtension("acme");
  forgetExtension("other");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("stage texture variants made on demand", () => {
  it("asks once for a variant several frames need at once, and every frame waits for it", async () => {
    const provide = vi.fn(async (_variant: string) => {
      await tick();
      return tex();
    });
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    const failures = await Promise.all([frame(bagFor("v1")), frame(bagFor("v1")), frame(bagFor("v1"))]);
    expect(failures).toEqual([null, null, null]);
    expect(provide).toHaveBeenCalledTimes(1);
    expect(provide).toHaveBeenCalledWith("v1", expect.anything());
    expect(held()).toEqual([`${KEY}#v1`]);
    await frame(bagFor("v1"));
    expect(provide).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for a key without a provider, and does no work for a bag that names no provided variant", async () => {
    const provide = vi.fn(async () => tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    expect(needStageVariants({ "acme.calib.other": "v1" })).toBeNull();
    expect(needStageVariants({})).toBeNull();
    expect(needStageVariants({ [KEY]: 3 })).toBeNull();
    expect(provide).not.toHaveBeenCalled();
  });

  it("draws without a variant its provider says there is none of, and doesn't ask again", async () => {
    const provide = vi.fn(async () => null);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    expect(await frame(bagFor("gone"))).toBeNull();
    expect(await frame(bagFor("gone"))).toBeNull();
    expect(provide).toHaveBeenCalledTimes(1);
    expect(held()).toEqual([]);
  });

  it("fails a frame whose provider fails, with the reason, and asks again for the next", async () => {
    const provide = vi.fn().mockRejectedValueOnce(new Error("the master can't be read")).mockResolvedValue(tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    expect(await frame(bagFor("v1"))).toMatch(/Calibration.*the master can't be read/);
    expect(await frame(bagFor("v1"))).toBeNull();
    expect(provide).toHaveBeenCalledTimes(2);
  });

  it("fails a frame whose provider takes too long", async () => {
    vi.useFakeTimers();
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", () => new Promise(() => undefined));
    const failure = frame(bagFor("v1"));
    await vi.advanceTimersByTimeAsync(STAGE_VARIANT_TIMEOUT_MS);
    expect(await failure).toMatch(/Calibration.*too long/);
  });

  it("asks for what the live view names without making it wait, and draws again once it lands", async () => {
    const bridge = fakeBridge();
    wireBridge(bridge);
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
    const provide = vi.fn(async () => tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    noteLiveStageBag(bagFor("v1"));
    noteLiveStageBag(bagFor("v1"));
    expect(provide).toHaveBeenCalledTimes(1);
    await tick();
    await tick();
    expect(held()).toEqual([`${KEY}#v1`]);
    expect(bridge.render).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("lets go of the least recently bound variant to make room, within the extension's budget", async () => {
    setExtensionTextureBudget(12);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    for (const v of ["v1", "v2", "v3"]) await frame(bagFor(v));
    await frame(bagFor("v1"));
    await frame(bagFor("v4"));
    expect(held()).toEqual([`${KEY}#v1`, `${KEY}#v3`, `${KEY}#v4`]);
  });

  it("never lets go of the variant the open photo's bag names, or one a frame in flight draws with", async () => {
    setExtensionTextureBudget(12);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    await frame(bagFor("live"));
    noteLiveStageBag(bagFor("live"));
    const drawing = await needStageVariants(bagFor("drawing"));
    await frame(bagFor("v3"));
    await frame(bagFor("v4"));
    expect(held()).toEqual([`${KEY}#drawing`, `${KEY}#live`, `${KEY}#v4`]);
    drawing?.release();
  });

  it("fails a frame when everything held is in use and there is no room", async () => {
    setExtensionTextureBudget(8);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    const a = await needStageVariants(bagFor("a"));
    const b = await needStageVariants(bagFor("b"));
    expect(await frame(bagFor("c"))).toMatch(/Calibration can't hold what this photo needs: it would bring its stage textures/);
    a?.release();
    b?.release();
  });

  it("makes room for a texture set directly by letting go of provided variants, and keeps the direct ones", async () => {
    setExtensionTextureBudget(12);
    const api = makeScopedAPI("acme");
    api.setStageTexture("acme.calib", "other", tex());
    api.setStageTextureProvider("acme.calib", "table", async () => tex());
    await frame(bagFor("v1"));
    await frame(bagFor("v2"));
    api.setStageTexture("acme.calib", "other", tex(), "direct");
    expect(held()).toEqual(["acme.calib.other", "acme.calib.other#direct", `${KEY}#v2`]);
    await frame(bagFor("v3"));
    expect(held()).toEqual(["acme.calib.other", "acme.calib.other#direct", `${KEY}#v3`]);
  });

  it("drops a variant the extension says is stale, and asks again when it is next needed", async () => {
    const provide = vi.fn(async () => tex());
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", provide);
    await frame(bagFor("v1"));
    await frame(bagFor("v2"));
    api.dropStageTextureVariants("acme.calib", "table", "v1");
    expect(held()).toEqual([`${KEY}#v2`]);
    await frame(bagFor("v1"));
    expect(provide).toHaveBeenCalledTimes(3);
    api.dropStageTextureVariants("acme.calib", "table");
    expect(held()).toEqual([]);
  });

  it("doesn't keep what a stale request brings, and the frame waiting on it gets the new one", async () => {
    let version = 0;
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", async () => {
      await tick();
      return { ...tex(), data: new Uint8Array([++version, 0, 0, 255]) };
    });
    const waiting = needStageVariants(bagFor("v1"));
    api.dropStageTextureVariants("acme.calib", "table", "v1");
    (await waiting)?.release();
    expect(getStageTextures()[`${KEY}#v1`]?.data[0]).toBe(2);
  });

  it("forgets the provider and its variants with the extension", async () => {
    const provide = vi.fn(async () => tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    await frame(bagFor("v1"));
    unregisterExtension("acme");
    expect(held()).toEqual([]);
    registerProcessingStage("acme", stage);
    expect(needStageVariants(bagFor("v1"))).toBeNull();
  });

  it("prepares a variant ahead of the live view naming it: resolves once it is held, rejects with the reason", async () => {
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", async (variant) => {
      if (variant === "bad") throw new Error("the master can't be read");
      return tex();
    });
    await api.prepareStageTextureVariant("acme.calib", "table", "v1");
    expect(held()).toEqual([`${KEY}#v1`]);
    await expect(api.prepareStageTextureVariant("acme.calib", "table", "bad")).rejects.toThrow(/the master can't be read/);
  });

  it("draws a variant set directly as it was set, without asking the provider", async () => {
    const provide = vi.fn(async () => tex());
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", provide);
    const own = tex();
    api.setStageTexture("acme.calib", "table", own, "v1");
    expect(await frame(bagFor("v1"))).toBeNull();
    expect(provide).not.toHaveBeenCalled();
    expect(getStageTextures()[`${KEY}#v1`]).toBe(own);
  });

  it("refuses another extension's provider", () => {
    makeScopedAPI("other").setStageTextureProvider("acme.calib", "table", async () => tex());
    expect(needStageVariants(bagFor("v1"))).toBeNull();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("lets no other extension stop a provider or drop its variants, even with no stage left for the key", async () => {
    const provide = vi.fn(async () => tex());
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", provide);
    await frame(bagFor("v1"));
    // Taken out on its own, not swept: the provider stays.
    api.unregisterProcessingStage("acme.calib");
    const other = makeScopedAPI("other");
    other.dropStageTextureVariants("acme.calib", "table");
    other.setStageTextureProvider("acme.calib", "table", null);
    expect(held()).toEqual([`${KEY}#v1`]);
    await frame(bagFor("v2"));
    expect(provide).toHaveBeenCalledTimes(2);
  });

  it("asks for the open photo's variant when its provider comes after the live bag was seen", async () => {
    noteLiveStageBag(bagFor("v1"));
    const provide = vi.fn(async () => tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    await tick();
    expect(provide).toHaveBeenCalledWith("v1", expect.anything());
    expect(held()).toEqual([`${KEY}#v1`]);
  });

  it("asks again for what the live view names when the provider is registered again", async () => {
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", async () => tex());
    noteLiveStageBag(bagFor("v1"));
    await tick();
    const again = vi.fn(async () => tex());
    api.setStageTextureProvider("acme.calib", "table", again);
    await tick();
    expect(again).toHaveBeenCalledWith("v1", expect.anything());
    expect(held()).toEqual([`${KEY}#v1`]);
  });

  it("gives up on a provider that never answers once, for every frame waiting, and asks it again after", async () => {
    vi.useFakeTimers();
    const provide = vi.fn(() => new Promise<StageTextureData | null>(() => undefined));
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    noteLiveStageBag(bagFor("v1"));
    const frames = [frame(bagFor("v1")), frame(bagFor("v1"))];
    await vi.advanceTimersByTimeAsync(STAGE_VARIANT_TIMEOUT_MS);
    for (const failure of await Promise.all(frames)) expect(failure).toMatch(/too long/);
    expect(console.warn).toHaveBeenCalledWith(expect.stringMatching(/Calibration took too long/));
    const next = frame(bagFor("v1"));
    await vi.advanceTimersByTimeAsync(0);
    expect(provide).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(STAGE_VARIANT_TIMEOUT_MS);
    await next;
  });

  it("fails a frame waiting on a provider that is turned off, with the reason", async () => {
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", () => new Promise(() => undefined));
    const waiting = frame(bagFor("v1"));
    unregisterExtension("acme");
    expect(await waiting).toMatch(/Calibration was turned off/);
  });

  it("fails an export's frame of a stage turned off since its renderer was built, and only one with fixed stages", async () => {
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    unregisterExtension("acme");
    const fixed = await needStageVariants(bagFor("v1"), { fixedStages: true });
    fixed?.release();
    expect(fixed?.failure).toMatch(/Calibration was turned off/);
    expect(needStageVariants(bagFor("v1"))).toBeNull();
  });

  it("lets a swept extension's providers go, and not another's for a stage whose id extends one of its", async () => {
    registerProcessingStage("other", { ...stage, id: "acme.calib.sub" });
    const own = vi.fn(async () => tex());
    makeScopedAPI("other").setStageTextureProvider("acme.calib.sub", "table", own);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    unregisterExtension("acme");
    expect(await frame({ "acme.calib.sub.table": "v1" })).toBeNull();
    expect(own).toHaveBeenCalledTimes(1);
  });

  it("drops nothing for a name that isn't a variant name, and won't prepare one or a key without a provider", async () => {
    const api = makeScopedAPI("acme");
    api.setStageTextureProvider("acme.calib", "table", async () => tex());
    await frame(bagFor("v1"));
    api.dropStageTextureVariants("acme.calib", "table", "a.b");
    expect(held()).toEqual([`${KEY}#v1`]);
    await expect(api.prepareStageTextureVariant("acme.calib", "table", "a.b")).rejects.toThrow(/isn't a variant name/);
    await expect(api.prepareStageTextureVariant("acme.calib", "other", "v1")).rejects.toThrow(/no provider/);
  });

  it("hands the worker nothing, and doesn't redraw the live view, for a variant only a frame in the window needed", async () => {
    const bridge = fakeBridge();
    wireBridge(bridge);
    const frames: (() => void)[] = [];
    vi.stubGlobal("requestAnimationFrame", (run: () => void) => frames.push(run));
    vi.stubGlobal("cancelAnimationFrame", () => {});
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    await frame(bagFor("v1"));
    for (const run of frames.splice(0)) run();
    flushStageTextures();
    expect(held()).toEqual([`${KEY}#v1`]);
    expect(bridge.patchStageTextures).not.toHaveBeenCalled();
    expect(bridge.render).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("asks for the variant the open photo's saved bag names while the view shows another, and lets go of neither", async () => {
    setExtensionTextureBudget(8);
    const provide = vi.fn(async () => tex());
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", provide);
    await frame(bagFor("old"));
    noteLiveStageBag(bagFor("old"), bagFor("new"));
    await tick();
    expect(provide).toHaveBeenLastCalledWith("new", expect.anything());
    expect(held()).toEqual([`${KEY}#new`, `${KEY}#old`]);
    expect(await frame(bagFor("other"))).toMatch(/can't hold/);
  });

  it("tells a provider to stop on a variant the live view passed by that nothing else waits for", async () => {
    const signals = new Map<string, AbortSignal>();
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", (variant, signal) => {
      signals.set(variant, signal);
      return new Promise(() => undefined);
    });
    noteLiveStageBag({}, bagFor("r20"));
    noteLiveStageBag({}, bagFor("r21"));
    expect(signals.get("r20")?.aborted).toBe(true);
    expect(signals.get("r21")?.aborted).toBe(false);
    const waiting = needStageVariants(bagFor("r21"));
    noteLiveStageBag({}, bagFor("r22"));
    expect(signals.get("r21")?.aborted).toBe(false);
    void waiting;
  });

  it("lets go of the open photo's variants once Develop closes", async () => {
    setExtensionTextureBudget(4);
    makeScopedAPI("acme").setStageTextureProvider("acme.calib", "table", async () => tex());
    await frame(bagFor("v1"));
    noteLiveStageBag(bagFor("v1"));
    expect(await frame(bagFor("v2"))).toMatch(/can't hold/);
    noteLiveStageBag({});
    expect(await frame(bagFor("v2"))).toBeNull();
  });
});
