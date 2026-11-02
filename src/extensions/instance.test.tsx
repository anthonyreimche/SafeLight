// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One list of what is running, whether an extension was installed or loaded
// from the developer's folder: a start from either source is found, replaced
// and stopped through the same calls.

import { afterEach, describe, expect, it, vi } from "vitest";
import "./host";
import {
  isInstanceLive,
  startBuiltin,
  startInstance,
  stopBuiltin,
  stopInstance,
  stopInstances,
  takeDisplaced,
  type InstanceSource,
} from "./instance";
import type { BuiltinExtension } from "./builtin";
import { EXTENSION_TIMEOUT_MS } from "./guard";
import { useRunningPlugins } from "./running-plugins";
import { useStartFailures } from "./start-failures";
import type { ExtensionModule, SafelightAPI } from "./types";
import { setExtSetting } from "./ext-settings";
import { setSourcePixels } from "@/rendering/source-pixels";
import { broadcast } from "@/state/broadcast";

const IDS = ["acme.installed", "acme.dev", "acme.both"];

const BUILTIN: BuiltinExtension = {
  id: "acme.builtin",
  name: "Built-in",
  version: "1.0.0",
  activate: () => {
    throw new Error("no good");
  },
};

afterEach(() => {
  for (const id of IDS) stopInstance(id);
});

function bundle(id: string, source: InstanceSource, mod: Partial<ExtensionModule>) {
  const release = vi.fn();
  const start = startInstance({
    id,
    source,
    bundle: `${source}:${id}`,
    read: async () => ({ load: async () => mod, release }),
  });
  return { start, release };
}

describe("startInstance", () => {
  it("records an extension from either source as running, once started", async () => {
    await bundle("acme.installed", "installed", { activate: vi.fn() }).start;
    await bundle("acme.dev", "dev", { activate: vi.fn() }).start;
    expect(isInstanceLive("acme.installed")).toBe(true);
    expect(isInstanceLive("acme.dev")).toBe(true);
    expect(useRunningPlugins.getState().ids).toEqual(
      expect.arrayContaining(["acme.installed", "acme.dev"]),
    );
  });

  it("rejects a bundle with no activate and frees what it was read from", async () => {
    const { start, release } = bundle("acme.dev", "dev", {});
    await expect(start).rejects.toThrow("acme.dev: bundle has no activate(api) export");
    expect(release).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.dev")).toBe(false);
  });

  it("drops a start no longer wanted once its bundle is in, without activating or reporting it", async () => {
    const activate = vi.fn();
    const release = vi.fn();
    await startInstance({
      id: "acme.installed",
      source: "installed",
      bundle: "installed:acme.installed",
      read: async () => ({ load: async () => ({ activate }), release }),
      stillWanted: () => false,
    });
    expect(activate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.installed")).toBe(false);
    expect(useStartFailures.getState()["acme.installed"]).toBeUndefined();
  });

  it("activates a start still wanted once its bundle is in", async () => {
    const activate = vi.fn();
    await startInstance({
      id: "acme.installed",
      source: "installed",
      bundle: "installed:acme.installed",
      read: async () => ({ load: async () => ({ activate }) }),
      stillWanted: () => true,
    });
    expect(activate).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.installed")).toBe(true);
  });

  it("frees the bundle and records nothing when activate throws", async () => {
    const { start, release } = bundle("acme.dev", "dev", {
      activate: () => {
        throw new Error("boom");
      },
    });
    await expect(start).rejects.toThrow("boom");
    expect(release).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.dev")).toBe(false);
  });
});

describe("start failures", () => {
  afterEach(() => {
    useStartFailures.setState({}, true);
    stopBuiltin(BUILTIN);
    vi.useRealTimers();
  });

  it("records an activate that threw, from either source", async () => {
    const activate = () => {
      throw new Error("boom");
    };
    await expect(bundle("acme.installed", "installed", { activate }).start).rejects.toThrow("boom");
    await expect(bundle("acme.dev", "dev", { activate }).start).rejects.toThrow("boom");
    expect(useStartFailures.getState()["acme.installed"]).toEqual({ reason: "threw", message: "boom" });
    expect(useStartFailures.getState()["acme.dev"]).toEqual({ reason: "threw", message: "boom" });
  });

  it("records an activate that did not finish in time as timed out", async () => {
    vi.useFakeTimers();
    const { start } = bundle("acme.hung", "installed", { activate: () => new Promise<void>(() => {}) });
    const settled = expect(start).rejects.toThrow("did not finish");
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    await settled;
    expect(useStartFailures.getState()["acme.hung"]).toEqual({
      reason: "timed out",
      message: expect.stringContaining("did not finish"),
    });
  });

  it("records a bundle with no activate", async () => {
    await expect(bundle("acme.dev", "dev", {}).start).rejects.toThrow();
    expect(useStartFailures.getState()["acme.dev"]?.reason).toBe("threw");
  });

  it("forgets the failure when the extension starts afterwards", async () => {
    await expect(bundle("acme.dev", "dev", { activate: () => { throw new Error("boom"); } }).start).rejects.toThrow();
    await bundle("acme.dev", "dev", { activate: vi.fn() }).start;
    expect(useStartFailures.getState()["acme.dev"]).toBeUndefined();
  });

  it("forgets the failure when the extension is stopped", async () => {
    await expect(bundle("acme.dev", "dev", { activate: () => { throw new Error("boom"); } }).start).rejects.toThrow();
    stopInstance("acme.dev");
    expect(useStartFailures.getState()["acme.dev"]).toBeUndefined();
  });

  it("records a built-in whose activate threw, and forgets it once stopped", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    startBuiltin(BUILTIN);
    expect(useStartFailures.getState()[BUILTIN.id]).toEqual({ reason: "threw", message: "no good" });
    stopBuiltin(BUILTIN);
    expect(useStartFailures.getState()[BUILTIN.id]).toBeUndefined();
  });
});

