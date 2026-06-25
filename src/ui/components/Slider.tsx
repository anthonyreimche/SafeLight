// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useId, useRef, useState } from "react";
import { useRegistry } from "@/extensions/registry";

interface SliderProps {
  label: string;
  /** Accessible name when `label` is intentionally empty (e.g. compact colour-
   *  wheel / grid-size sliders that show no visible label). */
  ariaLabel?: string;
  /** Slider-icon contribution id (e.g. "core.exposure"); themes/extensions
   *  may register an SVG for it. Renders nothing if unregistered. */
  icon?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number; // double-clicking the track resets to this
  hideValue?: boolean; // hide the editable numeric field
  compact?: boolean; // narrow label + value, for tight columns (e.g. color wheels)
  onChange: (value: number) => void;
  onCommit?: () => void;
  // Fired with `true` when a drag is held with Alt or Ctrl down (and `false`
  // when that ends), for Lightroom-style "show me the effect" previews. The
  // modifier state is tracked live, so toggling Alt/Ctrl mid-drag re-fires.
  onModifierPreview?: (active: boolean) => void;
}

// Fine-control factor while Shift is held during a drag.
const FINE = 0.2;

export function Slider({
  label,
  ariaLabel,
  icon,
  value,
  min = -100,
  max = 100,
  step = 1,
  defaultValue = 0,
  hideValue = false,
  compact = false,
  onChange,
  onCommit,
  onModifierPreview,
}: SliderProps) {
  const iconSvg = useRegistry((s) =>
    icon ? s.sliderIcons[icon]?.svg : undefined,
  );
  const sliderId = useId();
  // Raw text while the numeric field is focused, so intermediate states
  // ("", "-", "1.") don't fight the controlled value.
  const [editing, setEditing] = useState<string | null>(null);
  // Local drag value drives the fill instantly (only this slider re-renders),
  // decoupled from the store update that re-renders every panel.
  const [dragValue, setDragValue] = useState<number | null>(null);

  const dragRef = useRef<{
    startX: number;
    startValue: number;
    shift: boolean;
    mod: boolean; // Alt/Ctrl held -> modifier preview active
  } | null>(null);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  const shown = dragValue ?? value;
  // The bar only represents the track range; a typed override past it pins full.
  const pct = Math.max(0, Math.min(100, ((shown - min) / (max - min)) * 100));
  const display = shown > 0 ? `+${shown}` : String(shown);
  // A value outside the normal range (only reachable by typing) reads red.
  const outOfRange = shown < min || shown > max;

  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  const snap = (v: number) => {
    const snapped = Math.round((clamp(v) - min) / step) * step + min;
    const decimals = (String(step).split(".")[1] ?? "").length;
    return Number(snapped.toFixed(decimals));
  };

  // Coalesce store updates to one per animation frame: a fast drag shouldn't
  // re-render every develop panel on every pointer event.
  const queueChange = (v: number) => {
    pendingRef.current = v;
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (pendingRef.current != null) {
          onChange(pendingRef.current);
          pendingRef.current = null;
        }
      });
    }
  };

  const flushPending = () => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current != null) {
      onChange(pendingRef.current);
      pendingRef.current = null;
    }
  };

  const reset = () => {
    onChange(defaultValue);
    onCommit?.();
  };

  const onText = (raw: string) => {
    setEditing(raw);
    if (raw === "" || raw === "-" || raw === ".") return;
    const n = Number(raw);
    // Typed values may exceed the track range (e.g. Exposure past +5); the drag
    // and arrow keys still clamp to it.
    if (Number.isFinite(n)) onChange(n);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // take over from native position-to-value mapping
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    const mod = e.altKey || e.ctrlKey;
    dragRef.current = { startX: e.clientX, startValue: value, shift: e.shiftKey, mod };
    setDragValue(value);
    if (mod) onModifierPreview?.(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const width = e.currentTarget.getBoundingClientRect().width;
    if (width <= 0) return;
    // Re-anchor when Shift toggles mid-drag so sensitivity changes smoothly.
    if (e.shiftKey !== d.shift) {
      d.startX = e.clientX;
      d.startValue = dragValue ?? value;
      d.shift = e.shiftKey;
    }
    // Toggling Alt/Ctrl mid-drag flips the effect preview on/off.
    const mod = e.altKey || e.ctrlKey;
    if (mod !== d.mod) {
      d.mod = mod;
      onModifierPreview?.(mod);
    }
    const valuePerPx = ((max - min) / width) * (e.shiftKey ? FINE : 1);
    const next = snap(d.startValue + (e.clientX - d.startX) * valuePerPx);
    setDragValue(next);
    queueChange(next);
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    const wasMod = dragRef.current.mod;
    dragRef.current = null;
    flushPending();
    setDragValue(null);
    if (wasMod) onModifierPreview?.(false);
    onCommit?.();
  };

  return (
    <div className="flex items-center gap-2 py-0.5">
      {iconSvg && (
        <span
          className="h-3 w-3 shrink-0 text-text-muted [&_svg]:h-full [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
      )}
      {label !== "" && (
        <label
          htmlFor={sliderId}
          className={`${compact ? "w-9" : "w-20"} shrink-0 ${compact ? "text-[10px]" : "text-[11px]"} text-text-secondary`}
        >
          {label}
        </label>
      )}
      {/* sl-slider-wrap shows a focus ring (index.css) when the range input —
          which is opacity-0, so its own outline can't show — is keyboard-focused. */}
      <div className="sl-slider-wrap relative flex h-4 min-w-0 flex-1 select-none items-center rounded">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-slider-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          id={sliderId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label || ariaLabel || undefined}
          onChange={(e) => onChange(Number(e.target.value))} // keyboard arrows
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyUp={onCommit}
          onDoubleClick={reset}
          title="Drag to adjust · hold Shift for fine control · double-click to reset"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      {!hideValue && (
        <input
          type="text"
          inputMode="decimal"
          aria-label={`${label || ariaLabel || ""} value`.trim()}
          value={editing ?? display}
          onFocus={() => setEditing(String(value))}
          onChange={(e) => onText(e.target.value)}
          onBlur={() => {
            setEditing(null);
            onCommit?.();
          }}
          className={`${compact ? "w-8" : "w-12"} shrink-0 rounded bg-transparent px-1 text-right ${compact ? "text-[10px]" : "text-[11px]"} tabular-nums outline-none focus:bg-surface-2 ${
            outOfRange
              ? "text-label-red"
              : "text-text-secondary focus:text-text-primary"
          }`}
        />
      )}
    </div>
  );
}
