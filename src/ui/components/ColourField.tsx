// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shared colour control (#282), handed to extensions as api.ui.ColourField.
// A swatch as wide as the row shows the colour; clicking it opens a picker
// under it: a hue-by-saturation area (a hue bar for a hue-only field), a
// lightness bar for a field with lightness, and a hex field. The eyedropper
// beside the swatch holds the canvas's pick-drag tool and takes the photo's
// colour at the press. The extension keeps its own colour model: `toRgb`
// draws its hue, saturation and lightness, and `fromRgb` reads a hex or picked
// colour back into them; both default to HSL.

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { setPickDrag, usePickDragStore, type CanvasPoint, type PickDragTool } from "@/modules/develop/pick-drag";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { PickerIcon } from "./PickerIcon";
import { cssRgb, fromHex, hslToRgb, rgbToHsl, toHex, type Hsl, type Rgb } from "@/ui/colour-field-math";

/** The channels a field has: always hue, saturation and lightness when given. */
export interface ColourValue {
  hue: number;
  saturation?: number;
  lightness?: number;
}

export interface ColourFieldProps {
  label: string;
  /** Degrees, 0 to 360. */
  hue: number;
  /** Percent, 0 to 100. Leave it out for a hue-only field. */
  saturation?: number;
  /** Percent, 0 to 100. Give it for a field that also sets lightness. */
  lightness?: number;
  /** Live while a drag lasts, and once for a key, hex or pick; carries the
   *  field's channels only. */
  onChange(value: ColourValue): void;
  /** A drag ended, or a key, hex or pick changed the colour. */
  onCommit?(): void;
  /** The colour to show for hue, saturation and lightness (a missing channel
   *  comes as 100 and 50), display sRGB 0 to 1. Default: HSL. */
  toRgb?(hue: number, saturation: number, lightness: number): Rgb;
  /** A typed or picked colour (display sRGB 0 to 1) in the field's channels.
   *  Default: HSL. */
  fromRgb?(rgb: Rgb): Hsl;
  /** The eyedropper. `true` (the default) takes the colour the view shows;
   *  `{ paramBag }` samples a capture with that bag merged over the photo's,
   *  to leave the extension's own effect out; `false` hides it. */
  pick?: boolean | { paramBag: Record<string, unknown> };
  /** The swatch's tooltip. */
  title?: string;
}

/** What core binds per extension: who holds the pick-drag tool, and how a
 *  capture is sampled. `sample` is null when it can't render or the photo
 *  changed before the capture landed. */
export interface ColourFieldHost {
  owner: string;
  sample(point: CanvasPoint, paramBag: Record<string, unknown>): Promise<Rgb | null>;
}

const HUE_STOPS = Array.from({ length: 13 }, (_, i) => i * 30);
const LIGHT_STOPS = Array.from({ length: 11 }, (_, i) => i * 10);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Where a pointer sits in an element, 0 to 1 each way. Both the client point
 *  and the rect are visual pixels, so the ratio holds under Interface scale. */
function fraction(el: Element, clientX: number, clientY: number): { x: number; y: number } | null {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return null;
  return { x: clamp((clientX - r.left) / r.width, 0, 1), y: clamp((clientY - r.top) / r.height, 0, 1) };
}

/** Pointer drag on a bar or area: `at` maps the position to a value. */
function useDrag(at: (f: { x: number; y: number }) => void, onEnd: () => void) {
  const dragging = useRef(false);
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const f = fraction(e.currentTarget, e.clientX, e.clientY);
    if (f) at(f);
  };
  return {
    onPointerDown: (e: PointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      dragging.current = true;
      e.currentTarget.setPointerCapture?.(e.pointerId);
      e.currentTarget.focus();
      move(e);
    },
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => {
      if (dragging.current) move(e);
    },
    onPointerUp: () => {
      if (!dragging.current) return;
      dragging.current = false;
      onEnd();
    },
    onPointerCancel: () => {
      if (!dragging.current) return;
      dragging.current = false;
      onEnd();
    },
  };
}

