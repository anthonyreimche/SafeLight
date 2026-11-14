// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { memo, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRegistry } from "@/extensions/registry";
import { useSettings } from "@/state/settings-store";
import { useDevelopStore } from "@/state/develop-store";
import { parseDecimal } from "@/ui/parse-decimal";

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
  compact?: boolean; // narrow label + value, for tight columns (e.g. colour wheels)
  // CSS background for the track (e.g. a hue/lightness gradient). When set, the
  // filled bar is replaced by a thumb marker so the gradient stays visible —
  // the Lightroom-style coloured HSL tracks. Plain sliders ignore this.
  trackBackground?: string;
  onChange: (value: number) => void;
  onCommit?: () => void;
  // Fired with `true` when a drag is held with Alt or Ctrl down (and `false`
  // when that ends), for Lightroom-style "show me the effect" previews. The
  // modifier state is tracked live, so toggling Alt/Ctrl mid-drag re-fires.
  onModifierPreview?: (active: boolean) => void;
  // Shift+double-click sets this one value automatically (a plain double-click
  // still resets). The caller makes its own undo step.
  onAuto?: () => void;
}

// Fine-control factor while Shift is held during a drag.
const FINE = 0.2;

// Shift+wheel moves this fraction of the track per notch (at least one step),
// and commits once the notches have been still this long.
const WHEEL_FRACTION = 0.01;
const WHEEL_COMMIT_MS = 400;

// Keys that actually move a focused range input's value. onKeyUp commits only
// after one of these; any other key released over a focused slider (Ctrl+Z,
// Ctrl+Y, Ctrl+Shift+Z) moved nothing worth a commit.
const VALUE_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

// A gesture belongs to the photo open in Develop when it began. Develop commits
// a photo's uncommitted change as it moves to the next one, so a gesture still
// going after that writes and commits nothing, or the next photo would get it.
const openPhoto = () => useDevelopStore.getState().photoId;