describe("stopInstance", () => {
  it("deactivates, forgets and frees the bundle, and says it is no longer running", async () => {
    const deactivate = vi.fn();
    const { start, release } = bundle("acme.dev", "dev", { activate: vi.fn(), deactivate });
    await start;
    stopInstance("acme.dev");
    expect(deactivate).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.dev")).toBe(false);
    expect(useRunningPlugins.getState().ids).not.toContain("acme.dev");
  });

  it("still stops and forgets an extension whose deactivate throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { start, release } = bundle("acme.dev", "dev", {
      activate: vi.fn(),
      deactivate: () => {
        throw new Error("stuck");
      },
    });
    await start;
    stopInstance("acme.dev");
    expect(isInstanceLive("acme.dev")).toBe(false);
    expect(release).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("what an extension subscribed to", () => {
  // Subscribes and never unsubscribes, as a deactivate that forgets would.
  function subscriber(heard: { settings: () => void; pixels: () => void; broadcast: () => void }) {
    return {
      activate: (api: SafelightAPI) => {
        api.settings.onChange(heard.settings);
        api.develop.onSourcePixels(heard.pixels);
        api.events.onBroadcast(heard.broadcast);
      },
    };
  }

  function fire(): void {
    setExtSetting("acme.installed", "k", Math.random());
    setSourcePixels(new Uint8ClampedArray(4), 1, 1);
    broadcast({ type: "selection-change", payload: { activePhotoId: "p1" } });
  }

  it("stops reaching it once the extension is stopped", async () => {
    const heard = { settings: vi.fn(), pixels: vi.fn(), broadcast: vi.fn() };
    await bundle("acme.installed", "installed", subscriber(heard)).start;
    stopInstance("acme.installed");
    fire();
    expect(heard.settings).not.toHaveBeenCalled();
    expect(heard.pixels).not.toHaveBeenCalled();
    expect(heard.broadcast).not.toHaveBeenCalled();
  });

  it("leaves only the new version listening after an update", async () => {
    const before = { settings: vi.fn(), pixels: vi.fn(), broadcast: vi.fn() };
    const after = { settings: vi.fn(), pixels: vi.fn(), broadcast: vi.fn() };
    await bundle("acme.installed", "installed", subscriber(before)).start;
    stopInstance("acme.installed");
    await bundle("acme.installed", "installed", subscriber(after)).start;
    fire();
    for (const cb of Object.values(before)) expect(cb).not.toHaveBeenCalled();
    for (const cb of Object.values(after)) expect(cb).toHaveBeenCalledOnce();
  });
});

describe("stopInstances", () => {
  it("stops only the extensions that came from one source", async () => {
    await bundle("acme.installed", "installed", { activate: vi.fn() }).start;
    await bundle("acme.dev", "dev", { activate: vi.fn() }).start;
    stopInstances("dev");
    expect(isInstanceLive("acme.dev")).toBe(false);
    expect(isInstanceLive("acme.installed")).toBe(true);
  });
});

describe("one id, two sources", () => {
  it("has a single answer: the dev copy that replaced the installed one is the one stopped", async () => {
    const installed = { activate: vi.fn(), deactivate: vi.fn() };
    const dev = { activate: vi.fn(), deactivate: vi.fn() };
    await bundle("acme.both", "installed", installed).start;
    stopInstance("acme.both");
    await bundle("acme.both", "dev", dev).start;
    expect(installed.deactivate).toHaveBeenCalledOnce();
    stopInstances("installed");
    expect(isInstanceLive("acme.both")).toBe(true);
    stopInstances("dev");
    expect(dev.deactivate).toHaveBeenCalledOnce();
    expect(isInstanceLive("acme.both")).toBe(false);
  });
});

describe("a dev copy that takes over an installed extension's id", () => {
  it("stops the installed copy and hands its id back once the dev copy is gone", async () => {
    const installed = { activate: vi.fn(), deactivate: vi.fn() };
    await bundle("acme.both", "installed", installed).start;
    await bundle("acme.both", "dev", { activate: vi.fn() }).start;
    expect(installed.deactivate).toHaveBeenCalledOnce();
    expect(takeDisplaced()).toEqual([]); // the dev copy still holds the id
    stopInstances("dev");
    expect(takeDisplaced()).toEqual(["acme.both"]);
    expect(takeDisplaced()).toEqual([]);
  });

  it("is not displacing anything when it replaces an earlier dev copy", async () => {
    await bundle("acme.both", "dev", { activate: vi.fn() }).start;
    await bundle("acme.both", "dev", { activate: vi.fn() }).start;
    stopInstances("dev");
    expect(takeDisplaced()).toEqual([]);
  });
});

describe("stopInstance with a source", () => {
  it("leaves a copy from another source running", async () => {
    const deactivate = vi.fn();
    await bundle("acme.dev", "dev", { activate: vi.fn(), deactivate }).start;
    stopInstance("acme.dev", "installed");
    expect(deactivate).not.toHaveBeenCalled();
    expect(isInstanceLive("acme.dev", "dev")).toBe(true);
    expect(isInstanceLive("acme.dev", "installed")).toBe(false);
  });
});
