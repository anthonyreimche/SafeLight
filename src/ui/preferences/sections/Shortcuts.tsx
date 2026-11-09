// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useContext, useEffect, useState } from "react";
import {
  KEY_ACTIONS,
  comboFromEvent,
  comboFromWheelEvent,
  findConflicts,
  resetAllBindings,
  resetBinding,
  setBinding,
  suspendShortcuts,
  useExtensionActions,
  useKeybindings,
  type ActionCategory,
} from "@/state/keybindings-store";
import { updateSettings, useSettings } from "@/state/settings-store";
import { btnCls, labelCls, PrefSearchContext, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

// Fixed viewport gestures shown (read-only) at the bottom of the Shortcuts
// section. Hoisted to module scope so both the search index (Shortcuts `items`)
// and the section render share one source of truth. [combo, description].
const VIEWPORT_FIXED: [string, string][] = [
  ["Esc", "Exit tool / close dialogue"],
  ["Space", "Toggle zoom (fit ↔ 100%)"],
  ["Ctrl/⌘ + Click", "Zoom in/out while masking or healing"],
  ["Ctrl/⌘ + Drag", "Pan while zoomed"],
  ["Ctrl/⌘ + Wheel", "Zoom (also trackpad pinch)"],
];

const PRETTY_KEYS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
};
const prettyCombo = (combo: string) =>
  combo
    .split("+")
    .map((p) => PRETTY_KEYS[p] ?? p)
    .join("+");

const CATEGORIES: ActionCategory[] = ["General", "Develop", "Library"];

export function ShortcutsSection() {
  const singleKeys = useSettings((s) => s.singleKeyShortcuts);
  const overrides = useKeybindings((s) => s.overrides);
  const extActionsMap = useExtensionActions((s) => s.actions);
  const extActions = Array.from(extActionsMap.values());
  const [capturing, setCapturing] = useState<string | null>(null);

  // While capturing, the global handlers stand down (they also listen in the
  // capture phase) and the next keydown is recorded. Esc cancels. Wheel-kind
  // actions record a wheel roll (with whatever modifiers are held) instead —
  // keys other than Esc are ignored so they can't end up with a dead binding.
  useEffect(() => {
    if (!capturing) return;
    const releaseShortcuts = suspendShortcuts();
    const wheelKind =
      KEY_ACTIONS.find((a) => a.id === capturing)?.kind === "wheel";
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      if (wheelKind) return;
      const combo = comboFromEvent(e);
      if (!combo) return; // bare modifier — keep waiting
      setBinding(capturing, combo);
      setCapturing(null);
    };
    const w = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setBinding(capturing, comboFromWheelEvent(e));
      setCapturing(null);
    };
    window.addEventListener("keydown", h, true);
    if (wheelKind)
      window.addEventListener("wheel", w, { capture: true, passive: false });
    return () => {
      releaseShortcuts();
      window.removeEventListener("keydown", h, true);
      window.removeEventListener("wheel", w, true);
    };
  }, [capturing]);

  const conflicts = findConflicts(overrides);

  // When the Preferences search is active, show only the bindings whose label
  // matches — otherwise the whole key list buries the one you searched for. The
  // explanatory text and reset button are chrome, so they hide while searching.
  const filterQ = useContext(PrefSearchContext);
  const matches = (label: string) => !filterQ || label.toLowerCase().includes(filterQ);

  // One editable binding row, shared by the built-in categories and extensions.
  const bindingRow = (a: { id: string; label: string; def: string; kind?: "wheel" }) => {
    const combo = overrides[a.id] ?? a.def;
    const overridden = a.id in overrides;
    const conflict = conflicts.has(a.id);
    return (
      <tr key={a.id} className="border-b border-border-subtle">
        <td className="py-1 pr-3 text-text-secondary">{a.label}</td>
        <td className="w-28 py-1 text-right">
          <button
            onClick={() => setCapturing(capturing === a.id ? null : a.id)}
            title={conflict ? "Conflicts with another shortcut" : undefined}
            className={`rounded px-2 py-0.5 font-medium ${
              capturing === a.id
                ? "bg-slider-fill text-on-accent"
                : conflict
                  ? "bg-surface-2 text-danger"
                  : "bg-surface-2 text-text-primary hover:bg-surface-3"
            }`}
          >
            {capturing === a.id
              ? a.kind === "wheel"
                ? "Roll wheel…"
                : "Press keys…"
              : prettyCombo(combo)}
          </button>
        </td>
        <td className="w-6 py-1 text-right">
          {overridden && (
            <button
              onClick={() => resetBinding(a.id)}
              title={`Reset to ${prettyCombo(a.def)}`}
              className="rounded px-1 text-text-muted hover:text-text-primary"
            >
              ↺
            </button>
          )}
        </td>
      </tr>
    );
  };

  const extVisible = extActions.filter((a) => matches(a.label));
  const fixedVisible = VIEWPORT_FIXED.filter(([, label]) => matches(label));

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Single-key shortcuts"
        hint="Disable if bare-letter shortcuts (G/D/F) conflict with other tools. Combinations with modifiers always work."
        checked={singleKeys}
        onChange={(v) => updateSettings({ singleKeyShortcuts: v })}
      />
      {!filterQ && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          Click a shortcut, then press the new keys. Esc cancels. Develop and
          Library shortcuts may share keys — they're active in different modules.
        </p>
      )}
      {CATEGORIES.map((cat) => {
        const acts = KEY_ACTIONS.filter(
          (a) => a.category === cat && matches(a.label),
        );
        if (acts.length === 0) return null;
        return (
          <div key={cat}>
            <div className={labelCls}>{cat}</div>
            <table className="mt-1 w-full text-[11px]">
              <tbody>{acts.map(bindingRow)}</tbody>
            </table>
          </div>
        );
      })}
      {extVisible.length > 0 && (
        <div>
          <div className={labelCls}>Extensions</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>{extVisible.map(bindingRow)}</tbody>
          </table>
        </div>
      )}
      {fixedVisible.length > 0 && (
        <div>
          <div className={labelCls}>Viewport (fixed)</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>
              {fixedVisible.map(([combo, label]) => (
                <tr key={combo} className="border-b border-border-subtle">
                  <td className="py-1 pr-3 text-text-secondary">{label}</td>
                  <td className="w-28 py-1 text-right">
                    <span className="rounded bg-surface-2 px-2 py-0.5 font-medium text-text-muted">
                      {combo}
                    </span>
                  </td>
                  <td className="w-6" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!filterQ && (
        <div>
          <button onClick={resetAllBindings} className={btnCls}>
            Reset all shortcuts
          </button>
        </div>
      )}
    </div>
  );
}

export const shortcutsSection: PrefSection = {
  id: "Shortcuts",
  label: "Shortcuts",
  group: "General",
  items: settings(
    "Single-key shortcuts",
    ...KEY_ACTIONS.map((a) => a.label),
    ...VIEWPORT_FIXED.map(([, label]) => label),
  ),
  keywords: ["keybindings", "keyboard"],
  render: () => <ShortcutsSection />,
};