// A panel that subscribes to every param re-renders all its sliders on each
// tick of one. The body only re-renders for what it shows; the callbacks reach
// it through stable proxies that call the latest ones, since callers pass
// inline closures bound to a mask or key.
const SliderView = memo(function SliderView({
  hasAuto,
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
  trackBackground,
  onChange,
  onCommit,
  onModifierPreview,
  onAuto,
}: Omit<SliderProps, "onAuto"> & { hasAuto: boolean; onAuto: () => void }) {
  const iconSvg = useRegistry((s) =>
    icon ? s.sliderIcons[icon]?.svg : undefined,
  );
  // Opt-in: a click snaps the value to the cursor instead of grabbing the
  // current value (see onPointerDown). Off keeps the default relative drag.
  const jumpToCursor = useSettings((s) => s.sliderJumpToCursor);
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
    photoId: string | null;
  } | null>(null);
  const pendingRef = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  // The value as the field was focused, for Escape to put back.
  const typedFromRef = useRef<number | null>(null);
  const focusClickRef = useRef(false);
  const wheelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheelPhotoRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // Focusing the field swaps the shown "+25" for the raw "25", which moves the
  // caret; select once that text is in, so typing replaces the whole value.
  const startedEditing = editing !== null;
  useEffect(() => {
    if (startedEditing) fieldRef.current?.select();
  }, [startedEditing]);

  // The wheel listener reads the latest props through a ref, so it is added
  // once and stays non-passive (React's onWheel is passive and can't stop the
  // panel scrolling).
  const wheelRef = useRef<(e: WheelEvent) => void>(() => {});
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;
  wheelRef.current = (e: WheelEvent) => {
    if (!e.shiftKey) return;
    // Shift turns the wheel horizontal on some systems.
    const delta = e.deltaY || e.deltaX;
    if (delta === 0) return;
    e.preventDefault();
    const notch = Math.max(step, (max - min) * WHEEL_FRACTION);
    onChange(snap(value + (delta < 0 ? notch : -notch)));
    if (wheelTimerRef.current != null) clearTimeout(wheelTimerRef.current);
    wheelPhotoRef.current = openPhoto();
    wheelTimerRef.current = setTimeout(() => {
      wheelTimerRef.current = null;
      if (wheelPhotoRef.current === openPhoto()) commitRef.current?.();
    }, WHEEL_COMMIT_MS);
  };

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => wheelRef.current(e);
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      // A commit still waiting on the wheel lands rather than being lost.
      if (wheelTimerRef.current != null) {
        clearTimeout(wheelTimerRef.current);
        wheelTimerRef.current = null;
        if (wheelPhotoRef.current === openPhoto()) commitRef.current?.();
      }
    };
  }, []);

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
          if (dragRef.current?.photoId === openPhoto()) onChange(pendingRef.current);
          pendingRef.current = null;
        }
      });
    }
  };

  const flushPending = (apply: boolean) => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (pendingRef.current != null) {
      if (apply) onChange(pendingRef.current);
      pendingRef.current = null;
    }
  };

  const reset = () => {
    onChange(defaultValue);
    onCommit?.();
  };

  const onText = (raw: string) => {
    setEditing(raw);
    const n = parseDecimal(raw);
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
    // Default drag anchors at the current value (movement alone changes it).
    // Jump-to-cursor anchors at the value under the pointer so the click snaps
    // there first. Either way onPointerMove drags relative to this anchor — and
    // its slope equals the absolute clientX→value mapping, so a seeded anchor
    // turns into correct absolute tracking with no other change. The fraction
    // (clientX − left)/width is zoom-invariant: all three are visual-space, so
    // the Interface-scale body-zoom factor cancels (unlike layout-space hits).
    let startValue = value;
    if (jumpToCursor) {
      const rect = e.currentTarget.getBoundingClientRect();
      if (rect.width > 0) {
        const frac = (e.clientX - rect.left) / rect.width;
        startValue = snap(min + frac * (max - min));
      }
    }
    dragRef.current = {
      startX: e.clientX,
      startValue,
      shift: e.shiftKey,
      mod,
      photoId: openPhoto(),
    };
    setDragValue(startValue);
    // A click that lands on a new value commits it even without a drag; endDrag
    // flushes the queued change and fires onCommit on pointer-up.
    if (startValue !== value) queueChange(startValue);
    if (mod) onModifierPreview?.(true);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLInputElement>) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.photoId !== openPhoto()) {
      endDrag();
      return;
    }
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
    const d = dragRef.current;
    if (!d) return;
    dragRef.current = null;
    const samePhoto = d.photoId === openPhoto();
    flushPending(samePhoto);
    setDragValue(null);
    if (d.mod) onModifierPreview?.(false);
    if (samePhoto) onCommit?.();
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
          className={`sl-slider-label ${compact ? "w-9" : "w-20"} shrink-0 ${compact ? "text-[10px]" : "text-[11px]"} text-text-secondary`}
        >
          {label}
        </label>
      )}
      {/* sl-slider-wrap shows a focus ring (index.css) when the range input —
          which is opacity-0, so its own outline can't show — is keyboard-focused.
          The sl-slider-* classes are styling hooks for input-styling extensions. */}
      <div
        ref={wrapRef}
        className="sl-slider-wrap relative flex h-4 min-w-0 flex-1 select-none items-center rounded"
      >
        {trackBackground ? (
          // Coloured track: the gradient IS the bar; a marker shows the value so
          // the whole hue/tone ramp stays readable (Lightroom-style HSL tracks).
          <>
            <div
              className="sl-slider-track h-1.5 w-full rounded-full ring-1 ring-inset ring-black/15"
              style={{ background: trackBackground }}
            />
            <div
              className="sl-slider-marker pointer-events-none absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/40"
              style={{ left: `${pct}%` }}
            />
          </>
        ) : (
          <>
            <div className="sl-slider-track h-1.5 w-full overflow-hidden rounded-full bg-surface-3">
              <div
                className="sl-slider-fill h-full rounded-full bg-slider-fill"
                style={{ width: `${pct}%` }}
              />
            </div>
            {/* The knob exists only for extension stylesheets to show and shape;
                index.css hides it, so the filled bar alone marks the value. */}
            <span
              aria-hidden="true"
              className="sl-slider-thumb pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
              style={{ left: `${pct}%` }}
            />
          </>
        )}
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
          onKeyUp={(e) => {
            if (VALUE_KEYS.has(e.key)) onCommit?.();
          }}
          onDoubleClick={(e) => (e.shiftKey && hasAuto ? onAuto() : reset())}
          title={`${jumpToCursor ? "Click to set · drag" : "Drag"} to adjust · hold Shift for fine control · Shift+scroll to step · double-click to reset${hasAuto ? " · Shift+double-click for auto" : ""}`}
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
      </div>
      {!hideValue && (
        <input
          ref={fieldRef}
          type="text"
          inputMode="decimal"
          data-own-escape=""
          aria-label={`${label || ariaLabel || ""} value`.trim()}
          value={editing ?? display}
          onFocus={() => {
            typedFromRef.current = value;
            focusClickRef.current = true;
            setEditing(String(value));
          }}
          // The mouseup that ends the focusing click would collapse the
          // selection back to a caret; later clicks place the caret as usual.
          onMouseUp={(e) => {
            if (focusClickRef.current) e.preventDefault();
            focusClickRef.current = false;
          }}
          onChange={(e) => onText(e.target.value)}
          onKeyDown={(e) => {
            focusClickRef.current = false;
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              // Ours alone (data-own-escape keeps the global Esc handler off it);
              // stopPropagation keeps ancestors' handlers off it too.
              e.stopPropagation();
              const from = typedFromRef.current;
              typedFromRef.current = null;
              if (from !== null && from !== value) onChange(from);
              e.currentTarget.blur();
            }
          }}
          onBlur={() => {
            setEditing(null);
            // Escape cleared this: the value went back, so there's nothing to commit.
            if (typedFromRef.current === null) return;
            typedFromRef.current = null;
            onCommit?.();
          }}
          className={`sl-slider-value ${compact ? "w-8" : "w-12"} shrink-0 rounded bg-transparent px-1 text-right ${compact ? "text-[10px]" : "text-[11px]"} tabular-nums outline-none focus:bg-surface-2 ${
            outOfRange
              ? "text-label-red"
              : "text-text-secondary focus:text-text-primary"
          }`}
        />
      )}
    </div>
  );
});

export function Slider({ onChange, onCommit, onModifierPreview, onAuto, ...shown }: SliderProps) {
  const latest = useRef({ onChange, onCommit, onModifierPreview, onAuto });
  useLayoutEffect(() => {
    latest.current = { onChange, onCommit, onModifierPreview, onAuto };
  });
  const proxies = useRef({
    onChange: (v: number) => latest.current.onChange(v),
    onCommit: () => latest.current.onCommit?.(),
    onModifierPreview: (active: boolean) => latest.current.onModifierPreview?.(active),
    onAuto: () => latest.current.onAuto?.(),
  }).current;
  return <SliderView {...shown} {...proxies} hasAuto={onAuto !== undefined} />;
}
