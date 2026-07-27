// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

// The accessibility overlays as a *layer over the active theme*: what the DOM
// looks like with the extension off, what each toggle adds, how theme vars /
// high contrast / per-theme custom colours compose, and that disabling the
// extension leaves no trace. The OS media queries are faked so their side of
// the OR can be driven deterministically.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  activateAccessibility,
  applyAccessibility,
  deactivateAccessibility,
  isKeyboardCanvasEditingActive,
  OVERRIDABLE_KEYS,
  useKeyboardCanvasEditing,
} from "./accessibility";
import { resetSettings, updateSettings } from "./settings-store";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import { registerTheme, useRegistry } from "@/extensions/registry";

// React only allows act() when the environment opts in; the auto-setup that
// normally does this is tied to test globals, which this project doesn't enable.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REDUCE_MOTION = "(prefers-reduced-motion: reduce)";
const MORE_CONTRAST = "(prefers-contrast: more)";

interface FakeQuery {
  matches: boolean;
  listeners: Set<() => void>;
}

const media = new Map<string, FakeQuery>();

// jsdom ships no matchMedia. Only the four members the module touches are real;
// the rest of MediaQueryList is never reached, hence the narrow cast.
function fakeMatchMedia(query: string): MediaQueryList {
  let entry = media.get(query);
  if (!entry) {
    entry = { matches: false, listeners: new Set() };
    media.set(query, entry);
  }
  const q = entry;
  return {
    media: query,
    get matches() {
      return q.matches;
    },
    addEventListener: (_type: string, fn: () => void) => void q.listeners.add(fn),
    removeEventListener: (_type: string, fn: () => void) => void q.listeners.delete(fn),
  } as unknown as MediaQueryList;
}

function setOSPreference(query: string, matches: boolean): void {
  const entry = media.get(query);
  if (!entry) throw new Error(`nothing is watching ${query}`);
  entry.matches = matches;
  for (const fn of entry.listeners) fn();
}

const LIGHT_THEME = {
  id: "test.light",
  name: "Test Light",
  colorScheme: "light" as const,
  vars: {
    "--color-surface-0": "#fafafa",
    "--color-text-primary": "#101010",
    "--color-accent": "#3b82f6",
  },
};

const NEUTRAL_THEME = {
  id: "test.neutral",
  name: "Test Neutral",
  vars: {
    "--color-surface-0": "#777777",
    "--color-text-primary": "#f0f0f0",
    "--color-accent": "#8ab4f8",
  },
};

const root = () => document.documentElement;
const cssVar = (key: string) => root().style.getPropertyValue(key);
const classes = () => [...root().classList];

beforeEach(() => {
  window.matchMedia = fakeMatchMedia;
  media.clear();
  localStorage.clear();
  useRegistry.setState({ themes: {} });
  registerTheme("core", LIGHT_THEME);
  registerTheme("core", NEUTRAL_THEME);
  applyTheme(NEUTRAL_THEME.id);
  resetSettings();
});

afterEach(() => {
  deactivateAccessibility();
  root().removeAttribute("class");
  root().removeAttribute("style");
  useThemeStore.setState({ activeId: "core.neutral" });
});

