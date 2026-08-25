// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Long-edge resolution picker shared by the Export panel and Preferences ▸
// Export: the four preset sizes plus a free pixel value (Custom). The input
// commits on blur/Enter, clamps to the supported range and reverts invalid
// entries; the export pipeline never upscales, so a value beyond the source
// simply yields the source size.

import { useEffect, useRef, useState } from "react";

export const MIN_LONG_EDGE = 16;
export const MAX_LONG_EDGE = 65536;

export const RESOLUTION_PRESETS: { value: number | null; label: string }[] = [
  { value: null, label: "Original" },
  { value: 4096, label: "4096 px" },
  { value: 2048, label: "2048 px" },
  { value: 1024, label: "1024 px" },
];

// Seed for the custom input when the current value has no number to show
// (Original selected).
const DEFAULT_CUSTOM_EDGE = 2048;

export function isPresetLongEdge(value: number | null): boolean {
  return RESOLUTION_PRESETS.some((p) => p.value === value);
}

/** Parse a typed long-edge value: positive numbers round and clamp to the
 *  supported range; anything else (empty, zero, garbage) is null. */
export function parseLongEdge(text: string): number | null {
  const n = Number(text);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_LONG_EDGE, Math.max(MIN_LONG_EDGE, Math.round(n)));
}

// The two host surfaces style their option chips differently (the Export
// panel's muted buttons vs. the Preferences dialog's filled OptionRow chips).
const VARIANTS = {
  panel: {
    container: "grid grid-cols-2 gap-1",
    input: "w-full min-w-0",
    chip: (active: boolean) =>
      `rounded px-2 py-1 text-[11px] ${
        active
          ? "bg-surface-3 text-text-primary"
          : "bg-surface-2 text-text-muted hover:text-text-primary"
      }`,
  },
  preferences: {
    container: "flex flex-wrap gap-1.5",
    input: "w-20",
    chip: (active: boolean) =>
      `rounded px-2 py-1 text-[11px] ${
        active
          ? "bg-slider-fill text-white"
          : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
      }`,
  },
};

export function ResolutionControl({
  value,
  onChange,
  variant,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  variant: keyof typeof VARIANTS;
}) {
  const styles = VARIANTS[variant];
  const inputRef = useRef<HTMLInputElement>(null);
  // Last value this control committed (or received); lets the sync effect tell
  // an outside change apart from the echo of its own onChange.
  const committed = useRef(value);
  const [customActive, setCustomActive] = useState(!isPresetLongEdge(value));
  const [text, setText] = useState(String(value ?? DEFAULT_CUSTOM_EDGE));

  useEffect(() => {
    if (value === committed.current) return;
    committed.current = value;
    setCustomActive(!isPresetLongEdge(value));
    setText(String(value ?? DEFAULT_CUSTOM_EDGE));
  }, [value]);

  const commit = (v: number | null) => {
    if (v === committed.current) return;
    committed.current = v;
    onChange(v);
  };

  const commitCustomText = () => {
    const parsed = parseLongEdge(text);
    if (parsed == null) {
      setCustomActive(!isPresetLongEdge(committed.current));
      setText(String(committed.current ?? DEFAULT_CUSTOM_EDGE));
      return;
    }
    setText(String(parsed));
    commit(parsed);
  };

  const selectCustom = () => {
    setCustomActive(true);
    const parsed = parseLongEdge(text);
    if (parsed != null) {
      setText(String(parsed));
      commit(parsed);
    }
    inputRef.current?.focus();
  };

  return (
    <div className={styles.container}>
      {RESOLUTION_PRESETS.map((p) => {
        const active = !customActive && value === p.value;
        return (
          <button
            key={p.label}
            onClick={() => {
              setCustomActive(false);
              commit(p.value);
            }}
            aria-pressed={active}
            className={styles.chip(active)}
          >
            {p.label}
          </button>
        );
      })}
      <button
        onClick={selectCustom}
        aria-pressed={customActive}
        className={styles.chip(customActive)}
      >
        Custom
      </button>
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          type="number"
          min={MIN_LONG_EDGE}
          max={MAX_LONG_EDGE}
          value={text}
          aria-label="Custom long edge (px)"
          onChange={(e) => {
            setText(e.target.value);
            setCustomActive(true);
          }}
          onBlur={() => {
            if (customActive) commitCustomText();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && customActive) commitCustomText();
          }}
          className={`${styles.input} rounded bg-surface-2 px-1.5 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3`}
        />
        <span className="text-[11px] text-text-muted">px</span>
      </div>
    </div>
  );
}
