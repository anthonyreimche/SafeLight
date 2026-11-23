// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One action's shortcut, as Preferences ▸ Shortcuts lists it: click, then
// press the new keys (a wheel action records a roll). Esc or a click elsewhere
// cancels; ↺ puts back the default. Extensions show it for their own actions
// (api.components.ShortcutField).

import { useEffect, useRef, useState } from "react";
import {
  KEY_ACTIONS,
  comboFromEvent,
  comboFromWheelEvent,
  findConflictsWith,
  resetBinding,
  setBinding,
  suspendShortcuts,
  useExtensionActions,
  useKeybindings,
} from "@/state/keybindings-store";
import { getExtensionName } from "@/extensions/param-registry";

const PRETTY_KEYS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
};

/** A combo as the Shortcuts list shows it: arrows as arrows, "None" for none. */
export const prettyCombo = (combo: string) =>
  combo
    ? combo
        .split("+")
        .map((p) => PRETTY_KEYS[p] ?? p)
        .join("+")
    : "None";

export interface ShortcutFieldProps {
  /** A built-in action's id, or one an extension registered. */
  actionId: string;
}

export function ShortcutField({ actionId }: ShortcutFieldProps) {
  const overrides = useKeybindings((s) => s.overrides);
  // The whole map, so a clash with an extension that loads later shows up.
  const extensions = useExtensionActions((s) => s.actions);
  const extension = extensions.get(actionId);
  const builtin = KEY_ACTIONS.find((a) => a.id === actionId);
  const [capturing, setCapturing] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  const def = builtin?.def ?? extension?.def ?? "";
  const label = builtin?.label ?? extension?.label ?? actionId;
  const wheel = builtin?.kind === "wheel";
  const combo = overrides[actionId] ?? def;
  const overridden = actionId in overrides;
  const clashes = capturing ? [] : findConflictsWith(actionId, overrides);
  const conflict = clashes.length > 0;

  // While recording, the global handlers stand down (they also listen in the
  // capture phase) and the next keydown is recorded. A wheel action takes a
  // roll instead, and keys other than Esc are ignored so it can't end up with
  // a binding it can never fire.
  useEffect(() => {
    if (!capturing) return;
    const release = suspendShortcuts();
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setCapturing(false);
      if (wheel) return;
      const next = comboFromEvent(e);
      if (!next) return; // a bare modifier: keep waiting
      setBinding(actionId, next);
      setCapturing(false);
    };
    const roll = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setBinding(actionId, comboFromWheelEvent(e));
      setCapturing(false);
    };
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setCapturing(false);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", away, true);
    if (wheel) window.addEventListener("wheel", roll, { capture: true, passive: false });
    return () => {
      release();
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("wheel", roll, true);
    };
  }, [capturing, wheel, actionId]);

  return (
    <span ref={root} className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Shortcut for ${label}`}
        aria-pressed={capturing}
        onClick={() => setCapturing((c) => !c)}
        title={
          conflict
            ? `Conflicts with ${clashes
                .map((c) => (c.extensionId ? `${c.label} (${getExtensionName(c.extensionId)})` : c.label))
                .join(", ")}. Click to choose other keys.`
            : undefined
        }
        className={`rounded px-2 py-0.5 text-[11px] font-medium ${
          capturing
            ? "bg-slider-fill text-on-accent"
            : conflict
              ? "bg-surface-2 text-danger"
              : combo
                ? "bg-surface-2 text-text-primary hover:bg-surface-3"
                : "bg-surface-2 text-text-muted hover:bg-surface-3"
        }`}
      >
        {capturing ? (wheel ? "Roll wheel…" : "Press keys…") : prettyCombo(combo)}
      </button>
      <span className="w-4 text-right">
        {overridden && !capturing && (
          <button
            type="button"
            onClick={() => resetBinding(actionId)}
            aria-label={`Reset to ${prettyCombo(def)}`}
            title={`Reset to ${prettyCombo(def)}`}
            className="rounded px-1 text-text-muted hover:text-text-primary"
          >
            ↺
          </button>
        )}
      </span>
    </span>
  );
}
