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
  /** Bound to a wheel roll (combo key "Wheel") instead of a keypress; the
   *  Shortcuts editor captures a wheel gesture for these rows. */
  kind?: "wheel";
}

// Scopes: General actions are global; Develop/Library actions only fire in
// their module, so the same combo may appear in both without conflict.
export const KEY_ACTIONS: KeyAction[] = [
  // ── General ──
  { id: "module.library", label: "Go to Library", category: "General", def: "G" },
  { id: "module.develop", label: "Go to Develop", category: "General", def: "D" },
  { id: "panels.toggle", label: "Hide / show all panels", category: "General", def: "Tab" },
  { id: "panels.toggleLeft", label: "Hide / show left panels", category: "General", def: "" },
  { id: "panels.toggleRight", label: "Hide / show right panels", category: "General", def: "" },
  { id: "panels.toggleBottom", label: "Hide / show bottom panels", category: "General", def: "" },
  { id: "view.fullscreen", label: "Fullscreen", category: "General", def: "F" },
  { id: "app.preferences", label: "Preferences", category: "General", def: "Ctrl+," },
  { id: "app.extensions", label: "Extensions", category: "General", def: "Ctrl+Shift+X" },
  { id: "app.reportIssue", label: "Report an issue", category: "General", def: "" },
  { id: "app.openFolder", label: "Open folder", category: "General", def: "Ctrl+O" },
  // The wheel-zoom gesture over the image viewport (Develop). Same
  // combo grammar with "Wheel" as the key, so it can carry a modifier
  // ("Alt+Wheel") or be cleared to disable wheel zoom entirely. Ctrl/⌘+Wheel
  // stays a fixed gesture on top (trackpad pinch + overlay passthrough).
  { id: "viewport.wheelZoom", label: "Zoom with scroll wheel", category: "General", def: "Wheel", kind: "wheel" },
  // ── Develop ──
  { id: "develop.undo", label: "Undo edit", category: "Develop", def: "Ctrl+Z" },
  { id: "develop.redo", label: "Redo edit", category: "Develop", def: "Ctrl+Shift+Z", altDef: "Ctrl+Y" },
  { id: "develop.reset", label: "Reset all edits", category: "Develop", def: "Ctrl+Shift+R" },
  // Photoshop's zoom set. The quartet drives whichever viewport is registered
  // in viewport-zoom-commands; with none mounted the combos fall through.
  { id: "develop.zoomIn", label: "Zoom in", category: "Develop", def: "Ctrl+=", altDef: "Ctrl++" },
  { id: "develop.zoomOut", label: "Zoom out", category: "Develop", def: "Ctrl+-" },
  { id: "develop.zoomFit", label: "Zoom to fit", category: "Develop", def: "Ctrl+0" },
  { id: "develop.zoom100", label: "Zoom to 100%", category: "Develop", def: "Ctrl+1" },
  { id: "develop.toggleClipping", label: "Toggle clipping overlay", category: "Develop", def: "J" },
  { id: "develop.toggleProof", label: "Toggle soft proof", category: "Develop", def: "S" },
  { id: "develop.colorAssessment", label: "Toggle color assessment", category: "Develop", def: "Ctrl+B" },
  { id: "develop.surroundDarker", label: "Surround darker", category: "Develop", def: "Ctrl+Shift+[", altDef: "Ctrl+Shift+{" },
  { id: "develop.surroundLighter", label: "Surround lighter", category: "Develop", def: "Ctrl+Shift+]", altDef: "Ctrl+Shift+}" },
  { id: "brush.smaller", label: "Shrink brush", category: "Develop", def: "[" },
  { id: "brush.larger", label: "Grow brush", category: "Develop", def: "]" },
  { id: "brush.featherDown", label: "Less brush feather", category: "Develop", def: "Shift+[", altDef: "Shift+{" },
  { id: "brush.featherUp", label: "More brush feather", category: "Develop", def: "Shift+]", altDef: "Shift+}" },
  { id: "brush.opacityDown", label: "Less brush opacity", category: "Develop", def: "," },
  { id: "brush.opacityUp", label: "More brush opacity", category: "Develop", def: "." },
  { id: "brush.flowDown", label: "Less brush flow", category: "Develop", def: "Shift+,", altDef: "Shift+<" },
  { id: "brush.flowUp", label: "More brush flow", category: "Develop", def: "Shift+.", altDef: "Shift+>" },
  { id: "mask.delete", label: "Delete mask component", category: "Develop", def: "Delete", altDef: "Backspace" },
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
  { id: "photo.remove", label: "Remove from catalog", category: "Library", def: "Delete", altDef: "Backspace" },
  // Ships unbound: deleting files from disk is opt-in even as a shortcut.
  { id: "photo.deleteDisk", label: "Delete from disk", category: "Library", def: "" },
  { id: "photo.rename", label: "Rename photo", category: "Library", def: "F2" },
  { id: "photo.reveal", label: "Show in folder", category: "Library", def: "Ctrl+R" },
  { id: "photo.copySettings", label: "Copy settings", category: "Library", def: "Ctrl+Shift+C" },
  { id: "photo.pasteSettings", label: "Paste settings", category: "Library", def: "Ctrl+Shift+V" },
  { id: "keyword.focus", label: "Focus keyword input", category: "Library", def: "K" },
  { id: "grid.smaller", label: "Smaller thumbnails", category: "Library", def: "-" },
  { id: "grid.larger", label: "Larger thumbnails", category: "Library", def: "=", altDef: "+" },
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

export interface BindingInfo {
  id: string;
  label: string;
  category: ActionCategory;
  /** Current combo (override applied); "" when the action has no binding. */
  combo: string;
}

/** Every built-in key action with its CURRENT combo, so tools can check against
 *  live bindings instead of a hard-coded list (e.g. flag a remap that collides
 *  with a real shortcut). Non-reactive — read it when you need it. */
export function listBindings(): BindingInfo[] {
  const { overrides } = useKeybindings.getState();
  return KEY_ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    category: a.category,
    combo: overrides[a.id] ?? a.def,
  }));
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
  const holder = Object.hasOwn(DEFAULTS, c.id) ? "Safelight" : useExtensionActions.getState().actions.get(c.id)?.extensionId;
  if (holder !== undefined && holder !== extensionId) {
    console.warn(`[extensions] ${extensionId}: "${c.id}" is already registered by ${holder}; registerKeybinding ignored`);
    return;
  }
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
  const { overrides } = useKeybindings.getState();
  for (const combo of comboCandidates(e)) {
    for (const ea of useExtensionActions.getState().actions.values()) {
      if ((overrides[ea.id] ?? ea.def) === combo) return ea;
    }
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

// The global handlers stand down while something owns the keyboard: the
// Preferences combo recorder (they listen in the capture phase too and would
// otherwise execute the very key being recorded), the welcome setup, core
// dialogs. Each holder takes a hold and releases it, so overlapping holders
// can close in any order without lifting the suspension under another.
const holds = new Set<symbol>();

/** Suspend the app's shortcuts until the returned release is called. A
 *  release counts once, however often it's called. */
export function suspendShortcuts(): () => void {
  const hold = Symbol("shortcut-hold");
  holds.add(hold);
  return () => void holds.delete(hold);
}

export const shortcutsSuspended = (): boolean => holds.size > 0;

/** Drop every hold, for test teardown when a spec leaves one behind. */
export function resetShortcutHoldsForTests(): void {
  holds.clear();
}

/** True when the key comes from inside an open native <dialog>. Core's own
 *  dialogs close through the escape stack; an extension's modal <dialog> (the
 *  Map's Set location) has no way onto it, so it owns its keys outright:
 *  Escape closes it rather than exiting a Develop tool behind it, and Ctrl
 *  combos stay with its fields. */
export function inNativeDialog(t: EventTarget | null): boolean {
  return t instanceof Element && t.closest("dialog[open]") !== null;
}

/** True when the event target actually accepts typed text — shortcuts must
 *  stay out of its way. Sliders, checkboxes and buttons are NOT editable:
 *  after dragging a slider it keeps focus, and Ctrl+Z should still undo. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  // Custom canvas editors (tone curve, mask handles, …) opt in via
  // data-keyboard-capture so global bare-key shortcuts defer to them while
  // focused — their own onKeyDown owns arrows/Enter/Delete/etc. Modifier combos
  // (Ctrl+Z, …) still pass through, since callers only consult this for bare keys.
  if (t.dataset.keyboardCapture != null) return true;
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

/** True when the keydown types into a text field rather than giving a
 *  shortcut. Only a Ctrl/Cmd combo is a shortcut there: Alt/Option types
 *  characters on a Mac (Option+[ is "“", a German Mac's @ and [), and so does
 *  AltGr, which Linux reports on its own and Windows as Ctrl+Alt. A Ctrl+Alt
 *  that gives a Latin letter or digit is a shortcut on both; one that types
 *  anything else (German "{", Polish "ą") is Windows AltGr. The field also
 *  keeps its own copy, paste, cut, undo, redo and select-all, with or without
 *  Shift. */
export function typesIntoField(e: KeyboardEvent): boolean {
  if (!isEditableTarget(e.target)) return false;
  if (!(e.ctrlKey || e.metaKey)) return true;
  if (TEXT_EDIT_KEYS.has(e.key.toLowerCase())) return true;
  // On a non-Latin layout the typed key is no Latin letter (Ctrl+Z is "я"), so
  // the combo is matched by its physical key.
  const physical = /^Key([A-Z])$/.exec(e.code ?? "")?.[1].toLowerCase();
  if (physical && TEXT_EDIT_KEYS.has(physical) && !/^[a-z]$/i.test(e.key)) return true;
  if (e.ctrlKey && e.altKey && !onMac()) return !/^[A-Za-z0-9]$/.test(e.key);
  return !!e.getModifierState?.("AltGraph");
}

const TEXT_EDIT_KEYS: ReadonlySet<string> = new Set(["c", "v", "x", "z", "y", "a"]);

// The US-layout character of each physical punctuation key, which the default
// combos are written in.
const CODE_KEYS: Record<string, string> = {
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** The combo key of the physical key `code`, or null for keys without one. A
 *  letter key only stands in for a typed character that isn't a Latin letter
 *  (Cyrillic, Option's ©): on QWERTZ or AZERTY the letter follows the label. */
function keyFromCode(code: string, typed: string): string | null {
  const digit = /^Digit(\d)$/.exec(code);
  if (digit) return digit[1];
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return /^[a-z]$/i.test(typed) ? null : letter[1];
  return CODE_KEYS[code] ?? null;
}

const onMac = (): boolean => globalThis.window?.safelightNative?.platform === "darwin";

function joinCombo(ctrl: boolean, shift: boolean, alt: boolean, k: string): string {
  const parts: string[] = [];
  if (ctrl) parts.push("Ctrl");
  if (shift) parts.push("Shift");
  if (alt) parts.push("Alt");
  parts.push(k);
  return parts.join("+");
}

/** The combos a keydown may mean, best first; empty for bare modifier presses.
 *  The typed key comes first, then the key at its position on a US layout, so
 *  digit and bracket shortcuts still reach layouts that type other characters
 *  there (AZERTY's "&" on the 1 key). macOS Option composes a character
 *  (Option+[ types "“"), so an Option combo is the physical key, and failing
 *  that the composed character bare: a German Mac types "[" as Option+5.
 *  Windows reports AltGr as Ctrl+Alt; the symbol it types is the key. */
function comboCandidates(e: KeyboardEvent): string[] {
  const k = e.key;
  if (k === "Control" || k === "Shift" || k === "Alt" || k === "Meta") return [];
  const ctrl = e.ctrlKey || e.metaKey;
  const typed = k.length === 1 ? k.toUpperCase() : k;
  const physical = k.length === 1 || k === "Dead" ? keyFromCode(e.code ?? "", k) : null;
  const asTyped = joinCombo(ctrl, e.shiftKey, e.altKey, typed);
  // A dead key (Option+E, US-International's ') names no key of its own.
  if (k === "Dead" && physical) return [joinCombo(ctrl, e.shiftKey, e.altKey, physical)];
  if (e.altKey && onMac()) {
    if (!physical) return [asTyped];
    const byPosition = [joinCombo(ctrl, e.shiftKey, true, physical), joinCombo(ctrl, e.shiftKey, false, typed)];
    // Bindings recorded before Option combos went by position hold the
    // composed character ("Alt+©"), so it is still tried last. An ASCII one
    // is a key of its own (German Option+5 is "["), which "Alt+[" means.
    return /^[\x20-\x7e]$/.test(k) ? byPosition : [...byPosition, asTyped];
  }
  // A letter or digit under Ctrl+Alt is a deliberate combo even where the
  // layout has AltGr; only a symbol is AltGr typing.
  if (e.ctrlKey && e.altKey && /^[^A-Za-z0-9]$/.test(k) && e.getModifierState?.("AltGraph")) {
    return [joinCombo(e.metaKey, e.shiftKey, false, typed), asTyped];
  }
  return physical && physical !== typed
    ? [asTyped, joinCombo(ctrl, e.shiftKey, e.altKey, physical)]
    : [asTyped];
}

/** Normalized combo from a keydown event; null for bare modifier presses. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  return comboCandidates(e)[0] ?? null;
}

/** Normalized combo from a wheel event — the same grammar as comboFromEvent
 *  with "Wheel" as the key, so wheel gestures store and conflict-check like
 *  any other binding. */
export function comboFromWheelEvent(e: WheelEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push("Wheel");
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
  const { overrides } = useKeybindings.getState();
  for (const combo of comboCandidates(e)) {
    for (const a of KEY_ACTIONS) {
      if (!categories.includes(a.category)) continue;
      const override = overrides[a.id];
      if ((override ?? a.def) === combo) return a.id;
      // Built-in aliases (e.g. Ctrl+Y for redo) apply until the user rebinds.
      if (override === undefined && a.altDef === combo) return a.id;
    }
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
    // Built-in aliases are live only while unbound (see matchAction); scan them
    // under their action's id so an alias collision surfaces too.
    ...KEY_ACTIONS.flatMap((a) =>
      a.altDef !== undefined && overrides[a.id] === undefined
        ? [{ id: a.id, category: a.category, combo: a.altDef, global: false }]
        : [],
    ),
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
