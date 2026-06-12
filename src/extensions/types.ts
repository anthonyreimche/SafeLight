// Public extension API types. Everything a plugin can see lives here.
// Plugins are prebuilt ESM bundles whose default/named `activate(api)` export
// receives a SafelightAPI scoped to their extension id.

import type { ComponentType } from "react";

/** Stack a panel renders in by default ("none" = only via the View menu).
 *  Stacks are composite panels (e.g. "Edit") that host many small panels. */
export type PanelSlot = "develop-right" | "develop-left" | "none";

/** Default placement in a module's dock layout (used when the user has no
 *  saved layout for that module yet). */
export interface PanelDockDefault {
  module: "library" | "develop";
  direction: "left" | "right";
  /** Stacking order within the direction (lower = closer to main). */
  order?: number;
  width?: number;
  /** Initial group height when stacked below another panel in the column. */
  height?: number;
}

export interface PanelContribution {
  /** Globally unique, e.g. "core.histogram" or "my-ext.fancy-curves". */
  id: string;
  title: string;
  /** Rendered both in its stack slot and inside a dock panel. */
  component: ComponentType;
  slot?: PanelSlot;
  /** Sort position within the slot (lower = higher up). Default 100. */
  order?: number;
  defaultDock?: PanelDockDefault;
}

/** One dock column in a layout preset. Panels listed top→bottom. */
export interface LayoutRail {
  side: "left" | "right";
  width?: number;
  /** Panel ids, e.g. "core.histogram". Unknown ids render a placeholder. */
  panels: string[];
}

export interface ModuleLayoutDef {
  rails: LayoutRail[];
  /** Panels that start as floating windows. */
  floating?: Record<string, { x: number; y: number; width: number }>;
}

/** A named dock arrangement selectable from the Layout menu. Modules omitted
 *  from `modules` fall back to the registry's defaultDock placements, so a
 *  layout with no `modules` at all means "the built-in defaults". */
export interface LayoutContribution {
  id: string;
  name: string;
  /** Shown as a tooltip in the Layout menu. */
  description?: string;
  modules?: Partial<Record<"library" | "develop", ModuleLayoutDef>>;
}

export interface ThemeContribution {
  id: string;
  name: string;
  colorScheme?: "light" | "dark";
  /** CSS custom properties applied to :root, e.g. { "--color-surface-0": "#fff" }. */
  vars: Record<string, string>;
}

export interface SliderIconContribution {
  /** Referenced by Slider's `icon` prop, e.g. "core.exposure". */
  id: string;
  /** Inline SVG markup, rendered at 12×12 beside the slider label. */
  svg: string;
}

/** One field in an extension's settings dialog. */
export type SettingsField =
  | {
      key: string;
      label: string;
      hint?: string;
      type: "boolean";
      default: boolean;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "string";
      default: string;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "select";
      default: string;
      options: { value: string; label: string }[];
    };

/** Declarative settings dialog, opened from the Extensions panel. Values are
 *  persisted per-extension and read back with api.settings.get(). */
export interface SettingsContribution {
  /** Dialog title; defaults to the extension's name. */
  title?: string;
  fields: SettingsField[];
}

/** A repo found by the official-extension search (GitHub topic). */
export interface ExtensionSearchResult {
  /** "owner/repo" — also the install spec. */
  fullName: string;
  description: string | null;
  stars: number;
  updatedAt: string;
}

/** safelight.json at the root of an extension repo. */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry ESM bundle, relative to the extension folder, e.g. "dist/index.js". */
  main: string;
}

export interface SafelightAPI {
  version: 1;
  extensionId: string;
  /** The app's React instance — plugins must use this, not their own copy. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react: any;
  registerPanel(c: PanelContribution): void;
  registerTheme(c: ThemeContribution): void;
  registerLayout(c: LayoutContribution): void;
  registerSliderIcon(c: SliderIconContribution): void;
  /** Declare a settings dialog (⚙ in the Extensions panel). */
  registerSettings(c: SettingsContribution): void;
  /** Persisted per-extension key/value settings. */
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    /** Fires when any of this extension's settings change (any window). */
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  /** Reusable UI building blocks (Panel chrome, Slider, Histogram). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, ComponentType<any>>;
  /** Zustand hooks: useDevelopStore, useCatalogStore, useUIStore. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: Record<string, any>;
  dock: { togglePanel(id: string): void };
  themes: { apply(id: string): void };
  layouts: { apply(id: string): void };
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}

declare global {
  interface Window {
    /** Extension API (also handy in the devtools console). */
    safelight?: SafelightAPI;
    /** Electron bridge; absent in the plain-browser dev build. */
    safelightNative?: {
      platform: string;
      versions: { electron: string; chrome: string };
      plugins: {
        list(): Promise<ExtensionManifest[]>;
        /** Accepts "owner/repo", "owner/repo#ref", or a github.com URL. */
        install(spec: string): Promise<ExtensionManifest>;
        uninstall(id: string): Promise<void>;
        /** Search GitHub for official extensions (repos with `topic`). */
        search(query: string, topic: string): Promise<ExtensionSearchResult[]>;
      };
    };
  }
}
