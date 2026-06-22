// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Central, rebindable keyboard shortcuts. Every shortcut in the app is an
// "action" with a default combo; user overrides persist in localStorage and
// sync across windows (same pattern as settings-store). Handlers look up
// actions by combo at keydown time, so rebinding needs no re-registration.
//
// Combo format: "Ctrl+Shift+Alt+<Key>" where <Key> is e.key, single chars
// uppercased ("G", ",", "["), named keys as-is ("Tab", "ArrowLeft", "Delete").

import { create } from "zustand";

export type ActionCategory = "General" | "Develop" | "Library";

export interface KeyAction {
  id: string;
  label: string;
  category: ActionCategory;
  /** Default combo. */
  def: string;
  /** Secondary built-in combo (active only while the action isn't rebound). */
  altDef?: string;
}

// Scopes: General actions are global; Develop/Library actions only fire in
// their module, so the same combo may appear in both without conflict.
export const KEY_ACTIONS: KeyAction[] = [
  // ── General ──
  { id: "module.library", label: "Go to Library", category: "General", def: "G" },
  { id: "module.develop", label: "Go to Develop", category: "General", def: "D" },
  { id: "panels.toggle", label: "Hide / show all panels", category: "General", def: "Tab" },
  { id: "view.fullscreen", label: "Fullscreen", category: "General", def: "F" },
  { id: "app.preferences", label: "Preferences", category: "General", def: "Ctrl+," },
  { id: "app.extensions", label: "Extensions", category: "General", def: "Ctrl+Shift+X" },
  // ── Develop ──
  { id: "develop.undo", label: "Undo edit", category: "Develop", def: "Ctrl+Z" },
  { id: "develop.redo", label: "Redo edit", category: "Develop", def: "Ctrl+Shift+Z", altDef: "Ctrl+Y" },
  { id: "develop.reset", label: "Reset all edits", category: "Develop", def: "Ctrl+Shift+R" },
  { id: "develop.toggleClipping", label: "Toggle clipping overlay", category: "Develop", def: "J" },
  { id: "develop.colorAssessment", label: "Toggle color assessment", category: "Develop", def: "Ctrl+B" },
  { id: "develop.surroundDarker", label: "Surround darker", category: "Develop", def: "Ctrl+Shift+[" },
  { id: "develop.surroundLighter", label: "Surround lighter", category: "Develop", def: "Ctrl+Shift+]" },
  { id: "brush.smaller", label: "Shrink brush", category: "Develop", def: "[" },
  { id: "brush.larger", label: "Grow brush", category: "Develop", def: "]" },
  { id: "brush.featherDown", label: "Less brush feather", category: "Develop", def: "Shift+[", altDef: "Shift+{" },
  { id: "brush.featherUp", label: "More brush feather", category: "Develop", def: "Shift+]", altDef: "Shift+}" },
  { id: "brush.opacityDown", label: "Less brush opacity", category: "Develop", def: "," },
  { id: "brush.opacityUp", label: "More brush opacity", category: "Develop", def: "." },
  { id: "brush.flowDown", label: "Less brush flow", category: "Develop", def: "Shift+,", altDef: "Shift+<" },
  { id: "brush.flowUp", label: "More brush flow", category: "Develop", def: "Shift+.", altDef: "Shift+>" },
  { id: "mask.delete", label: "Delete mask component", category: "Develop", def: "Delete", altDef: "Backspace" },
  { id: "crop.cycleGuide", label: "Cycle crop guide", category: "Develop", def: "O" },
  { id: "crop.flipGuide", label: "Flip crop guide", category: "Develop", def: "Shift+O" },
  // ── Library ──
  { id: "rate.0", label: "Clear rating", category: "Library", def: "0" },
  { id: "rate.1", label: "Rating ★", category: "Library", def: "1" },
  { id: "rate.2", label: "Rating ★★", category: "Library", def: "2" },
  { id: "rate.3", label: "Rating ★★★", category: "Library", def: "3" },
  { id: "rate.4", label: "Rating ★★★★", category: "Library", def: "4" },
  { id: "rate.5", label: "Rating ★★★★★", category: "Library", def: "5" },
  { id: "label.red", label: "Red label", category: "Library", def: "6" },
  { id: "label.yellow", label: "Yellow label", category: "Library", def: "7" },
  { id: "label.green", label: "Green label", category: "Library", def: "8" },
  { id: "label.blue", label: "Blue label", category: "Library", def: "9" },
  { id: "flag.pick", label: "Flag as pick", category: "Library", def: "P" },
  { id: "flag.reject", label: "Flag as reject", category: "Library", def: "X" },
  { id: "flag.unflag", label: "Remove flag", category: "Library", def: "U" },
  { id: "photo.prev", label: "Previous photo", category: "Library", def: "ArrowLeft" },
  { id: "photo.next", label: "Next photo", category: "Library", def: "ArrowRight" },
  { id: "photo.rotateCCW", label: "Rotate left", category: "Library", def: "Alt+[" },
  { id: "photo.rotateCW", label: "Rotate right", category: "Library", def: "Alt+]" },
  { id: "photo.flipH", label: "Flip horizontal", category: "Develop", def: "" },
  { id: "photo.flipV", label: "Flip vertical", category: "Develop", def: "" },
  { id: "photo.remove", label: "Remove from catalog", category: "Library", def: "Delete" },
  { id: "keyword.focus", label: "Focus keyword input", category: "Library", def: "K" },
];

const DEFAULTS: Record<string, string> = Object.fromEntries(
  KEY_ACTIONS.map((a) => [a.id, a.def]),
);

const KEY = "sl_keybindings_v1";

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return {};
}

