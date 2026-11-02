// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The API members the Essentials panels reach core through once they leave it
// (Edit History, Histogram, Presets, Folders, Library Filters, Keywords, Info,
// Export, Accessibility, Developer Tools). Each is core's own implementation,
// so the panels behave as they did built in. Developer Tools' member reaches
// the dev-folder loader, which holds the privileged filesystem, so only that
// extension gets it. In the dom project because host.tsx's import graph
// reaches stores that expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createPortal } from "react-dom";
import { makeScopedAPI } from "./host";
import type { SafelightAPI } from "./types";
import { registerPresetImporter, registerTheme, unregisterExtension } from "./registry";
import { useExtStoreUI } from "./store-ui";
import { useDockStore } from "./dock";
import { uiKit } from "./ui-kit";
import { DEFAULT_DEVELOP_PARAMS, freshParams, normalizeParams, type CatalogPhoto } from "@/catalog/types";
import type { HistogramData } from "@/rendering/histogram";
import * as thumbnailRenderer from "@/rendering/thumbnail-renderer";
import { useProjectStore } from "@/project/project-store";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { useCatalogStore } from "@/state/catalog-store";
import * as folderOps from "@/project/folder-ops";
import * as nativeFs from "@/project/native-fs";
import { ContextMenu } from "@/ui/components/ContextMenu";
import { ScaleStepper } from "@/ui/components/ScaleStepper";
import { ResolutionControl } from "@/modules/export/ResolutionControl";
import { confirmDialog } from "@/ui/components/ConfirmDialog";
import { Field, OptionRow, ToggleField, useFieldVisible } from "@/ui/components/PreferencesDialog";
import { useSettings } from "@/state/settings-store";
import { broadcast } from "@/state/broadcast";
import { settleSelectedPhoto } from "@/modules/library/import-photos";
import { exportPhotos, proPhotoAt8Bit } from "@/modules/export/export-image";
import {
  exportPreset,
  importPresetFile,
  pickPresetFile,
  presetPickerAccept,
} from "@/modules/develop/preset-io";
import { presetFields, summarizePreset } from "@/modules/develop/preset-summary";
import { ACCESSIBILITY_ACTIVE_KEY, useKeyboardCanvasEditing } from "@/state/accessibility";
import { useTitleBarOverlay } from "@/ui/window-chrome";
import { DevFolderControls } from "./devtools/DevFolderControls";
import { readAppVersion, readWebGLInfo } from "@/diagnostics/environment";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const api = () => makeScopedAPI("ext.panels");

describe("core components and stores for the panels", () => {
  it("hands over the project store", () => {
    expect(api().stores.useProjectStore).toBe(useProjectStore);
  });

  it("hands over the context menu, scale stepper and resolution control", () => {
    const { components } = api();
    expect(components.ContextMenu).toBe(ContextMenu);
    expect(components.ScaleStepper).toBe(ScaleStepper);
    expect(components.ResolutionControl).toBe(ResolutionControl);
  });

  it("adds the confirm dialog to the UI kit", () => {
    const { ui } = api();
    expect(ui.confirmDialog).toBe(confirmDialog);
    expect(ui.Button).toBe(uiKit.Button);
  });

  it("names the colour-label and white tokens", () => {
    expect(api().ui.tokens).toMatchObject({
      labelRed: "var(--color-label-red)",
      labelYellow: "var(--color-label-yellow)",
      labelGreen: "var(--color-label-green)",
      labelBlue: "var(--color-label-blue)",
      labelPurple: "var(--color-label-purple)",
      white: "var(--color-white)",
    });
  });

  it("hands over the Preferences field primitives", () => {
    expect(api().preferences.fields).toEqual({ Field, ToggleField, OptionRow, useFieldVisible });
  });

  it("hands over React DOM's portal", () => {
    expect(api().reactDom.createPortal).toBe(createPortal);
  });

  it("hands over the title bar overlay", () => {
    expect(api().titleBar.useOverlay).toBe(useTitleBarOverlay);
  });
});

