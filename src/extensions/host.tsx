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
  registerGridMenuItem,
  registerLayout,
  registerLibrarySort,
  registerPanel,
  registerPanelHeaderAccessory,
  registerPipeline,
  registerPresetImporter,
  registerProcessingStage,
  unregisterProcessingStage,
  registerSettings,
  registerSlot,
  unregisterSlot,
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
  listBindings,
  registerExtensionAction,
  useKeybindings,
} from "@/state/keybindings-store";
import { applyDockLayout, initDockLayouts, toggleDockPanel, useLayoutStore } from "./dock";
import { applyTheme, initThemes, useThemeStore } from "./themes";
import { captureDevelopFrame, renderDevelopPhotoFrame, useDevelopOverlay } from "./develop-host";
import {
  getDefaultExportSettings,
  renderPhotosToBlobs,
} from "@/modules/export/export-image";
import { getPhotoData, putPhotoData } from "@/state/photo-blob-store";
import {
  contributionToSpec,
  registerCursor,
  setCanvasCursor,
  resolveCursorCss,
  CURSOR_LABELS,
} from "@/state/cursor-store";
import { uiKit } from "./ui-kit";
import { getAllDescriptors, getParamDescriptor } from "./param-registry";
import {
  listAdjustments,
  getAdjustment,
  setAdjustment,
} from "@/state/develop-adjustments";
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
import { catalogStorage } from "@/catalog/storage";
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
    registerCatalogHooks: (c) => registerCatalogHooks(extensionId, c),
    registerPresetImporter: (c) => registerPresetImporter(extensionId, c),
    registerGridFilter: (c) => registerGridFilter(extensionId, c),
    registerSlot: (c) => registerSlot(extensionId, c),
    unregisterSlot: (id) => unregisterSlot(extensionId, id),
    registerPanelHeaderAccessory: (c) =>
      registerPanelHeaderAccessory(extensionId, c),
    registerCursor: (c) => registerCursor(extensionId, c),
    registerLibrarySort: (c) => registerLibrarySort(extensionId, c),
    registerGridMenuItem: (c) => registerGridMenuItem(extensionId, c),
    settings: {
      get: (key, fallback) => getExtSetting(extensionId, key, fallback),
      set: (key, value) => setExtSetting(extensionId, key, value),
      onChange: (cb) => onExtSettingChange(extensionId, cb),
    },
    components: { Panel, Slider, Histogram, CurveEditor, Rating, Thumbnail },
    ui: uiKit,
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
    params: {
      list: () => Array.from(getAllDescriptors().values()),
      get: (qualifiedKey) => getParamDescriptor(qualifiedKey),
    },
    dock: { togglePanel: toggleDockPanel },
    themes: { apply: applyTheme },
    layouts: { apply: applyDockLayout },
    pipelines: { apply: applyPipeline },
    preferences: { open: openPreferences, close: closePreferences, toggle: togglePreferences },
    navigation: { goTo: (module) => useUIStore.getState().setActiveModule(module) },
    keybindings: { getBinding, list: () => listBindings() },
    cursors: { labels: CURSOR_LABELS, resolve: (token) => resolveCursorCss(token) },
    develop: {
      useDevelopOverlay,
      captureFrame: captureDevelopFrame,
      renderPhotoFrame: renderDevelopPhotoFrame,
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
      adjustments: {
        list: () => listAdjustments(),
        get: getAdjustment,
        set: setAdjustment,
      },
    },
    export: {
      getDefaultSettings: () => getDefaultExportSettings(),
      // Merge the caller's overrides over the persisted defaults, so a caller
      // can pass just { format, longEdge, quality } and inherit the rest.
      renderPhotos: (photos, settings, onProgress) =>
        renderPhotosToBlobs(
          photos,
          { ...getDefaultExportSettings(), ...(settings ?? {}) },
          onProgress,
        ),
    },
    catalog: {
      addPhotos: (photos, opts) =>
        useCatalogStore.getState().addPhotos(photos, opts),
      getEditState: (photoId) =>
        catalogStorage()
          .getEditState(photoId)
          .then((e) => e ?? null),
      putEditState: (editState) => catalogStorage().putEditState(editState),
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
