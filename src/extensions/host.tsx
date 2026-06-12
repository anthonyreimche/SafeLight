// Extension host: builds the SafelightAPI handed to every extension (built-in
// and external) and boots the whole system. Called once from main.tsx before
// the first render.

import * as React from "react";
import { create } from "zustand";
import type { SafelightAPI } from "./types";
import {
  registerLayout,
  registerPanel,
  registerSettings,
  registerSliderIcon,
  registerTheme,
} from "./registry";
import {
  getExtSetting,
  initExtSettings,
  onExtSettingChange,
  setExtSetting,
} from "./ext-settings";
import { initKeybindings } from "@/state/keybindings-store";
import { applyDockLayout, initDockLayouts, toggleDockPanel } from "./dock";
import { applyTheme, initThemes } from "./themes";
import { initEnablement, loadBuiltins, loadExternalPlugins } from "./loader";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { Histogram } from "@/ui/components/Histogram";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { initSettings, useSettings } from "@/state/settings-store";

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
    registerSettings: (c) => registerSettings(extensionId, c),
    settings: {
      get: (key, fallback) => getExtSetting(extensionId, key, fallback),
      set: (key, value) => setExtSetting(extensionId, key, value),
      onChange: (cb) => onExtSettingChange(extensionId, cb),
    },
    components: { Panel, Slider, Histogram },
    stores: {
      useDevelopStore,
      useCatalogStore,
      useUIStore,
      useSettings,
      /** For plugins that need their own state. */
      create,
    },
    dock: { togglePanel: toggleDockPanel },
    themes: { apply: applyTheme },
    layouts: { apply: applyDockLayout },
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
  initDockLayouts();
  void loadExternalPlugins();
}
