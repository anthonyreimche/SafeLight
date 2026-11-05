// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A registered module renders inside the shell; an unknown one falls back to
// Library in the main window once the installed extensions have loaded, and
// shows a placeholder in a detached window (external plugins load after first
// paint, so "unknown" may be "not yet").

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ModuleView } from "./ModuleView";
import { closeExtensions, ExtensionsDialog } from "./ExtensionsDialog";
import { useUIStore } from "@/state/ui-store";
import {
  registerModule,
  registerPanel,
  useRegistry,
} from "@/extensions/registry";
import { useExtStoreUI } from "@/extensions/store-ui";
import { installMissingEssentials, useEssentialsMigration } from "@/extensions/essentials-migration";
import { useExternalPluginsSettled } from "@/extensions/loader";
import { useDockStore } from "@/extensions/dock";
import { registerEssentialModules } from "@/test/essential-modules.test-support";

vi.mock("@/extensions/essentials-migration", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/extensions/essentials-migration")>()),
  installMissingEssentials: vi.fn(async () => {}),
}));

/** A component that throws while rendering. React still logs an error a
 *  boundary caught, so a test rendering one silences console.error. */
const boom = (message: string) => () => {
  throw new Error(message);
};
const silenceCaughtErrors = () => vi.spyOn(console, "error").mockImplementation(() => {});

beforeEach(() => {
  localStorage.clear();
  useRegistry.setState({ modules: {}, panels: {} });
  useEssentialsMigration.setState({ status: "idle", missing: [] });
  vi.mocked(installMissingEssentials).mockClear();
  useUIStore.setState({ activeModule: "library", detached: new Set() });
  useExternalPluginsSettled.setState({ settled: false });
  window.history.replaceState({}, "", "/");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ModuleView", () => {
  it("renders a registered module's view and status bar inside the shell", () => {
    registerModule("ext", {
      id: "map",
      label: "Map",
      component: () => <div>map-main</div>,
      statusBar: () => <span>map-status</span>,
    });
    render(<ModuleView id="map" />);
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.getByText("map-status")).toBeTruthy();
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
  });

  it("falls back to Library in the main window when the module is unknown", () => {
    registerEssentialModules();
    useExternalPluginsSettled.setState({ settled: true });
    useUIStore.setState({ activeModule: "map" });
    const { container } = render(<ModuleView id="map" />);
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(container.textContent).toBe("");
  });

  it("waits for the extension in a detached window until plugins have settled", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    expect(screen.getByText("Waiting for the map extension…")).toBeTruthy();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("reports an unavailable module once plugins have settled", () => {
    window.history.replaceState({}, "", "/?detached=map");
    useExternalPluginsSettled.setState({ settled: true });
    render(<ModuleView id="map" />);
    expect(
      screen.getByText("map isn't available in this window. Enable its extension, or re-attach."),
    ).toBeTruthy();
  });

  it("waits rather than taking a prototype key for a registered module", () => {
    window.history.replaceState({}, "", "/?detached=constructor");
    render(<ModuleView id="constructor" />);
    expect(screen.getByText("Waiting for the constructor extension…")).toBeTruthy();
  });

  it("swaps the placeholder for the module once it registers", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    act(() => {
      registerModule("ext", { id: "map", label: "Map", component: () => <div>map-main</div> });
    });
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.queryByText(/Waiting for/)).toBeNull();
  });

  it("seeds the module's default layout in a pop-out once it registers", () => {
    window.history.replaceState({}, "", "/?detached=map");
    render(<ModuleView id="map" />);
    expect(useDockStore.getState().rails).toEqual([]);
    act(() => {
      registerPanel("ext", { id: "ext.track", title: "Track", component: () => null });
      registerModule("ext", {
        id: "map",
        label: "Map",
        component: () => <div>map-main</div>,
        defaultLayout: { rails: [{ side: "right", width: 260, panels: ["ext.track"] }] },
      });
    });
    expect(useDockStore.getState().rails.map((r) => [r.side, r.width, r.panels])).toEqual([
      ["right", 260, ["ext.track"]],
    ]);
  });
});