describe("api.registry.use", () => {
  afterEach(() => unregisterExtension("ext.theme"));

  it("reads the registry and follows it", () => {
    const { result } = renderHook(() => api().registry.use((s) => s.themes["ext.theme.one"]?.name));
    expect(result.current).toBeUndefined();
    act(() => registerTheme("ext.theme", { id: "ext.theme.one", name: "One", vars: {} }));
    expect(result.current).toBe("One");
  });

  it("gives no way to write the registry", () => {
    expect(Object.keys(api().registry.use)).toEqual([]);
  });
});

describe("api.appSettings.update", () => {
  it("changes the setting and saves it", () => {
    api().appSettings.update({ exportQuality: 77 });
    expect(useSettings.getState().exportQuality).toBe(77);
    expect(JSON.parse(localStorage.getItem("sl_settings_v1") ?? "{}").exportQuality).toBe(77);
  });
});

describe("api.develop.normalizeParams", () => {
  it("is core's", () => {
    expect(api().develop.normalizeParams).toBe(normalizeParams);
  });
});

describe("api.presets", () => {
  afterEach(() => unregisterExtension("ext.importer"));

  it("hands over the preset file helpers and the summary", () => {
    const { presets } = api();
    expect(presets.exportFile).toBe(exportPreset);
    expect(presets.importFile).toBe(importPresetFile);
    expect(presets.pickFile).toBe(pickPresetFile);
    expect(presets.pickerAccept).toBe(presetPickerAccept);
    expect(presets.summarize).toBe(summarizePreset);
  });

  it("lists the registered preset importers", () => {
    const { result } = renderHook(() => api().presets.useImporters());
    expect(result.current).toEqual([]);
    act(() =>
      registerPresetImporter("ext.importer", {
        id: "ext.importer.cube",
        label: "Cube",
        extensions: [".cube"],
        parse: async () => null,
      }),
    );
    expect(result.current.map((i) => i.id)).toEqual(["ext.importer.cube"]);
  });

  it("lists the savable fields as the save dialog does", () => {
    const params = { ...DEFAULT_DEVELOP_PARAMS, exposure: 1 };
    const fields = api().presets.fields(params, {});
    expect(fields).toEqual(presetFields(params, [], { bagKeys: [], bagDefaults: {}, changed: false }));
    expect(fields.find((f) => f.id === "exposure")?.changed).toBe(true);
  });

  it("describes an empty bag as nothing", () => {
    expect(api().presets.describeBag({})).toEqual([]);
  });
});

describe("api.extensions.openStore", () => {
  it("opens the store on a category", () => {
    useExtStoreUI.getState().goHome();
    api().extensions.openStore("preset");
    expect(useExtStoreUI.getState().browse).toBe("preset");
  });
});

describe("api.project", () => {
  it("hands over the folder operations and the native folder helpers", () => {
    const { project } = api();
    expect(project.createFolder).toBe(folderOps.createFolder);
    expect(project.renameFolder).toBe(folderOps.renameFolder);
    expect(project.moveFolder).toBe(folderOps.moveFolder);
    expect(project.movePhotos).toBe(folderOps.movePhotos);
    expect(project.deleteFolder).toBe(folderOps.deleteFolder);
    expect(project.pickDirectory).toBe(nativeFs.pickDirectoryHandle);
    expect(project.pathOf).toBe(nativeFs.nativePathOf);
    expect(project.reveal).toBe(nativeFs.revealNativePath);
  });

  it("gives no handle for an arbitrary path", () => {
    expect(Object.keys(api().project)).not.toContain("directoryHandle");
  });
});

