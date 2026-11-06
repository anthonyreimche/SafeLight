// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Updates tab's Update all: it installs every update the badge counts,
// passes over one kept at an older version, and says which ones failed. The
// real loader runs; only the bundle import is replaced (the app:// protocol is
// out of jsdom's reach), with a module whose activate does nothing.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "./host";
import { ConfirmDialogHost } from "@/ui/components/ConfirmDialog";
import { ExtensionManagerPanel } from "./ExtensionManagerPanel";
import { importPluginModule } from "./plugin-module";
import { useDisabledExtensions } from "./loader";
import { usePins } from "./pins";
import { useRegistry } from "./registry";
import { useExtStoreUI } from "./store-ui";
import type { ExtensionManifest, NativePluginsBridge } from "./types";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

let privilegedBridge: NativePluginsBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedPlugins: () => privilegedBridge,
}));

const ext = (name: string, version: string): ExtensionManifest => ({
  id: `acme.${name.toLowerCase()}`,
  name,
  version,
  main: "index.js",
  repository: `acme/${name.toLowerCase()}`,
});

const importer = vi.mocked(importPluginModule);
let installed: Map<string, ExtensionManifest>;
let installBridge: Mock;

const mountStore = async (...names: string[]) => {
  installed = new Map(names.map((n) => [`acme/${n.toLowerCase()}`, ext(n, "1.0.0")]));
  vi.stubGlobal("safelightNative", {
    plugins: {
      list: async () => [...installed.values()],
      remoteManifest: async () => ({ version: "2.1.0" }),
      releases: async () => [],
    },
  });
  const user = userEvent.setup();
  render(
    <>
      <ExtensionManagerPanel />
      <ConfirmDialogHost />
    </>,
  );
  await user.click(screen.getByRole("button", { name: /^Updates/ }));
  return user;
};

beforeEach(() => {
  localStorage.clear();
  installBridge = vi.fn(async (spec: string, version?: string) => {
    const next = { ...installed.get(spec)!, version: version ?? "2.1.0" };
    installed.set(spec, next);
    return next;
  });
  privilegedBridge = {
    install: installBridge,
    uninstall: vi.fn(async () => {}),
    settleUpdate: vi.fn(async () => null),
  };
  importer.mockReset();
  importer.mockResolvedValue({ activate: () => {} });
  useRegistry.setState({ stylesheets: {}, modules: {} });
  useDisabledExtensions.setState({ ids: [] });
  useExtStoreUI.setState({ view: "list", selected: null, updates: {}, releases: {} });
  usePins.setState({ pins: {} });
});

afterEach(() => {
  vi.unstubAllGlobals();
  usePins.setState({ pins: {} });
});

describe("ExtensionManagerPanel Update all", () => {
  it("updates every counted extension and passes over a kept one", async () => {
    usePins.setState({ pins: { "acme.gizmo": "1.0.0" } });
    const user = await mountStore("Widget", "Gadget", "Gizmo");
    await user.click(await screen.findByRole("button", { name: "Update all (2)" }));
    await screen.findByText("Updated 2 extensions.");
    expect(installBridge).toHaveBeenCalledWith("acme/widget", "2.1.0");
    expect(installBridge).toHaveBeenCalledWith("acme/gadget", "2.1.0");
    expect(installBridge).not.toHaveBeenCalledWith("acme/gizmo", expect.anything());
  });

  it("names the extensions that failed to update", async () => {
    const user = await mountStore("Widget", "Gadget");
    installBridge.mockImplementation(async (spec: string, version?: string) => {
      if (spec === "acme/gadget") throw new Error("download failed");
      const next = { ...installed.get(spec)!, version: version ?? "2.1.0" };
      installed.set(spec, next);
      return next;
    });
    await user.click(await screen.findByRole("button", { name: "Update all (2)" }));
    await screen.findByText("Updated 1 of 2. Couldn't update Gadget: download failed.");
  });

  it("offers no Update all when every update is kept back", async () => {
    usePins.setState({ pins: { "acme.widget": "1.0.0" } });
    await mountStore("Widget");
    await screen.findByText("Kept at 1.0.0 · 2.1.0 is available");
    expect(screen.queryByRole("button", { name: /^Update all/ })).toBeNull();
  });

  it("holds the other buttons while it runs", async () => {
    const held: (() => void)[] = [];
    const user = await mountStore("Widget", "Gadget");
    installBridge.mockImplementation(
      (spec: string, version?: string) =>
        new Promise((resolve) => {
          held.push(() => {
            const next = { ...installed.get(spec)!, version: version ?? "2.1.0" };
            installed.set(spec, next);
            resolve(next);
          });
        }),
    );
    await user.click(await screen.findByRole("button", { name: "Update all (2)" }));
    await screen.findByRole("button", { name: "Updating 0 of 2…" });
    for (const b of screen.getAllByRole("button", { name: "Update" }))
      expect((b as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(held).toHaveLength(2));
    for (const go of held) go();
    await screen.findByText("Updated 2 extensions.");
  });
});