describe("ModuleView without Library and Develop installed", () => {
  afterEach(() => {
    act(closeExtensions);
    useExtStoreUI.setState({ browse: "home", kit: null });
  });

  it("falls back to the first registered module", () => {
    useExternalPluginsSettled.setState({ settled: true });
    registerModule("ext", { id: "map", label: "Map", component: () => <div>map-main</div> });
    render(<ModuleView id="library" />);
    expect(useUIStore.getState().activeModule).toBe("map");
  });

  it("stays on Library while the installed extensions load, though Develop registers first", () => {
    registerModule("safelight.develop", { id: "develop", label: "Develop", component: () => null });
    render(<ModuleView id="library" />);
    expect(useUIStore.getState().activeModule).toBe("library");
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();

    act(() => {
      registerModule("safelight.library", {
        id: "library",
        label: "Library",
        component: () => <div>library-main</div>,
      });
      useExternalPluginsSettled.setState({ settled: true });
    });
    expect(screen.getByText("library-main")).toBeTruthy();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("moves on to Develop once the extensions have loaded without Library", () => {
    registerModule("safelight.develop", { id: "develop", label: "Develop", component: () => null });
    render(<ModuleView id="library" />);
    act(() => useExternalPluginsSettled.setState({ settled: true }));
    expect(useUIStore.getState().activeModule).toBe("develop");
  });

  it("keeps the shell and says Library and Develop aren't installed when none is registered", () => {
    useExternalPluginsSettled.setState({ settled: true });
    render(<ModuleView id="library" />);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeTruthy();
    expect(screen.getByText("Library and Develop aren't installed.")).toBeTruthy();
    expect(useUIStore.getState().activeModule).toBe("library");
  });

  it("offers to install the essentials from the official list", async () => {
    const user = userEvent.setup();
    useExternalPluginsSettled.setState({ settled: true });
    render(<ModuleView id="library" />);
    await user.click(screen.getByRole("button", { name: "Install the essentials" }));
    expect(installMissingEssentials).toHaveBeenCalledTimes(1);
  });

  it("shows the install under way and won't start a second", () => {
    useExternalPluginsSettled.setState({ settled: true });
    useEssentialsMigration.setState({ status: "installing", missing: ["safelight.library"] });
    render(<ModuleView id="library" />);
    const button = screen.getByRole("button", { name: "Installing…" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("says the download failed, and offers the same button again, when the install failed", () => {
    useExternalPluginsSettled.setState({ settled: true });
    useEssentialsMigration.setState({ status: "failed", missing: ["safelight.library"] });
    render(<ModuleView id="library" />);
    expect(screen.getByText(/couldn.t be downloaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install the essentials" })).toBeTruthy();
  });

  it("shows only the shell until the installed extensions have loaded", () => {
    render(<ModuleView id="library" />);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.queryByText("Library and Develop aren't installed.")).toBeNull();
  });

  it("opens the Extensions window on the Essentials kit", async () => {
    const user = userEvent.setup();
    useExternalPluginsSettled.setState({ settled: true });
    useExtStoreUI.setState({ browse: "color", kit: null });
    render(
      <>
        <ModuleView id="library" />
        <ExtensionsDialog />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Open Extensions" }));
    expect(screen.getByRole("dialog", { name: "Extensions" })).toBeTruthy();
    expect(useExtStoreUI.getState().browse).toBe("home");
    expect(useExtStoreUI.getState().kit).toBe("essentials");
  });

  it("swaps the empty state for Library once its extension registers it", () => {
    useExternalPluginsSettled.setState({ settled: true });
    render(<ModuleView id="library" />);
    act(() => {
      registerModule("safelight.library", {
        id: "library",
        label: "Library",
        component: () => <div>library-main</div>,
      });
    });
    expect(screen.getByText("library-main")).toBeTruthy();
    expect(screen.queryByText("Library and Develop aren't installed.")).toBeNull();
  });
});

describe("a module's status bar", () => {
  const footer = () => document.querySelector("main")?.nextElementSibling ?? null;

  it("is hidden while it renders nothing, as Develop's is with no photo open", () => {
    registerModule("ext", {
      id: "map",
      label: "Map",
      component: () => null,
      statusBar: () => null,
    });
    render(<ModuleView id="map" />);
    expect(footer()?.className).toContain("empty:hidden");
    expect(footer()?.childNodes.length).toBe(0);
  });
});

describe("a module that throws while rendering", () => {
  it("keeps the top bar and tabs, and shows the crash in the main view", () => {
    silenceCaughtErrors();
    registerModule("ext", { id: "map", label: "Map", component: boom("boom") });
    render(<ModuleView id="map" />);
    expect(screen.getByRole("navigation", { name: "Views" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Extensions" })).toBeTruthy();
    expect(screen.getByText('Module "Map" crashed: boom')).toBeTruthy();
  });

  it("keeps the main view when only its status bar throws", () => {
    silenceCaughtErrors();
    registerModule("ext", {
      id: "map",
      label: "Map",
      component: () => <div>map-main</div>,
      statusBar: boom("no count"),
    });
    render(<ModuleView id="map" />);
    expect(screen.getByText("map-main")).toBeTruthy();
    expect(screen.getByText('Module "Map" status bar crashed: no count')).toBeTruthy();
  });

  it("does not carry one module's crash over to the next", () => {
    silenceCaughtErrors();
    registerModule("ext", { id: "map", label: "Map", component: boom("boom") });
    registerModule("ext", { id: "book", label: "Book", component: () => <div>book-main</div> });
    const { rerender } = render(<ModuleView id="map" />);
    rerender(<ModuleView id="book" />);
    expect(screen.getByText("book-main")).toBeTruthy();
  });
});
