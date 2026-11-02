// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension code the core waits on (starting a bundle, a catalog hook) runs
// through guardExtension: whatever it throws, rejects with or hangs on comes
// back as a rejection the caller can log and move past.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CALLBACK_FAILURE_LIMIT,
  EXTENSION_TIMEOUT_MS,
  activateFenced,
  createLoadTracker,
  fenceAPI,
  guardCallback,
  guardExtension,
  useCallbackFailures,
} from "./guard";
import type { SafelightAPI } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guardExtension", () => {
  it("runs the work at once and hands back what it returns", async () => {
    const run = vi.fn(() => 7);
    const guarded = guardExtension("acme.x", run);
    expect(run).toHaveBeenCalledOnce();
    await expect(guarded).resolves.toBe(7);
  });

  it("waits for work that returns a promise", async () => {
    await expect(guardExtension("acme.x", async () => "done")).resolves.toBe("done");
  });

  it("rejects with what the work throws, whether at once or later", async () => {
    await expect(
      guardExtension("acme.x", () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(guardExtension("acme.x", () => Promise.reject(new Error("late boom")))).rejects.toThrow(
      "late boom",
    );
  });

  it("gives up on work that never finishes, and tells it so", async () => {
    let signal: AbortSignal | undefined;
    const guarded = guardExtension("acme.x", (s) => {
      signal = s;
      return new Promise<never>(() => {});
    });
    const outcome = expect(guarded).rejects.toThrow("acme.x did not finish within 15 s");
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await outcome;
    expect(signal?.aborted).toBe(true);
  });

  it("leaves work that finished in time alone", async () => {
    let signal: AbortSignal | undefined;
    await guardExtension("acme.x", (s) => {
      signal = s;
    });
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    expect(signal?.aborted).toBe(false);
  });
});

// A start that no longer counts keeps the API it was handed, so every way it
// could add to or change the live copy's contributions is refused from then on.
describe("fenceAPI", () => {
  const Panel = () => null;
  const fake = () => ({
    extensionId: "acme.x",
    registerPanel: vi.fn(),
    setStageTexture: vi.fn(),
    settings: { get: vi.fn((_key: string) => 1), set: vi.fn(), onChange: vi.fn() },
    events: { onBroadcast: vi.fn() },
    stores: { subscribeAll: vi.fn() },
    components: { Panel },
    catalog: {
      getEditState: vi.fn(() => null),
      putEditState: vi.fn(),
      putPhotoData: vi.fn(),
      addPhotos: vi.fn(),
      renamePhoto: vi.fn(),
    },
    themes: { apply: vi.fn() },
    dock: { togglePanel: vi.fn() },
  });
  const fenced = (api: ReturnType<typeof fake>, signal: AbortSignal) =>
    fenceAPI(api as unknown as SafelightAPI, signal) as unknown as ReturnType<typeof fake>;

  it("passes every call through while the start counts", () => {
    const api = fake();
    const f = fenced(api, new AbortController().signal);
    f.registerPanel("p");
    f.settings.onChange("cb");
    expect(api.registerPanel).toHaveBeenCalledWith("p");
    expect(api.settings.onChange).toHaveBeenCalledWith("cb");
  });

  it("refuses registrations, setters and subscriptions, also one level down, once it no longer counts", () => {
    const api = fake();
    const controller = new AbortController();
    const f = fenced(api, controller.signal);
    controller.abort();
    const refused = "acme.x: this start no longer counts";
    expect(() => f.registerPanel("p")).toThrow(refused);
    expect(() => f.setStageTexture("t")).toThrow(refused);
    expect(() => f.settings.set("k", 1)).toThrow(refused);
    expect(() => f.settings.onChange("cb")).toThrow(refused);
    expect(() => f.events.onBroadcast("cb")).toThrow(refused);
    expect(() => f.stores.subscribeAll("cb")).toThrow(refused);
    expect(() => f.catalog.putEditState()).toThrow(refused);
    expect(() => f.catalog.putPhotoData()).toThrow(refused);
    expect(() => f.catalog.addPhotos()).toThrow(refused);
    expect(() => f.catalog.renamePhoto()).toThrow(refused);
    expect(() => f.themes.apply()).toThrow(refused);
    expect(() => f.dock.togglePanel()).toThrow(refused);
    expect(f.catalog.getEditState()).toBeNull();
    expect(api.settings.onChange).not.toHaveBeenCalled();
    expect(f.settings.get("k")).toBe(1);
    expect(f.components.Panel).toBe(Panel);
  });

  it("hands back the same functions and namespaces on every read", () => {
    const f = fenced(fake(), new AbortController().signal);
    expect(f.setStageTexture).toBe(f.setStageTexture);
    expect(f.settings).toBe(f.settings);
    expect(f.settings.onChange).toBe(f.settings.onChange);
  });
});

// A start that finished after it stopped counting is stopped with its own
// deactivate, which may still call the API on its way to clearing its timers.
describe("stopping a start that no longer counts", () => {
  it("lets its deactivate run to the end, with its API calls doing nothing", async () => {
    const api = { extensionId: "acme.x", unregisterPanel: vi.fn(), settings: { set: vi.fn() } };
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    let cleanedUp = false;
    let held: typeof api | undefined;
    const mod = {
      activate: async (given: SafelightAPI) => {
        held = given as unknown as typeof api;
        await gate;
      },
      deactivate: () => {
        held?.unregisterPanel("p");
        held?.settings.set("k", 1);
        cleanedUp = true;
      },
    };
    const load = createLoadTracker<typeof mod>();
    const loading = load(
      "acme.x",
      "bundle.js",
      async (signal) => {
        await activateFenced(mod, api as unknown as SafelightAPI, signal);
        return mod;
      },
      { sweep: () => {}, stop: (started) => started.deactivate() },
    ).catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    expect(await loading).toMatchObject({ message: "acme.x did not finish within 15 s" });

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanedUp).toBe(true);
    expect(api.unregisterPanel).not.toHaveBeenCalled();
    expect(api.settings.set).not.toHaveBeenCalled();
  });
});

describe("guardCallback", () => {
  beforeEach(() => {
    useCallbackFailures.setState({}, true);
  });

  it("hands back what the callback returns", () => {
    const double = guardCallback("acme.ok", "grid filter", (n: number) => n * 2, 0);
    expect(double(4)).toBe(8);
  });

  it("answers the fallback when the callback throws, logging once per extension and kind", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const boom = (): boolean => {
      throw new Error("boom");
    };
    expect(guardCallback("acme.once", "grid filter", boom, true)()).toBe(true);
    expect(guardCallback("acme.once", "grid filter", boom, true)()).toBe(true);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain("acme.once");
    guardCallback("acme.once", "library sort", () => {
      throw new Error("boom");
    }, 0)();
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it(`stops calling a callback after ${CALLBACK_FAILURE_LIMIT} throws and records the extension as failed`, () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const compare = vi.fn((): number => {
      throw new Error("bad compare");
    });
    const guarded = guardCallback("acme.sort", "library sort", compare, 0);
    for (let i = 0; i < CALLBACK_FAILURE_LIMIT + 5; i++) expect(guarded()).toBe(0);
    expect(compare).toHaveBeenCalledTimes(CALLBACK_FAILURE_LIMIT);
    expect(useCallbackFailures.getState()["acme.sort"]).toEqual({ kind: "library sort", error: "bad compare" });

    // Registered again with a new function, it gets a fresh start.
    const fixed = vi.fn(() => 1);
    expect(guardCallback("acme.sort", "library sort", fixed, 0)()).toBe(1);
    error.mockRestore();
  });
});
