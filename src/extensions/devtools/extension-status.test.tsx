// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The joined extension list api.devtools.extensions hands Developer Tools:
// running instances, installed ones that are off, failures and dev-folder items.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { devtoolsExtensions } from "./extension-status";
import { reloadDevExtension, useDevFolder, type DevExtItem } from "./dev-folder";
import { useDisabledExtensions, useInstalledPlugins } from "../loader";
import { useRunningPlugins, type RunningInstance } from "../running-plugins";
import { useStartFailures } from "../start-failures";
import { useCallbackFailures } from "../guard";
import type { ExtensionManifest } from "../types";

vi.mock("./dev-folder", async (original) => ({
  ...(await original<typeof import("./dev-folder")>()),
  reloadDevExtension: vi.fn(async () => {}),
}));

const manifest = (id: string, version = "1.0.0"): ExtensionManifest => ({
  id,
  name: `Name of ${id}`,
  version,
  main: "dist/index.js",
});

const list = vi.fn<() => Promise<ExtensionManifest[]>>();

const running = (...instances: RunningInstance[]) =>
  act(() =>
    useRunningPlugins.setState({
      ids: instances.filter((i) => i.source !== "builtin").map((i) => i.id),
      instances,
    }),
  );

const CORE: RunningInstance = { id: "core", source: "builtin", name: "Safelight", version: "9.9.9" };

const devItem = (over: Partial<DevExtItem> = {}): DevExtItem => ({
  id: "acme.dev",
  name: "Dev",
  version: "0.1.0",
  dir: "C:\\dev\\acme",
  status: "loaded",
  ...over,
});

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue([]);
  vi.stubGlobal("safelightNative", { plugins: { list } });
  useRunningPlugins.setState({ ids: [], instances: [] });
  useDisabledExtensions.setState({ ids: [] });
  useInstalledPlugins.setState({ ids: null });
  useStartFailures.setState({}, true);
  useCallbackFailures.setState({}, true);
  useDevFolder.setState({ items: [] });
});

afterEach(() => vi.unstubAllGlobals());

describe("devtoolsExtensions", () => {
  it("lists a running built-in as Safelight", () => {
    running(CORE);
    expect(devtoolsExtensions.get()).toEqual([
      {
        id: "core",
        name: "Safelight",
        version: "9.9.9",
        source: "builtin",
        running: true,
        enabled: true,
        failure: null,
        callbackFailures: 0,
        devError: null,
      },
    ]);
  });

  it("lists an installed extension that is off, from the installed manifests", async () => {
    list.mockResolvedValue([manifest("acme.off", "2.0.0")]);
    useDisabledExtensions.setState({ ids: ["acme.off"] });
    const { result } = renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(result.current.map((e) => e.id)).toEqual(["acme.off"]));
    expect(result.current[0]).toMatchObject({
      name: "Name of acme.off",
      version: "2.0.0",
      source: "installed",
      running: false,
      enabled: false,
    });
  });

  it("marks an installed extension running from its instance", async () => {
    list.mockResolvedValue([manifest("acme.on")]);
    running({ id: "acme.on", source: "installed", name: "Live name", version: "1.0.0" });
    const { result } = renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ id: "acme.on", running: true, enabled: true });
  });

  it("refreshes the manifests when the running, disabled or installed stores change", async () => {
    const { result } = renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    list.mockResolvedValue([manifest("acme.new")]);
    act(() => useInstalledPlugins.setState({ ids: ["acme.new"] }));
    await waitFor(() => expect(result.current.map((e) => e.id)).toEqual(["acme.new"]));
    const calls = list.mock.calls.length;
    act(() => useDisabledExtensions.setState({ ids: ["acme.new"] }));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(calls));
    await waitFor(() => expect(result.current[0]?.enabled).toBe(false));
    const afterDisable = list.mock.calls.length;
    running({ id: "acme.new", source: "installed", name: "n", version: "1.0.0" });
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(afterDisable));
  });

  it("refreshes when the dev folder changes", async () => {
    renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    act(() => useDevFolder.setState({ items: [devItem()] }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  });

  it("reads the installed list once for a burst of changes", async () => {
    renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(list).toHaveBeenCalled());
    const settled = list.mock.calls.length;
    for (let i = 0; i < 5; i++) running({ id: `acme.${i}`, source: "installed", name: "n", version: "1.0.0" });
    act(() => useDevFolder.setState({ scanning: true }));
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(list).toHaveBeenCalledTimes(settled + 1);
  });

  it("joins start failures and callback failures", () => {
    running({ id: "acme.bad", source: "installed", name: "Bad", version: "1.0.0" });
    act(() => {
      useStartFailures.setState({ "acme.bad": { reason: "threw", message: "boom" } });
      useCallbackFailures.setState({ "acme.bad": { kind: "grid filter", error: "x" } });
    });
    expect(devtoolsExtensions.get().find((e) => e.id === "acme.bad")).toMatchObject({
      failure: { reason: "threw", message: "boom" },
      callbackFailures: 1,
    });
  });

  it("lists a dev-folder item with its error and runs from its instance", () => {
    running({ id: "acme.dev", source: "dev", name: "Dev", version: "0.1.0" });
    act(() =>
      useDevFolder.setState({
        items: [devItem(), devItem({ id: "acme.broken", status: "error", error: "no main", version: "" })],
      }),
    );
    const all = devtoolsExtensions.get();
    expect(all.find((e) => e.id === "acme.dev")).toMatchObject({ source: "dev", running: true, devError: null });
    expect(all.find((e) => e.id === "acme.broken")).toMatchObject({
      source: "dev",
      running: false,
      devError: "no main",
    });
  });

  it("lets a dev copy stand for the installed extension of the same id", async () => {
    list.mockResolvedValue([manifest("acme.dev")]);
    running({ id: "acme.dev", source: "dev", name: "Dev", version: "0.1.0" });
    const { result } = renderHook(() => devtoolsExtensions.use());
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => {});
    expect(result.current.filter((e) => e.id === "acme.dev")).toHaveLength(1);
  });

  it("keeps the same list between reads while nothing changed", () => {
    running(CORE);
    const first = devtoolsExtensions.get();
    expect(devtoolsExtensions.get()).toBe(first);
    act(() => useDisabledExtensions.setState({ ids: [] }));
    expect(devtoolsExtensions.get()).toBe(first);
  });

  it("tells a subscriber of a change", () => {
    const listener = vi.fn();
    const off = devtoolsExtensions.subscribe(listener);
    running({ id: "acme.listened", source: "installed", name: "Listened", version: "1.0.0" });
    expect(listener).toHaveBeenCalled();
    off();
  });

  it("lists just the running ones and the dev folder outside the desktop app", () => {
    vi.unstubAllGlobals();
    running(CORE);
    act(() => useDevFolder.setState({ items: [devItem()] }));
    expect(devtoolsExtensions.get().map((e) => e.id)).toEqual(["core", "acme.dev"]);
  });

  it("reloads a dev extension by id through its folder", async () => {
    useDevFolder.setState({ items: [devItem()] });
    await devtoolsExtensions.reloadDev("acme.dev");
    expect(reloadDevExtension).toHaveBeenCalledWith("C:\\dev\\acme");
    await devtoolsExtensions.reloadDev("nope");
    expect(reloadDevExtension).toHaveBeenCalledTimes(1);
  });
});
