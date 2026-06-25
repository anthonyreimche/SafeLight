// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension host: builds the SafelightAPI handed to every extension (built-in
// and external) and boots the whole system. Called once from main.tsx before
// the first render.

import * as React from "react";
import { create } from "zustand";
import type { SafelightAPI } from "./types";
import {
  registerCatalogHooks,
  registerExportProcessor,
  registerFilenameTemplate,
  registerGridFilter,
  registerLayout,
  registerLibrarySort,
  registerLensProfile,
  registerPanel,
  registerPipeline,
  registerPresetImporter,
  registerProcessingStage,
  unregisterProcessingStage,
  registerSettings,
  registerSlot,
  registerSliderIcon,
  registerTheme,
} from "./registry";
import { applyPipeline, initPipelines, usePipelineStore } from "./pipelines";
import { setStageTexture } from "@/rendering/render-bridge";
import {
  getExtSetting,
  initExtSettings,
  onExtSettingChange,
  setExtSetting,
} from "./ext-settings";
import {
  getBinding,
  initKeybindings,
  registerExtensionAction,
  useKeybindings,
} from "@/state/keybindings-store";
import { applyDockLayout, initDockLayouts, toggleDockPanel, useLayoutStore } from "./dock";
import { applyTheme, initThemes, useThemeStore } from "./themes";
import { captureDevelopFrame, useDevelopOverlay } from "./develop-host";
import { getPhotoData, putPhotoData } from "@/state/photo-blob-store";
import {
  contributionToSpec,
  registerCursor,
  setCanvasCursor,
} from "@/state/cursor-store";
import {
  checkAllExtensionUpdates,
  EXT_UPDATE_POLL_MS,
  initEnablement,
  loadBuiltins,
  loadExternalPlugins,
} from "./loader";
import { warmDecodePool } from "@/raw/decode-pool";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { Histogram } from "@/ui/components/Histogram";
import { CurveEditor } from "@/ui/components/CurveEditor";
import { Rating } from "@/ui/components/Rating";
import { Thumbnail } from "@/ui/components/Thumbnail";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { initSettings, useSettings } from "@/state/settings-store";
import { usePresetsStore } from "@/state/presets-store";
import {
  openPreferences,
  closePreferences,
  togglePreferences,
} from "@/ui/components/PreferencesDialog";

/** Every register* call made through a scoped API is tagged with the
 *  extension's id, so uninstalling can sweep all of its contributions. */
export function makeScopedAPI(extensionId: string): SafelightAPI {
  return {
    version: 1,
    extensionId,
    react: React,
    registerPanel: (c) => registerPanel(extensionId, c),
    registerTheme: (c) => registerTheme(extensionId, c),
    registerLayout: (c) => registerLayout(extensionId, c),
    registerSliderIcon: (c) => registerSliderIcon(extensionId, c),
    registerPipeline: (c) => registerPipeline(extensionId, c),
    registerProcessingStage: (c) => registerProcessingStage(extensionId, c),
    unregisterProcessingStage: (id) => unregisterProcessingStage(extensionId, id),
    setStageTexture: (stageId, key, tex) => setStageTexture(`${stageId}.${key}`, tex),
    registerKeybinding: (c) => registerExtensionAction(extensionId, c),
    registerSettings: (c) => registerSettings(extensionId, c),
    registerExportProcessor: (c) => registerExportProcessor(extensionId, c),
    registerFilenameTemplate: (c) => registerFilenameTemplate(extensionId, c),
    registerLensProfile: (c) => registerLensProfile(extensionId, c),
    registerCatalogHooks: (c) => registerCatalogHooks(extensionId, c),
    registerPresetImporter: (c) => registerPresetImporter(extensionId, c),
    registerGridFilter: (c) => registerGridFilter(extensionId, c),
    registerSlot: (c) => registerSlot(extensionId, c),
    registerCursor: (c) => registerCursor(extensionId, c),
    registerLibrarySort: (c) => registerLibrarySort(extensionId, c),
    settings: {
      get: (key, fallback) => getExtSetting(extensionId, key, fallback),
      set: (key, value) => setExtSetting(extensionId, key, value),
      onChange: (cb) => onExtSettingChange(extensionId, cb),
    },
    components: { Panel, Slider, Histogram, CurveEditor, Rating, Thumbnail },
    stores: {
      useDevelopStore,
      useCatalogStore,
      useUIStore,
      useSettings,
      usePresetsStore,
      useKeybindings,
      useThemeStore,
      useLayoutStore,
      usePipelineStore,
      /** For plugins that need their own state. */
      create,
    },
    dock: { togglePanel: toggleDockPanel },
    themes: { apply: applyTheme },
    layouts: { apply: applyDockLayout },
    pipelines: { apply: applyPipeline },
    preferences: { open: openPreferences, close: closePreferences, toggle: togglePreferences },
    navigation: { goTo: (module) => useUIStore.getState().setActiveModule(module) },
    keybindings: { getBinding },
    develop: {
      useDevelopOverlay,
      captureFrame: captureDevelopFrame,
      setCanvasCursor: (cursor, opts) =>
        setCanvasCursor(
          extensionId,
          cursor == null || typeof cursor === "string"
            ? cursor
            : contributionToSpec(cursor),
          opts,
        ),
      putPhotoData: (key, data) => putPhotoData(`${extensionId}.${key}`, data),
      getPhotoData: (key) => getPhotoData(`${extensionId}.${key}`),
    },
  };
}

let booted = false;

export function initExtensionHost(): void {
  if (booted) return;
  booted = true;
  loadBuiltins(); // pre-installed extensions, minus any the user disabled
  window.safelight = makeScopedAPI("host");
  initSettings();
  initKeybindings();
  initExtSettings();
  initEnablement();
  initThemes();
  // Accessibility overlays are owned by the `core.accessibility` built-in
  // extension (activated in loadBuiltins above when enabled); its theme
  // subscription re-layers high-contrast after initThemes applies the theme.
  initPipelines();
  initDockLayouts();
  // Load external plugins, then quietly check them for updates (and auto-update
  // if the user opted in). The check is gated on a setting and rate-limited.
  void loadExternalPlugins().then(() => void checkAllExtensionUpdates());
  // Re-discover periodically so a version bumped while the app is left open is
  // noticed without a restart (force past the per-extension TTL).
  setInterval(() => void checkAllExtensionUpdates(true), EXT_UPDATE_POLL_MS);
  void warmDecodePool();
}