describe("api.catalog, api.events and api.export additions", () => {
  it("hands over the selected photo's metadata read and the broadcast listener", () => {
    const a = api();
    expect(a.catalog.settleSelectedPhoto).toBe(settleSelectedPhoto);
    const heard = vi.fn();
    const off = a.events.onBroadcast(heard);
    broadcast({ type: "selection-change", payload: { activePhotoId: "p1" } });
    off();
    broadcast({ type: "selection-change", payload: { activePhotoId: "p2" } });
    expect(heard).toHaveBeenCalledOnce();
  });

  it("names the window event that focuses the keyword field", () => {
    expect(api().events.FOCUS_KEYWORD_INPUT).toBe("sl-focus-keyword-input");
  });

  it("hands over the export run and the ProPhoto warning", () => {
    const a = api();
    expect(a.export.exportPhotos).toBe(exportPhotos);
    expect(a.export.proPhotoAt8Bit).toBe(proPhotoAt8Bit);
  });

  it("renders the histogram of the photo's saved edit, fresh defaults for an unedited one", async () => {
    const data: HistogramData = { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) };
    const render = vi.spyOn(thumbnailRenderer, "renderPhotoHistogram").mockResolvedValue(data);
    const photo = { id: "p1", filename: "a.jpg", exif: { colorTemperature: 5000 } } as CatalogPhoto;
    await expect(api().catalog.renderHistogram(photo)).resolves.toBe(data);
    expect(render).toHaveBeenCalledWith(photo, freshParams(5000), {});
  });
});

describe("api.catalog.readPreview", () => {
  afterEach(() => setCatalogStorage(null));

  const storageReading = (readPreview: CatalogStorage["readPreview"]): CatalogStorage => ({
    putPhoto: async () => {},
    putPhotos: async () => {},
    deletePhoto: async () => {},
    getEditState: async () => undefined,
    putEditState: async () => {},
    putEditStates: async () => {},
    readPreview,
  });

  it("reads the grid preview from the project without holding it, and leaves the catalog as it is", async () => {
    const blob = new Blob(["preview"]);
    const readPreview = vi.fn(async () => blob);
    setCatalogStorage(storageReading(readPreview));
    const photos = useCatalogStore.getState().photos;

    await expect(api().catalog.readPreview("p1")).resolves.toBe(blob);

    expect(readPreview).toHaveBeenCalledWith("p1", { hold: false });
    expect(useCatalogStore.getState().photos).toBe(photos);
  });

  it("gives null for a photo with no preview, or when no project is open", async () => {
    setCatalogStorage(storageReading(async () => null));
    await expect(api().catalog.readPreview("p1")).resolves.toBeNull();

    setCatalogStorage(null);
    await expect(api().catalog.readPreview("p1")).resolves.toBeNull();
  });
});

describe("api.dock.isPanelOpen", () => {
  const before = useDockStore.getState();
  afterEach(() => useDockStore.setState(before, true));

  it("says whether a panel is open", () => {
    useDockStore.setState({ open: ["ext.panels.one"] });
    expect(api().dock.isPanelOpen("ext.panels.one")).toBe(true);
    expect(api().dock.isPanelOpen("ext.panels.two")).toBe(false);
  });
});

describe("api.accessibility", () => {
  afterEach(() => api().accessibility.deactivate());

  it("turns the overlays on and off", () => {
    useSettings.setState({ strongFocus: true, keyboardCanvasEditing: true });
    const { result } = renderHook(() => useKeyboardCanvasEditing());
    act(() => api().accessibility.activate());
    expect(document.documentElement.classList.contains("sl-focus-ring")).toBe(true);
    expect(result.current).toBe(true);
    act(() => api().accessibility.deactivate());
    expect(document.documentElement.classList.contains("sl-focus-ring")).toBe(false);
    expect(result.current).toBe(false);
  });

  it("records for the next launch whether the overlays were on", () => {
    api().accessibility.activate();
    api().accessibility.activate();
    expect(localStorage.getItem(ACCESSIBILITY_ACTIVE_KEY)).toBe("true");
    api().accessibility.deactivate();
    expect(localStorage.getItem(ACCESSIBILITY_ACTIVE_KEY)).toBe("false");
    expect(document.documentElement.classList.contains("sl-focus-ring")).toBe(false);
  });
});