describe("colour layers", () => {
  it("leaves the theme's own colours in place with no overlay on", () => {
    activateAccessibility();
    expect(cssVar("--color-surface-0")).toBe("#777777");
    expect(cssVar("--color-text-primary")).toBe("#f0f0f0");
    expect(classes()).toEqual([]);
  });

  it("replaces the theme's colours with the dark high-contrast palette", () => {
    activateAccessibility();
    updateSettings({ highContrast: true });
    expect(cssVar("--color-surface-0")).toBe("#000000");
    expect(cssVar("--color-text-primary")).toBe("#ffffff");
  });

  it("follows a light theme's polarity", () => {
    applyTheme(LIGHT_THEME.id);
    activateAccessibility();
    updateSettings({ highContrast: true });
    expect(cssVar("--color-surface-0")).toBe("#ffffff");
    expect(cssVar("--color-text-primary")).toBe("#000000");
  });

  it("restores the theme's colours when high contrast is turned back off", () => {
    activateAccessibility();
    updateSettings({ highContrast: true });
    updateSettings({ highContrast: false });
    expect(cssVar("--color-surface-0")).toBe("#777777");
    expect(cssVar("--color-accent")).toBe("#8ab4f8");
  });

  it("lets a custom override win over both the theme and high contrast", () => {
    activateAccessibility();
    updateSettings({
      highContrast: true,
      colorOverrides: { [NEUTRAL_THEME.id]: { "--color-accent": "#ff00ff" } },
    });
    expect(cssVar("--color-accent")).toBe("#ff00ff");
    // Every other key still comes from the layer beneath.
    expect(cssVar("--color-surface-0")).toBe("#000000");
  });

  it("falls back to the layer beneath when an override is removed", () => {
    activateAccessibility();
    updateSettings({
      colorOverrides: { [NEUTRAL_THEME.id]: { "--color-accent": "#ff00ff" } },
    });
    updateSettings({ colorOverrides: {} });
    expect(cssVar("--color-accent")).toBe("#8ab4f8");
  });

  it("keeps custom overrides per theme", () => {
    activateAccessibility();
    updateSettings({
      colorOverrides: {
        [NEUTRAL_THEME.id]: { "--color-accent": "#ff00ff" },
        [LIGHT_THEME.id]: { "--color-accent": "#00ff00" },
      },
    });
    expect(cssVar("--color-accent")).toBe("#ff00ff");
    applyTheme(LIGHT_THEME.id);
    expect(cssVar("--color-accent")).toBe("#00ff00");
  });

  it("re-layers high contrast after a theme switch clobbers the vars", () => {
    activateAccessibility();
    updateSettings({ highContrast: true });
    applyTheme(LIGHT_THEME.id);
    // applyTheme writes its own vars last; the theme subscription must put the
    // overlay back on top — and at the new theme's polarity.
    expect(cssVar("--color-surface-0")).toBe("#ffffff");
    expect(cssVar("--color-text-primary")).toBe("#000000");
  });

  it("clears every overridable key when no theme is registered", () => {
    useRegistry.setState({ themes: {} });
    activateAccessibility();
    for (const key of OVERRIDABLE_KEYS) expect(cssVar(key)).toBe("");
  });
});

describe("class and attribute toggles", () => {
  beforeEach(() => activateAccessibility());

  it("maps each preference to its own class", () => {
    updateSettings({
      reduceMotion: true,
      reduceTransparency: true,
      strongFocus: true,
      largerText: true,
      largerControls: true,
      lowercaseHeadings: true,
    });
    expect(classes().sort()).toEqual([
      "sl-focus-ring",
      "sl-large-targets",
      "sl-larger-text",
      "sl-opaque",
      "sl-reduce-motion",
      "sl-title-headings",
    ]);

    updateSettings({ largerText: false, strongFocus: false });
    expect(classes()).not.toContain("sl-larger-text");
    expect(classes()).not.toContain("sl-focus-ring");
    expect(classes()).toContain("sl-opaque");
  });

  it("marks the colour-vision simulation on :root and removes it again", () => {
    updateSettings({ colorVisionFilter: "deuteranopia" });
    expect(root().getAttribute("data-sl-cvd")).toBe("deuteranopia");
    updateSettings({ colorVisionFilter: "none" });
    expect(root().hasAttribute("data-sl-cvd")).toBe(false);
  });

  it("injects the simulation filters once", () => {
    const defs = document.getElementById("sl-cvd-defs");
    expect(defs).not.toBeNull();
    expect(defs?.querySelectorAll("filter")).toHaveLength(3);
    expect(document.getElementById("sl-cvd-protanopia")).not.toBeNull();

    activateAccessibility();
    applyAccessibility();
    expect(document.querySelectorAll("#sl-cvd-defs")).toHaveLength(1);
  });
});

