// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { createContext, useContext } from "react";
import { Switch } from "@/ui/components/Switch";

// While searching, section bodies render their *real* controls inside this
// context. The Field/Toggle/Slider wrappers read it and hide themselves when
// their label/hint doesn't match — so the results show the matching settings as
// live, editable controls rather than static text. Empty string = no filtering.
export const PrefSearchContext = createContext("");

/** A field wrapper is visible when there's no active filter, or its text matches it.
 *  Exported so extension-contributed settings sections (e.g. Accessibility)
 *  can reuse the same search-aware field primitives. */
export function useFieldVisible(label: string, hint?: string): boolean {
  const q = useContext(PrefSearchContext);
  if (!q) return true;
  return (
    label.toLowerCase().includes(q) ||
    (hint?.toLowerCase().includes(q) ?? false)
  );
}

// ─── Small controls ──────────────────────────────────────────────────────────

export const labelCls =
  "text-[10px] uppercase tracking-widest text-text-muted";
export const inputCls =
  "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3";
export const btnCls =
  "rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  if (!useFieldVisible(label, hint)) return null;
  return (
    <div>
      <div className={labelCls}>{label}</div>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  if (!useFieldVisible(label, hint)) return null;
  return (
    <div>
      <Switch
        checked={checked}
        onChange={onChange}
        className="w-full justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">{label}</span>
      </Switch>
      {hint && (
        <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  if (!useFieldVisible(label)) return null;
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className={labelCls}>{label}</span>
        <span className="text-[11px] text-text-primary">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="sl-slider mt-2 w-full"
        style={{
          background: `linear-gradient(to right, var(--color-slider-fill) ${pct}%, var(--color-surface-3) ${pct}%)`,
        }}
      />
    </div>
  );
}

export function OptionRow<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`rounded px-2 py-1 text-[11px] ${
            o.value === value
              ? "bg-slider-fill text-on-accent"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