/** Arrow keys move by 1, by 10 with Shift; Left/Right step `x`, Up/Down `y`. */
function keyStep(e: KeyboardEvent): { x: number; y: number } | null {
  const n = e.shiftKey ? 10 : 1;
  switch (e.key) {
    case "ArrowRight":
      return { x: n, y: 0 };
    case "ArrowLeft":
      return { x: -n, y: 0 };
    case "ArrowUp":
      return { x: 0, y: n };
    case "ArrowDown":
      return { x: 0, y: -n };
    default:
      return null;
  }
}

const MARKER =
  "sl-colour-marker pointer-events-none absolute top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow ring-1 ring-black/40";
const BAR = "sl-colour-bar relative h-4 w-full cursor-pointer touch-none rounded ring-1 ring-inset ring-black/15";

export function ColourField({ host, ...props }: ColourFieldProps & { host: ColourFieldHost }) {
  const { label, hue, saturation, lightness, onChange, pick = true, title } = props;
  const toRgb = props.toRgb ?? hslToRgb;
  const hasSat = saturation !== undefined;
  const hasLight = lightness !== undefined;
  const s = saturation ?? 100;
  const l = lightness ?? 50;

  const [open, setOpen] = useState(false);
  const latest = useRef(props);
  latest.current = props;

  /** A value in the field's own channels. */
  const value = (h: number, sat: number, light: number): ColourValue => {
    const v: ColourValue = { hue: h };
    if (hasSat) v.saturation = sat;
    if (hasLight) v.lightness = light;
    return v;
  };
  const commit = () => latest.current.onCommit?.();
  const fromColour = (rgb: Rgb): ColourValue => {
    const c = (latest.current.fromRgb ?? rgbToHsl)(rgb);
    return value(c.hue, c.saturation, c.lightness);
  };

  useEffect(() => (open ? pushEscapeHandler(() => setOpen(false)) : undefined), [open]);

  // ── Eyedropper ──
  const tool = useRef<PickDragTool | null>(null);
  const armed = usePickDragStore((st) => st.held !== null && st.held.tool === tool.current);
  const holding = (t: PickDragTool) => usePickDragStore.getState().held?.tool === t;

  useEffect(
    () => () => {
      if (tool.current && holding(tool.current)) setPickDrag(host.owner, null);
    },
    [host.owner],
  );

  const take = (t: PickDragTool, rgb: Rgb) => {
    if (!holding(t)) return;
    latest.current.onChange(fromColour(rgb));
    commit();
    setPickDrag(host.owner, null);
  };

  const toggleArmed = () => {
    if (armed) {
      setPickDrag(host.owner, null);
      return;
    }
    const bag = typeof pick === "object" ? pick.paramBag : null;
    const t: PickDragTool = bag
      ? {
          onPress: (point) => {
            host.sample(point, bag).then(
              (rgb) => rgb && take(t, rgb),
              (err: unknown) => console.warn(`[extensions] ${host.owner}: colour pick failed:`, err),
            );
          },
        }
      : { onDown: (rgb) => take(t, rgb) };
    tool.current = t;
    setPickDrag(host.owner, t);
  };

  // ── Picker parts ──
  const area = useDrag(({ x, y }) => onChange(value(Math.round(x * 360), Math.round((1 - y) * 100), l)), commit);
  const hueBar = useDrag(({ x }) => onChange(value(Math.round(x * 360), s, l)), commit);
  const lightBar = useDrag(({ x }) => onChange(value(hue, s, Math.round(x * 100))), commit);

  const stepKeys = (apply: (d: { x: number; y: number }) => ColourValue) => (e: KeyboardEvent) => {
    const d = keyStep(e);
    if (!d) return;
    e.preventDefault();
    onChange(apply(d));
    commit();
  };

  const shown = toRgb(hue, s, l);
  const hex = toHex(shown);
  const [hexText, setHexText] = useState(hex);
  const editingHex = useRef(false);
  useEffect(() => {
    if (!editingHex.current) setHexText(hex);
  }, [hex]);

  const takeHex = () => {
    editingHex.current = false;
    const rgb = fromHex(hexText);
    if (!rgb || toHex(rgb) === hex) {
      setHexText(hex);
      return;
    }
    onChange(fromColour(rgb));
    commit();
  };

  const hueGradient = `linear-gradient(to right, ${HUE_STOPS.map((h) => cssRgb(toRgb(h, s, l))).join(", ")})`;

  return (
    <div className="sl-colour-field flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="sl-slider-label w-20 shrink-0 text-[11px] text-text-secondary">{label}</span>
        <button
          type="button"
          aria-label={label}
          aria-expanded={open}
          title={title ?? `Choose the ${label.toLowerCase()}`}
          className="sl-colour-swatch h-4 min-w-0 flex-1 cursor-pointer rounded ring-1 ring-inset ring-black/15 hover:ring-text-muted"
          style={{ backgroundColor: cssRgb(shown) }}
          onClick={() => setOpen((o) => !o)}
        />
        {pick !== false && (
          <button
            type="button"
            aria-label={`Pick ${label} from the photo`}
            aria-pressed={armed}
            title="Click the photo to take its colour"
            className={`sl-colour-pick inline-flex h-5 w-6 shrink-0 items-center justify-center rounded transition-colors ${
              armed ? "bg-slider-fill text-on-accent" : "text-text-secondary hover:bg-surface-2"
            }`}
            onClick={toggleArmed}
          >
            <PickerIcon />
          </button>
        )}
      </div>
      {open && (
        <div className="sl-colour-picker flex flex-col gap-1.5">
          {hasSat ? (
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${label} hue and saturation`}
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={hue}
              aria-valuetext={`Hue ${Math.round(hue)}°, saturation ${Math.round(s)}%`}
              className="sl-colour-area relative h-24 w-full cursor-crosshair touch-none rounded ring-1 ring-inset ring-black/15"
              style={{
                background: `linear-gradient(to bottom, transparent, ${cssRgb(toRgb(0, 0, l))}), ${hueGradient}`,
              }}
              {...area}
              onKeyDown={stepKeys((d) => value(clamp(hue + d.x, 0, 360), clamp(s + d.y, 0, 100), l))}
            >
              <span
                className="sl-colour-marker pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow ring-1 ring-black/40"
                style={{ left: `${(hue / 360) * 100}%`, top: `${100 - s}%` }}
              />
            </div>
          ) : (
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${label} hue`}
              aria-valuemin={0}
              aria-valuemax={360}
              aria-valuenow={hue}
              className={BAR}
              style={{ background: hueGradient }}
              {...hueBar}
              onKeyDown={stepKeys((d) => value(clamp(hue + d.x + d.y, 0, 360), s, l))}
            >
              <span className={MARKER} style={{ left: `${(hue / 360) * 100}%` }} />
            </div>
          )}
          {hasLight && (
            <div
              role="slider"
              tabIndex={0}
              aria-label={`${label} lightness`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={l}
              className={BAR}
              style={{
                background: `linear-gradient(to right, ${LIGHT_STOPS.map((v) => cssRgb(toRgb(hue, s, v))).join(", ")})`,
              }}
              {...lightBar}
              onKeyDown={stepKeys((d) => value(hue, s, clamp(l + d.x + d.y, 0, 100)))}
            >
              <span className={MARKER} style={{ left: `${l}%` }} />
            </div>
          )}
          <input
            type="text"
            aria-label={`${label} hex`}
            spellCheck={false}
            className="sl-colour-hex w-20 rounded border border-border bg-surface-2 px-1.5 py-0.5 font-code text-[11px] text-text-primary"
            value={hexText}
            onFocus={() => (editingHex.current = true)}
            onChange={(e) => setHexText(e.currentTarget.value)}
            onBlur={takeHex}
            onKeyDown={(e) => {
              if (e.key === "Enter") takeHex();
            }}
          />
        </div>
      )}
    </div>
  );
}