describe("OS preferences", () => {
  it("ORs an OS signal into the manual toggle while syncing is on", () => {
    activateAccessibility();
    setOSPreference(MORE_CONTRAST, true);
    expect(cssVar("--color-surface-0")).toBe("#000000");

    setOSPreference(MORE_CONTRAST, false);
    expect(cssVar("--color-surface-0")).toBe("#777777");
  });

  it("ignores the OS once the user turns syncing off", () => {
    activateAccessibility();
    updateSettings({ syncOSAccessibility: false });
    setOSPreference(MORE_CONTRAST, true);
    expect(cssVar("--color-surface-0")).toBe("#777777");

    // The manual toggle still works on its own.
    updateSettings({ highContrast: true });
    expect(cssVar("--color-surface-0")).toBe("#000000");
  });

  it("keeps the manual toggle on even when the OS signal drops", () => {
    activateAccessibility();
    updateSettings({ reduceMotion: true });
    setOSPreference(REDUCE_MOTION, true);
    setOSPreference(REDUCE_MOTION, false);
    expect(classes()).toContain("sl-reduce-motion");
  });

  it("stops listening once the extension is disabled", () => {
    activateAccessibility();
    deactivateAccessibility();
    setOSPreference(MORE_CONTRAST, true);
    expect(cssVar("--color-surface-0")).toBe("#777777");
  });
});

describe("extension lifecycle", () => {
  it("activating twice does not double up", () => {
    activateAccessibility();
    activateAccessibility();
    expect(document.querySelectorAll("#sl-cvd-defs")).toHaveLength(1);
    for (const entry of media.values()) expect(entry.listeners.size).toBe(1);
  });

  it("removes every trace when disabled", () => {
    activateAccessibility();
    updateSettings({
      highContrast: true,
      reduceMotion: true,
      strongFocus: true,
      largerText: true,
      largerControls: true,
      lowercaseHeadings: true,
      reduceTransparency: true,
      colorVisionFilter: "tritanopia",
    });

    deactivateAccessibility();
    expect(classes()).toEqual([]);
    expect(root().hasAttribute("data-sl-cvd")).toBe(false);
    expect(document.getElementById("sl-cvd-defs")).toBeNull();
    // The theme's own colours are restored, not the index.css fallback.
    expect(cssVar("--color-surface-0")).toBe("#777777");
  });

  it("stops reacting to settings once disabled", () => {
    activateAccessibility();
    deactivateAccessibility();
    updateSettings({ highContrast: true, strongFocus: true });
    expect(cssVar("--color-surface-0")).toBe("#777777");
    expect(classes()).not.toContain("sl-focus-ring");
  });

  it("disabling without activating changes nothing", () => {
    updateSettings({ strongFocus: true });
    const before = root().getAttribute("style");
    deactivateAccessibility();
    expect(root().getAttribute("style")).toBe(before);
  });
});

describe("keyboard canvas editing gate", () => {
  it("needs both the extension and the opt-in setting", () => {
    const { result, unmount } = renderHook(() => useKeyboardCanvasEditing());
    expect(result.current).toBe(false);

    act(() => updateSettings({ keyboardCanvasEditing: true }));
    expect(result.current).toBe(false); // extension still off

    act(() => activateAccessibility());
    expect(result.current).toBe(true);

    act(() => updateSettings({ keyboardCanvasEditing: false }));
    expect(result.current).toBe(false);

    act(() => updateSettings({ keyboardCanvasEditing: true }));
    act(() => deactivateAccessibility());
    expect(result.current).toBe(false);
    unmount();
  });

  it("reads the same gate imperatively", () => {
    updateSettings({ keyboardCanvasEditing: true });
    expect(isKeyboardCanvasEditingActive()).toBe(false);
    activateAccessibility();
    expect(isKeyboardCanvasEditingActive()).toBe(true);
    updateSettings({ keyboardCanvasEditing: false });
    expect(isKeyboardCanvasEditingActive()).toBe(false);
  });
});
