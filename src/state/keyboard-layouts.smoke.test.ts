// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Smoke: the default shortcuts on the keyboards people use. Each row is what the
// browser reports for one key press on one platform and layout (e.key, e.code,
// the modifier flags and AltGraph) and the action the default bindings give it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActionCategory,
  matchAction,
  useExtensionActions,
  useKeybindings,
} from "./keybindings-store";

interface Press {
  platform: "win32" | "darwin" | "linux";
  layout: string;
  key: string;
  code: string;
  mods?: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean };
  altGraph?: boolean;
  scope: ActionCategory;
  action: string | null;
}

const PRESSES: Press[] = [
  { platform: "win32", layout: "US", key: "[", code: "BracketLeft", scope: "Develop", action: "brush.smaller" },
  { platform: "win32", layout: "US", key: "[", code: "BracketLeft", mods: { alt: true }, scope: "Library", action: "photo.rotateCCW" },
  { platform: "win32", layout: "US", key: "1", code: "Digit1", mods: { ctrl: true }, scope: "Develop", action: "develop.zoom100" },
  { platform: "darwin", layout: "US", key: "“", code: "BracketLeft", mods: { alt: true }, scope: "Library", action: "photo.rotateCCW" },
  { platform: "darwin", layout: "US", key: "‘", code: "BracketRight", mods: { alt: true }, scope: "Library", action: "photo.rotateCW" },
  { platform: "darwin", layout: "US", key: "z", code: "KeyZ", mods: { meta: true }, scope: "Develop", action: "develop.undo" },
  { platform: "darwin", layout: "German", key: "[", code: "Digit5", mods: { alt: true }, scope: "Develop", action: "brush.smaller" },
  { platform: "darwin", layout: "German", key: "[", code: "Digit5", mods: { alt: true }, scope: "Library", action: null },
  { platform: "darwin", layout: "German", key: "]", code: "Digit6", mods: { alt: true }, scope: "Develop", action: "brush.larger" },
  { platform: "darwin", layout: "German", key: "•", code: "BracketLeft", mods: { alt: true }, scope: "Library", action: "photo.rotateCCW" },
  { platform: "win32", layout: "German", key: "[", code: "Digit8", mods: { ctrl: true, alt: true }, altGraph: true, scope: "Develop", action: "brush.smaller" },
  { platform: "win32", layout: "German", key: "]", code: "Digit9", mods: { ctrl: true, alt: true }, altGraph: true, scope: "Develop", action: "brush.larger" },
  { platform: "win32", layout: "German", key: "z", code: "KeyY", mods: { ctrl: true }, scope: "Develop", action: "develop.undo" },
  { platform: "win32", layout: "German", key: "y", code: "KeyZ", mods: { ctrl: true }, scope: "Develop", action: "develop.redo" },
  { platform: "win32", layout: "German", key: "ü", code: "BracketLeft", scope: "Develop", action: "brush.smaller" },
  { platform: "win32", layout: "Swedish", key: "[", code: "Digit8", mods: { ctrl: true, alt: true }, altGraph: true, scope: "Develop", action: "brush.smaller" },
  { platform: "win32", layout: "French", key: "[", code: "Digit5", mods: { ctrl: true, alt: true }, altGraph: true, scope: "Develop", action: "brush.smaller" },
  { platform: "win32", layout: "French", key: "&", code: "Digit1", scope: "Library", action: "rate.1" },
  { platform: "win32", layout: "French", key: "é", code: "Digit2", scope: "Library", action: "rate.2" },
  { platform: "win32", layout: "French", key: "\"", code: "Digit3", scope: "Library", action: "rate.3" },
  { platform: "win32", layout: "French", key: "'", code: "Digit4", scope: "Library", action: "rate.4" },
  { platform: "win32", layout: "French", key: "(", code: "Digit5", scope: "Library", action: "rate.5" },
  { platform: "win32", layout: "French", key: "à", code: "Digit0", scope: "Library", action: "rate.0" },
  { platform: "win32", layout: "French", key: "è", code: "Digit7", scope: "Library", action: "label.yellow" },
  { platform: "win32", layout: "French", key: "_", code: "Digit8", scope: "Library", action: "label.green" },
  { platform: "win32", layout: "French", key: "ç", code: "Digit9", scope: "Library", action: "label.blue" },
  { platform: "win32", layout: "French", key: "&", code: "Digit1", mods: { ctrl: true }, scope: "Develop", action: "develop.zoom100" },
  { platform: "linux", layout: "Russian", key: "п", code: "KeyG", scope: "General", action: "module.library" },
  { platform: "linux", layout: "Russian", key: "я", code: "KeyZ", mods: { ctrl: true }, scope: "Develop", action: "develop.undo" },
];

function press(p: Press): KeyboardEvent {
  return {
    key: p.key,
    code: p.code,
    ctrlKey: !!p.mods?.ctrl,
    shiftKey: !!p.mods?.shift,
    altKey: !!p.mods?.alt,
    metaKey: !!p.mods?.meta,
    getModifierState: (m: string) => m === "AltGraph" && !!p.altGraph,
  } as unknown as KeyboardEvent;
}

beforeEach(() => {
  useKeybindings.setState({ overrides: {} });
  useExtensionActions.setState({ actions: new Map() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("default shortcuts across keyboard layouts", () => {
  it.each(PRESSES)("$platform $layout: $key ($code) in $scope → $action", (p) => {
    vi.stubGlobal("window", { safelightNative: { platform: p.platform } });
    expect(matchAction(press(p), [p.scope])).toBe(p.action);
  });
});
