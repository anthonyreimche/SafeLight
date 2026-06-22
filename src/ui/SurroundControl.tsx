// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop status-bar widget to adjust the neutral surround behind the image,
// mirroring darktable's background brighten/darken controls. The −/+ buttons
// step through CANVAS_SURROUND_SHADES; the centre swatch opens a popover to pick
// any shade directly. Writes the same setting as the Preferences control. Only
// present when the canvas surround is enabled in Preferences ▸ Interface ▸
// Canvas surround — when it's off (surround follows the theme) there's nothing
// to adjust, so the widget hides.
import { useEffect, useRef, useState } from "react";
import {
  CANVAS_SURROUND_SHADES,
  stepCanvasSurround,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { pushEscapeHandler } from "@/ui/escape-stack";

const LAST = CANVAS_SURROUND_SHADES.length - 1;

export function SurroundControl() {
  const enabled = useSettings((s) => s.canvasSurroundOverride);
  const surround = useSettings((s) => s.canvasSurround);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close the picker on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onDown, true);
    const popEsc = pushEscapeHandler(() => setOpen(false));
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      popEsc();
    };
  }, [open]);

  if (!enabled) return null;

  const found = CANVAS_SURROUND_SHADES.findIndex((s) => s.value === surround);
  const idx = found === -1 ? CANVAS_SURROUND_SHADES.length - 2 : found; // → Middle grey
  const cur = CANVAS_SURROUND_SHADES[idx];

  const btn =
    "text-[11px] leading-none text-text-muted hover:text-text-primary disabled:opacity-30 disabled:hover:text-text-muted";

  return (
    <div ref={rootRef} className="relative flex items-center gap-1.5">
      <button
        className={btn}
        title="Darker surround"
        aria-label="Darker surround"
        onClick={() => stepCanvasSurround(-1)}
        disabled={idx === 0}
      >
        −
      </button>
      <button
        className="h-3 w-3 rounded-sm border border-border hover:border-text-muted"
        style={{ background: cur.value }}
        title={`Surround: ${cur.label} — click to choose`}
        aria-label="Choose surround shade"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      />
      <button
        className={btn}
        title="Lighter surround"
        aria-label="Lighter surround"
        onClick={() => stepCanvasSurround(1)}
        disabled={idx === LAST}
      >
        +
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-1/2 mb-1.5 flex -translate-x-1/2 gap-1 rounded border border-border bg-surface-2 p-1 shadow-lg"
        >
          {CANVAS_SURROUND_SHADES.map((shade) => (
            <button
              key={shade.value}
              role="menuitemradio"
              aria-checked={shade.value === cur.value}
              title={shade.label}
              aria-label={shade.label}
              onClick={() => {
                updateSettings({ canvasSurround: shade.value });
                setOpen(false);
              }}
              className={`h-4 w-4 rounded-sm border ${
                shade.value === cur.value
                  ? "border-slider-fill ring-1 ring-slider-fill"
                  : "border-border hover:border-text-muted"
              }`}
              style={{ background: shade.value }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
