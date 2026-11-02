// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main window routes to an extension-registered module, and hands back to
// Library when that module's extension goes away under it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "./App";
import { useUIStore } from "@/state/ui-store";
import { useProjectStore } from "@/project/project-store";
import {
  registerModule,
  registerPanel,
  unregisterExtension,
  useRegistry,
} from "@/extensions/registry";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useTrust } from "@/extensions/trust";
import { openSetup, resetSetupForTests } from "@/modules/welcome/setup/setup-store";
import { closeReportIssue } from "@/ui/components/report-issue-store";
import { useGraphics } from "@/state/graphics-store";
import { registerEssentialModules } from "@/test/essential-modules.test-support";

/** The main window has no other windows to sync with here. */
class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  useRegistry.setState({ modules: {} });
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  useProjectStore.setState({
    root: { name: "shoot" } as unknown as FileSystemDirectoryHandle,
  });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  useProjectStore.setState({ root: null });
});

describe("App", () => {
  it("shows a registered module that is active in the main window", () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    expect(screen.getByText("map-main")).toBeTruthy();
  });

  it("falls back to Library when the active module's extension is swept", () => {
    registerEssentialModules();
    useExternalPluginsSettled.setState({ settled: true });
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    act(() => unregisterExtension("ext"));
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(screen.queryByText("map-main")).toBeNull();
    expect(screen.getByText("0 photos in catalog")).toBeTruthy();
  });

  it("tells the user about a blocked extension with a project open", () => {
    useTrust.setState({ flagged: [{ id: "bad", name: "Bad Ext", reason: "malware" }] });
    render(<App />);
    expect(screen.getByText("⚠ Extension blocked")).toBeTruthy();
    useTrust.setState({ flagged: [] });
  });
});

describe("App without Library and Develop installed", () => {
  beforeEach(() => useExternalPluginsSettled.setState({ settled: true }));
  afterEach(() => useExternalPluginsSettled.setState({ settled: false }));

  it("boots into the shell with the empty state when nothing is registered", () => {
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByText("Library and Develop aren't installed.")).toBeTruthy();
    expect(screen.queryByText("0 photos in catalog")).toBeNull();
  });

  it("shows Library once its extension registers it", () => {
    registerModule("safelight.library", {
      id: "library",
      label: "Library",
      component: () => <p>library-extension</p>,
    });
    render(<App />);
    expect(screen.getByText("library-extension")).toBeTruthy();
  });
});

describe("App welcome setup", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSetupForTests();
  });

  afterEach(() => {
    unregisterExtension("ext");
    vi.unstubAllGlobals();
  });

  it("shows the setup layer over a project in the main window", async () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    useUIStore.setState({ activeModule: "map" });
    render(<App />);
    act(() => openSetup("rerun"));
    expect(
      await screen.findByRole("dialog", { name: "Pick a look" }),
    ).toBeTruthy();
  });

  it("shows a plain fill instead of the welcome grid while deciding", async () => {
    // Without the bridge the decision is synchronous; with it, it waits on the
    // installed-extension count, which this holds back.
    let release!: (installed: unknown[]) => void;
    const held = new Promise<unknown[]>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal("safelightNative", { plugins: { list: () => held } });
    useProjectStore.setState({ root: null });
    render(<App />);
    expect(screen.queryByText("Recent projects")).toBeNull();
    await act(async () => release([{ id: "acme.widget" }]));
    expect(await screen.findByText("Recent projects")).toBeTruthy();
  });

  it("never shows setup in a detached module window", async () => {
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
    window.history.replaceState({}, "", "/?detached=map");
    render(<App />);
    act(() => openSetup("rerun"));
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Pick a look" })).toBeNull();
  });
});

describe("App Report an issue", () => {
  beforeEach(() => {
    localStorage.clear();
    closeReportIssue();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    // The graphics notice offers Report an issue too; these open it from the top bar.
    useGraphics.setState({ noticeDismissed: true });
    registerModule("ext", { id: "map", label: "Map", component: () => <p>map-main</p> });
  });

  afterEach(() => {
    act(() => closeReportIssue());
    unregisterExtension("ext");
    vi.restoreAllMocks();
  });

  async function reportFromTopBar() {
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Report an issue" }));
    expect(await screen.findByRole("dialog", { name: "Report an issue" })).toBeTruthy();
  }

  it("opens from the top bar with a project open", async () => {
    render(<App />);
    await reportFromTopBar();
  });

  it("brings a popped-out module back from its placeholder", async () => {
    useUIStore.setState({ activeModule: "map", detached: new Set(["map"]) });
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: "Bring it back" }));
    expect(useUIStore.getState().detached.has("map")).toBe(false);
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("opens while the active module is popped out", async () => {
    useUIStore.setState({ activeModule: "map", detached: new Set(["map"]) });
    render(<App />);
    expect(screen.getByText("Map is open in a separate window.")).toBeTruthy();
    await reportFromTopBar();
  });

  it("opens from a detached module window", async () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<App />);
    await reportFromTopBar();
  });
});

// The popped-out Developer Tools window holds whichever panel is registered as
// core.devtools, with nothing of core's around it: the extension draws its own
// title bar there.
describe("App in the Developer Tools window", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/?devtools=1");
    useRegistry.setState({ panels: {} });
  });
  afterEach(() => {
    unregisterExtension("safelight.devtools");
    useExternalPluginsSettled.setState({ settled: false });
  });

  it("renders the registered panel on its own", () => {
    registerPanel("safelight.devtools", {
      id: "core.devtools",
      title: "Developer Tools",
      component: () => <p>devtools-window</p>,
    });
    const { container } = render(<App />);
    expect(screen.getByText("devtools-window")).toBeTruthy();
    expect(container.textContent).toBe("devtools-window");
  });

  it("says so when no extension registers the panel", () => {
    useExternalPluginsSettled.setState({ settled: true });
    render(<App />);
    expect(screen.getByText("Developer Tools isn't installed.")).toBeTruthy();
  });

  it("stays blank while the installed extensions are loading", () => {
    const { container } = render(<App />);
    expect(container.textContent).toBe("");
  });
});
