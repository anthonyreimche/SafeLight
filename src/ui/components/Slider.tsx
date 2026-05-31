import { useEffect, useRef, useState } from "react";

interface SliderProps {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  defaultValue?: number; // double-clicking the track resets to this
  hideValue?: boolean; // hide the editable numeric field
  onChange: (value: number) => void;
  onCommit?: () => void;
}

// Fine-control factor while Shift is held during a drag.
const FINE = 0.2;

export function Slider({
  label,
  value,
  min = -100,
  max = 100,
  step = 1,
  defaultValue = 0,
  onChange,
  onCommit,
}: SliderProps) {
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
  const pct = ((shown - min) / (max - min)) * 100;
  const display = shown > 0 ? `+${shown}` : String(shown);

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
    if (!Number.isNaN(n)) onChange(clamp(n));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (e.button !== 0) return;
    e.preventDefault(); // take over from native position-to-value mapping
    e.currentTarget.focus();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, startValue: value, shift: e.shiftKey };
    setDragValue(value);
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
    const valuePerPx = ((max - min) / width) * (e.shiftKey ? FINE : 1);
    const next = snap(d.startValue + (e.clientX - d.startX) * valuePerPx);
    setDragValue(next);
    queueChange(next);
  };

  const endDrag = () => {
    if (!dragRef.current) return;
    dragRef.current = null;
    flushPending();
    setDragValue(null);
    onCommit?.();
  };

  return (
    <div className="flex items-center gap-2 py-0.5">
      {label !== "" && (
        <label className="w-20 shrink-0 text-[11px] text-text-secondary">
          {label}
        </label>
      )}
      <div className="relative flex h-4 min-w-0 flex-1 select-none items-center">
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
          <div
            className="h-full rounded-full bg-[#5a5a5a]"
            style={{ width: `${pct}%` }}
          />
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
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
      <input
        type="text"
        inputMode="decimal"
        value={editing ?? display}
        onFocus={() => setEditing(String(value))}
        onChange={(e) => onText(e.target.value)}
        onBlur={() => {
          setEditing(null);
          onCommit?.();
        }}
        className="w-12 shrink-0 rounded bg-transparent px-1 text-right text-[11px] tabular-nums text-text-secondary outline-none focus:bg-surface-2 focus:text-text-primary"
      />
    </div>
  );
}
