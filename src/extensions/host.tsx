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
  registerLayout,
  registerLensProfile,
  registerPanel,
  registerPipeline,
  registerPresetImporter,
  registerProcessingStage,
  registerSettings,
  registerSliderIcon,
  registerTheme,
} from "./registry";
import { applyPipeline, initPipelines, usePipelineStore } from "./pipelines";
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
import {
  checkAllExtensionUpdates,
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
    registerKeybinding: (c) => registerExtensionAction(extensionId, c),
    registerSettings: (c) => registerSettings(extensionId, c),
    registerExportProcessor: (c) => registerExportProcessor(extensionId, c),
    registerFilenameTemplate: (c) => registerFilenameTemplate(extensionId, c),
    registerLensProfile: (c) => registerLensProfile(extensionId, c),
    registerCatalogHooks: (c) => registerCatalogHooks(extensionId, c),
    registerPresetImporter: (c) => registerPresetImporter(extensionId, c),
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
  initPipelines();
  initDockLayouts();
  // Load external plugins, then quietly check them for updates (and auto-update
  // if the user opted in). The check is gated on a setting and rate-limited.
  void loadExternalPlugins().then(() => void checkAllExtensionUpdates());
  void warmDecodePool();
}