/** Maps action id → combo. Only overrides are stored. */
export const useKeybindings = create<{ overrides: Record<string, string> }>(
  () => ({ overrides: load() }),
);

function persist(overrides: Record<string, string>): void {
  useKeybindings.setState({ overrides });
  try {
    localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {}
}

export function getBinding(actionId: string): string {
  return useKeybindings.getState().overrides[actionId] ?? DEFAULTS[actionId] ?? "";
}

export function setBinding(actionId: string, combo: string): void {
  const o = { ...useKeybindings.getState().overrides };
  if (combo === DEFAULTS[actionId]) delete o[actionId];
  else o[actionId] = combo;
  persist(o);
}

export function resetBinding(actionId: string): void {
  const o = { ...useKeybindings.getState().overrides };
  delete o[actionId];
  persist(o);
}

export function resetAllBindings(): void {
  persist({});
}

// ─── Extension-registered actions ────────────────────────────────────────────

interface ExtensionActionEntry {
  extensionId: string;
  id: string;
  label: string;
  category: ActionCategory;
  def: string;
  handler: () => void;
}

/** Reactive store so Preferences ▸ Shortcuts re-renders when extensions load. */
export const useExtensionActions = create<{ actions: Map<string, ExtensionActionEntry> }>(
  () => ({ actions: new Map() }),
);

export function registerExtensionAction(
  extensionId: string,
  c: { id: string; label: string; category?: ActionCategory; defaultCombo: string; handler: () => void },
): void {
  useExtensionActions.setState((s) => {
    const next = new Map(s.actions);
    next.set(c.id, {
      extensionId,
      id: c.id,
      label: c.label,
      category: c.category ?? "General",
      def: c.defaultCombo,
      handler: c.handler,
    });
    return { actions: next };
  });
}

export function unregisterExtensionActions(extensionId: string): void {
  useExtensionActions.setState((s) => {
    const next = new Map(s.actions);
    for (const [id, e] of next) {
      if (e.extensionId === extensionId) next.delete(id);
    }
    return { actions: next };
  });
}

/** Match the first extension action whose (possibly rebound) combo matches. */
export function matchExtensionAction(e: KeyboardEvent): ExtensionActionEntry | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  const { overrides } = useKeybindings.getState();
  for (const ea of useExtensionActions.getState().actions.values()) {
    if ((overrides[ea.id] ?? ea.def) === combo) return ea;
  }
  return null;
}

/** Follow rebinds made in other windows. Call once at boot. */
export function initKeybindings(): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || e.newValue == null) return;
    try {
      useKeybindings.setState({ overrides: JSON.parse(e.newValue) });
    } catch {}
  });
}

// While the Preferences shortcut editor is capturing a new combo, the global
// handlers must stand down (they listen in the capture phase too and would
// otherwise execute the very key being recorded).
let suspended = false;
export const setShortcutsSuspended = (v: boolean): void => {
  suspended = v;
};
export const shortcutsSuspended = (): boolean => suspended;

/** True when the event target actually accepts typed text — shortcuts must
 *  stay out of its way. Sliders, checkboxes and buttons are NOT editable:
 *  after dragging a slider it keeps focus, and Ctrl+Z should still undo. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)
    return true;
  if (t instanceof HTMLInputElement) {
    return ![
      "range",
      "checkbox",
      "radio",
      "button",
      "color",
      "file",
      "submit",
      "reset",
    ].includes(t.type);
  }
  return t.isContentEditable;
}

/** Normalized combo from a keydown event; null for bare modifier presses. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(k.length === 1 ? k.toUpperCase() : k);
  return parts.join("+");
}

/** Combo has no modifier keys and is a single printable character. */
export function isBareKey(combo: string): boolean {
  return !combo.includes("+") || combo === "+";
}

/** First action (within `categories`) whose binding matches the event. */
export function matchAction(
  e: KeyboardEvent,
  categories: ActionCategory[],
): string | null {
  const combo = comboFromEvent(e);
  if (!combo) return null;
  const { overrides } = useKeybindings.getState();
  for (const a of KEY_ACTIONS) {
    if (!categories.includes(a.category)) continue;
    const override = overrides[a.id];
    if ((override ?? a.def) === combo) return a.id;
    // Built-in aliases (e.g. Ctrl+Y for redo) apply until the user rebinds.
    if (override === undefined && a.altDef === combo) return a.id;
  }
  return null;
}

/** Conflicts: same combo used twice in scopes that can both be active
 *  (same category, or one of them General). Returns the set of action ids.
 *  Extension-registered actions participate too — they match globally
 *  (matchExtensionAction ignores scope), so they're treated as if General and
 *  can collide with anything sharing their combo. Without this, those "private"
 *  keys would conflict undetected. */
export function findConflicts(
  overrides: Record<string, string>,
): Set<string> {
  const out = new Set<string>();
  // `global` actions overlap every scope (they fire in any module).
  type Entry = { id: string; category: ActionCategory; combo: string; global: boolean };
  const entries: Entry[] = [
    ...KEY_ACTIONS.map((a) => ({
      id: a.id,
      category: a.category,
      combo: overrides[a.id] ?? a.def,
      global: false,
    })),
    ...Array.from(useExtensionActions.getState().actions.values()).map((e) => ({
      id: e.id,
      category: e.category,
      combo: overrides[e.id] ?? e.def,
      global: true,
    })),
  ];
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i];
      const b = entries[j];
      const overlap =
        a.global ||
        b.global ||
        a.category === b.category ||
        a.category === "General" ||
        b.category === "General";
      // Unbound actions (empty combo) never conflict — flip H/V ship unbound.
      if (overlap && a.combo !== "" && a.combo === b.combo) {
        out.add(a.id);
        out.add(b.id);
      }
    }
  }
  return out;
}
