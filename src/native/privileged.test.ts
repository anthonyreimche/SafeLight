// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions share the renderer realm with core, so the only thing keeping raw
// filesystem access and the update installer out of their reach is that core
// claims the preload's one-shot first and keeps the reference module-private.
// These tests pin that: the one-shot is spent exactly once, and a second caller
// can neither observe nor replace what core captured. The module holds its claim
// in module scope, so each case re-imports it. Run with `npm test`.

import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  NativeFsBridge,
  NativeUpdatesBridge,
  PrivilegedBridge,
} from "@/extensions/types";

/** A bridge whose pickDirectory() answers with `tag`, so a captured reference
 *  can be traced back to the bundle it came from. */
const fsBridge = (tag: string): NativeFsBridge => ({
  read: () => Promise.resolve({ data: new Uint8Array(), mtimeMs: 0, size: 0 }),
  write: () => Promise.resolve(),
  list: () => Promise.resolve([]),
  mkdir: () => Promise.resolve(),
  remove: () => Promise.resolve(),
  move: () => Promise.resolve(),
  exists: () => Promise.resolve(false),
  pickDirectory: () => Promise.resolve(tag),
  reveal: () => Promise.resolve(true),
});

const updatesBridge = (): NativeUpdatesBridge => ({ install: () => Promise.resolve() });

const bundle = (tag: string): PrivilegedBridge => ({
  fs: fsBridge(tag),
  updates: updatesBridge(),
});

/** Re-import the module against a fresh preload surface. `oneShot` stands in for
 *  the preload's claimPrivileged; omit it for the plain-browser build. */
async function boot(oneShot?: () => PrivilegedBridge | null) {
  vi.resetModules();
  vi.stubGlobal("window", {
    safelightNative: oneShot ? { claimPrivileged: oneShot } : {},
  });
  return import("./privileged.ts");
}

/** The preload's real behaviour: hands the bundle over once, then null forever. */
function preloadOneShot(tag: string) {
  const held = bundle(tag);
  let spent = false;
  return vi.fn(() => {
    if (spent) return null;
    spent = true;
    return held;
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claimPrivileged", () => {
  it("captures the bundle and exposes it to core", async () => {
    const mod = await boot(preloadOneShot("core"));

    mod.claimPrivileged();

    await expect(mod.privilegedFs()?.pickDirectory()).resolves.toBe("core");
    expect(mod.privilegedUpdates()).not.toBeNull();
  });

  it("spends the preload's one-shot exactly once, however often it is called", async () => {
    const oneShot = preloadOneShot("core");
    const mod = await boot(oneShot);

    mod.claimPrivileged();
    mod.claimPrivileged();
    mod.claimPrivileged();

    expect(oneShot).toHaveBeenCalledTimes(1);
    await expect(mod.privilegedFs()?.pickDirectory()).resolves.toBe("core");
  });

  it("cannot be re-claimed with a substituted bundle", async () => {
    const mod = await boot(preloadOneShot("core"));
    mod.claimPrivileged();

    // Whatever runs after boot — an extension, a late core module — cannot make
    // the module hand out a bridge of its choosing.
    vi.stubGlobal("window", {
      safelightNative: { claimPrivileged: () => bundle("attacker") },
    });
    mod.claimPrivileged();

    await expect(mod.privilegedFs()?.pickDirectory()).resolves.toBe("core");
  });

  it("leaves nothing for a second caller of the preload one-shot", async () => {
    const oneShot = preloadOneShot("core");
    const mod = await boot(oneShot);

    mod.claimPrivileged();

    // What extension code finds when it reaches for window.safelightNative.
    expect(oneShot()).toBeNull();
    await expect(mod.privilegedFs()?.pickDirectory()).resolves.toBe("core");
  });
});

describe("lazy claim from the accessors", () => {
  it("claims on first use when boot never got to it", async () => {
    const oneShot = preloadOneShot("core");
    const mod = await boot(oneShot);

    await expect(mod.privilegedFs()?.pickDirectory()).resolves.toBe("core");
    expect(oneShot).toHaveBeenCalledTimes(1);
  });

  it("does not re-enter the one-shot on later accessor calls", async () => {
    const oneShot = preloadOneShot("core");
    const mod = await boot(oneShot);

    mod.privilegedFs();
    mod.privilegedUpdates();
    mod.privilegedFs();
    mod.claimPrivileged();

    expect(oneShot).toHaveBeenCalledTimes(1);
  });
});

describe("builds without the privileged bridge", () => {
  it("returns null when the preload exposes no one-shot", async () => {
    const mod = await boot();

    expect(() => mod.claimPrivileged()).not.toThrow();
    expect(mod.privilegedFs()).toBeNull();
    expect(mod.privilegedUpdates()).toBeNull();
  });

  it("returns null when the one-shot was already spent before core ran", async () => {
    const mod = await boot(() => null);

    expect(mod.privilegedFs()).toBeNull();
    expect(mod.privilegedUpdates()).toBeNull();
  });
});