function devtoolsAPI(): NonNullable<SafelightAPI["devtools"]> {
  const devtools = makeScopedAPI("safelight.devtools").devtools;
  if (!devtools) throw new Error("Developer Tools got no devtools member");
  return devtools;
}

describe("api.devtools", () => {
  it("is given to Developer Tools", () => {
    const devtools = devtoolsAPI();
    expect(devtools.devFolder.Controls).toBe(DevFolderControls);
    expect(devtools.webglInfo).toBe(readWebGLInfo);
    expect(devtools.appVersion).toBe(readAppVersion);
  });

  it.each(["ext.panels", "host", "core.devtools", "safelight.devtools.extra", "safelight.info"])(
    "is withheld from %s",
    (id) => {
      expect(makeScopedAPI(id).devtools).toBeUndefined();
    },
  );

  it("hands over the window's Chrome DevTools controls", () => {
    const controls = {
      open: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
      toggle: vi.fn(async () => {}),
      isOpen: vi.fn(async () => false),
      reload: vi.fn(async () => {}),
    };
    vi.stubGlobal("safelightNative", { devtools: controls });
    expect(devtoolsAPI().electron).toBe(controls);
  });

  it("hands over the platform, runtime versions, GPU status and process metrics", async () => {
    const gpu = { webgl2: "enabled", rasterization: "disabled_software" };
    const metrics = [{ type: "Browser", pid: 4, cpuPercent: 1.5, memoryMB: 120 }];
    vi.stubGlobal("safelightNative", {
      platform: "win32",
      versions: { electron: "38.0.0", chrome: "140.0.0" },
      diagnostics: { gpuInfo: async () => gpu, metrics: async () => metrics },
    });
    const native = devtoolsAPI().native;
    expect(native?.platform).toBe("win32");
    expect(native?.versions).toEqual({ electron: "38.0.0", chrome: "140.0.0" });
    await expect(native?.gpuInfo?.()).resolves.toEqual(gpu);
    await expect(native?.metrics?.()).resolves.toEqual(metrics);
  });

  it("has no native details outside the desktop app", () => {
    vi.stubGlobal("safelightNative", undefined);
    expect(devtoolsAPI().native).toBeUndefined();
  });

  it("leaves out the diagnostics an older desktop build lacks", () => {
    vi.stubGlobal("safelightNative", { platform: "linux", versions: { electron: "30.0.0", chrome: "124.0.0" } });
    const native = devtoolsAPI().native;
    expect(native?.platform).toBe("linux");
    expect(native?.gpuInfo).toBeUndefined();
    expect(native?.metrics).toBeUndefined();
  });

  it("inspects every extension's shared variables", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    makeScopedAPI("ext.vars").variables.register("ext.vars.count", { initial: 3 });
    const { variables } = devtoolsAPI();
    const entry = variables.inspect().find((v) => v.snapshot.name === "ext.vars.count");
    expect(entry?.snapshot.value).toBe(3);
    expect(variables.changeCount()).toBeGreaterThan(0);
    expect(variables.windowName(entry?.snapshot.writer.window ?? "")).toBe("this window");
  });

  it("describes the open photo's program", () => {
    const { pipeline } = devtoolsAPI();
    expect(pipeline.versions).toEqual([1, 2, 3]);
    const { result } = renderHook(() => {
      const open = pipeline.useOpenVersion();
      return { open, rows: pipeline.useRows(open.version), screen: pipeline.useScreen() };
    });
    expect(result.current.open).toEqual({ photoId: null, version: 2 });
    expect(result.current.rows.some((r) => r.kind === "output")).toBe(true);
    expect(result.current.screen).toEqual({ space: "srgb", profile: null });
  });
});
