// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The canvas-surround shade buttons, shared by Preferences and the welcome
// setup. A check mark, not just the ring or colour, marks the active shade
// (WCAG 1.4.1); its dark halo keeps it legible on every shade. Disabled while
// the surround follows the theme, so the row reads as inactive and leaves the
// tab order.

import { CANVAS_SURROUND_SHADES } from "@/state/settings-store";

export function CanvasSurroundSwatches({
  value,
  enabled,
  onChange,
}: {
  value: string;
  enabled: boolean;
  onChange: (shade: string) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Canvas surround shade"
      className={`flex gap-1.5 transition-opacity ${
        enabled ? "" : "pointer-events-none opacity-40"
      }`}
    >
      {CANVAS_SURROUND_SHADES.map((shade) => (
        <button
          key={shade.value}
          type="button"
          title={shade.label}
          aria-label={shade.label}
          aria-pressed={value === shade.value}
          disabled={!enabled}
          onClick={() => onChange(shade.value)}
          className={`relative h-7 flex-1 rounded border transition-all ${
            value === shade.value
              ? "border-slider-fill ring-1 ring-slider-fill"
              : "border-border hover:border-text-muted"
          }`}
          style={{ background: shade.value }}
        >
          {value === shade.value && (
            <span
              className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-bold leading-none text-white"
              style={{ textShadow: "0 0 2px #000, 0 0 2px #000" }}
            >
              ✓
            </span>
          )}
        </button>
      ))}
    </div>
  );
}
