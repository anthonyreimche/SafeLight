// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the develop renderer decides about a detail gain (native-frame.ts)
// before any GL: the part of the source a zoomed window shows, whether the
// window is drawn denser than the source's own texels, whether a gain already
// held serves it, and the cut to ask for when none does. Densities are output
// pixels per source texel, so 1 is the source drawn at its own size.

import type { CropRect } from "@/catalog/types";
import type { FrameRect } from "@/raw/native-frame";
import { mat3Apply, type Mat3 } from "../transform";
import { stageDraws } from "./pass-draws";
import { isDormant, paramIsActive } from "./stage-coverage";
import type { PrepassPass, PrepassStage, Rebuilder } from "./stage-injection";

/** A window of the view: fractions of the displayed (cropped) image. */
export interface ViewWindow {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The geometry a frame is drawn with (geometry.ts imageGeometry). */
export interface ViewGeometry {
  region: CropRect;
  inverse: Mat3;
}

export interface Size {
  width: number;
  height: number;
}

interface RebuildingStage extends Pick<PrepassStage, "stageId" | "dormant" | "viewOnly"> {
  passes: readonly Pick<PrepassPass, "iterations" | "drawCount">[];
}

const isTyped = (v: unknown): v is ArrayLike<number> => ArrayBuffer.isView(v) && !(v instanceof DataView);
const listed = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : isTyped(v) ? Array.from(v) : null);
const plain = (v: unknown): unknown => (typeof v === "boolean" ? Number(v) : v);

// Whether a bag value is the one its uniform starts at. Extensions hand every
// uniform a value on every frame, so most of what a bag holds is this.
function atStart(value: unknown, start: unknown): boolean {
  const a = listed(value);
  const b = listed(start);
  if (a && b) return a.length === b.length && a.every((x, i) => plain(x) === plain(b[i]));
  return !a && !b && plain(value) === plain(start);
}

/** Whether a stage that writes the colour ahead of the detail gain
 *  (BuiltStageInjection.rebuilders) is at work on a frame drawn from `bag`:
 *  its dormantWhen doesn't hold, or the bag holds a value of its own that has
 *  moved from where its uniform starts (one with no declared start counts
 *  when it isn't zero or false); and its passes draw at all. A stage with no
 *  passes has only its values to go by. An installed stage left as it came is
 *  not at work, whatever defaults its extension sends. */
export function rebuildsSource(
  rebuilders: readonly Rebuilder[],
  stages: readonly RebuildingStage[],
  bag: Readonly<Record<string, unknown>>,
): boolean {
  return rebuilders.some(({ id, defaults }) => {
    const stage = stages.find((s) => s.stageId === id);
    if (stage?.viewOnly) return false;
    if (stage?.dormant) return !isDormant(stage.dormant, bag) && stageDraws(stage, bag) > 0;
    const prefix = `${id}.`;
    const touched = Object.entries(bag).some(([key, value]) => {
      if (!key.startsWith(prefix)) return false;
      return key in defaults ? !atStart(value, defaults[key]) : paramIsActive(value);
    });
    if (!stage) return touched;
    const counted = stage.passes.some((pass) => pass.drawCount !== undefined);
    return (touched || counted) && stageDraws(stage, bag) > 0;
  });
}

/** What a contributed geometry stage may move a point by, in source UV, on
 *  every side of the box a cut covers. */
export const GEOMETRY_MARGIN = 0.03;
/** A cut covers this many times the window's box on each axis. */
export const CUT_SPAN = 1.5;
/** A window wants detail once its density passes the source's by this factor. */
export const DETAIL_THRESHOLD = 1.05;
/** A held gain serves a window while its density is at least this share of
 *  the window's: it is not cut again until the window wants over 10% more. */
export const KEEP_DENSITY = 0.9;
/** Nor once it is this many times denser than the window: a view zoomed out
 *  asks for a coarser cut. */
export const KEEP_DENSER = 1.5;
/** A frame draws no gain denser than this many times its own density: sampled
 *  with LINEAR and no mips, it would alias. */
export const DRAW_DENSER = 2;

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function clampRect(x0: number, y0: number, x1: number, y1: number): FrameRect | null {
  const left = clamp01(x0);
  const top = clamp01(y0);
  const right = clamp01(x1);
  const bottom = clamp01(y1);
  if (!(right > left && bottom > top)) return null;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** The source box `roi` shows: its corners mapped as the develop program maps
 *  a point (through the crop region, then the geometry's inverse with the
 *  homogeneous divide), bounded and clamped to the source; with the area of
 *  the footprint in source UV, unclamped. Null when it shows none of the
 *  source. */
export function sourceBox(roi: ViewWindow, geometry: ViewGeometry): { rect: FrameRect; area: number } | null {
  const { region, inverse } = geometry;
  const corners: [number, number][] = [
    [roi.x, roi.y],
    [roi.x + roi.w, roi.y],
    [roi.x + roi.w, roi.y + roi.h],
    [roi.x, roi.y + roi.h],
  ];
  const points = corners.map(([vx, vy]) =>
    mat3Apply(inverse, region.x + vx * region.width, region.y + vy * region.height),
  );
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  if (![...xs, ...ys, area].every(Number.isFinite) || area <= 0) return null;
  const rect = clampRect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  return rect && { rect, area };
}

/** `rect` grown by `margin` on every side, clamped to the source. */
export function padBox(rect: FrameRect, margin: number): FrameRect {
  return clampRect(rect.x - margin, rect.y - margin, rect.x + rect.w + margin, rect.y + rect.h + margin) ?? rect;
}

/** `rect` grown to CUT_SPAN times its size about its centre, clamped to the source. */
export function cutBox(rect: FrameRect): FrameRect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const hw = (rect.w * CUT_SPAN) / 2;
  const hh = (rect.h * CUT_SPAN) / 2;
  return clampRect(cx - hw, cy - hh, cx + hw, cy + hh) ?? rect;
}

/** A window that wants detail. */
export interface DetailView {
  /** The source box it shows, unpadded, which a gain must contain. */
  box: FrameRect;
  /** The box a cut for it covers. */
  cut: FrameRect;
  /** Its density, no more than the native frame holds. */
  need: number;
}

/** The detail `roi`, drawn at `out` pixels, wants from a `native` frame of a
 *  `base` source: null when it shows none of the source or is drawn no denser
 *  than DETAIL_THRESHOLD past the source's texels. `warped`: a contributed
 *  geometry stage may move the points the window shows, so its cut is padded. */
export function detailView(args: {
  roi: ViewWindow;
  out: { w: number; h: number };
  geometry: ViewGeometry;
  warped: boolean;
  base: Size;
  native: Size;
}): DetailView | null {
  const { roi, out, geometry, warped, base, native } = args;
  const shown = sourceBox(roi, geometry);
  if (!shown) return null;
  const density = Math.sqrt((out.w * out.h) / (shown.area * base.width * base.height));
  const nativeDensity = Math.min(native.width / base.width, native.height / base.height);
  const need = Math.min(density, nativeDensity);
  if (!(need > DETAIL_THRESHOLD)) return null;
  const padded = warped ? padBox(shown.rect, GEOMETRY_MARGIN) : shown.rect;
  return { box: shown.rect, cut: cutBox(padded), need };
}

/** The output size cutDetailGain is asked for: the native pixels the cut box
 *  can hold once snapped out to whole pixels (one more on each side), at the
 *  view's share of native density, scaled down to fit `maxEdge` (the texture
 *  limit) on both axes. At native density it is every pixel the cut takes. */
export function cutSize(view: DetailView, base: Size, native: Size, maxEdge: number): { outW: number; outH: number } {
  const share = view.need / Math.min(native.width / base.width, native.height / base.height);
  const outW = (view.cut.w * native.width + 2) * share;
  const outH = (view.cut.h * native.height + 2) * share;
  const fit = Math.min(1, maxEdge / outW, maxEdge / outH);
  return { outW: outW * fit, outH: outH * fit };
}

/** A cut the renderer asks for, under its request number: `rect` of the native
 *  frame held for `key`, at most `outW` x `outH`, against the `baseW` x `baseH`
 *  source it is drawn with (cutDetailGain). */
export interface DetailRequest {
  request: number;
  key: string;
  rect: FrameRect;
  outW: number;
  outH: number;
  baseW: number;
  baseH: number;
}

/** The renderer's detail requests: numbers that only grow, the newest one's
 *  source epoch and cut until it is answered, and the cut that last came to
 *  nothing, which isn't asked for again. A cut is named by a signature of the
 *  source epoch and the view it is for. */
export class DetailAsks {
  private issued = 0;
  private asked: { request: number; epoch: number; signature: string } | null = null;
  private refused: string | null = null;

  /** Whether the cut `signature` names would be asked for: neither waiting for
   *  its answer nor refused. */
  wants(signature: string): boolean {
    return signature !== this.refused && signature !== this.asked?.signature;
  }

  /** A new request number for the cut `signature` names, made against `epoch`,
   *  or null when it isn't wanted. Answers to earlier numbers go unheard. */
  ask(signature: string, epoch: number): number | null {
    if (!this.wants(signature)) return null;
    const request = ++this.issued;
    this.asked = { request, epoch, signature };
    return request;
  }

  /** The cut request `request` asked for, when it is the newest and `epoch` the
   *  one it was asked against: it is then answered. Null otherwise. */
  answer(request: number, epoch: number): string | null {
    const asked = this.asked;
    if (!asked || asked.request !== request || asked.epoch !== epoch) return null;
    this.asked = null;
    return asked.signature;
  }

  /** The cut `signature` names came to nothing. */
  refuse(signature: string): void {
    this.refused = signature;
  }

  /** The source changed: nothing is waited for or refused. */
  reset(): void {
    this.asked = null;
    this.refused = null;
  }
}

/** A gain map as the renderer holds it: the source epoch it was cut for, the
 *  rect it covers, and its size. */
export interface HeldGain {
  epoch: number;
  rect: FrameRect;
  width: number;
  height: number;
}

/** A gain's density over a `base` source. */
export function gainScale(gain: Pick<HeldGain, "rect" | "width" | "height">, base: Size): number {
  return Math.min(gain.width / (gain.rect.w * base.width), gain.height / (gain.rect.h * base.height));
}

/** Whether `held` serves `view` on the source drawn under `epoch`: cut for
 *  that source, containing the view's box to within half a native pixel, and
 *  at KEEP_DENSITY of its density or more. */
export function gainCovers(held: HeldGain, view: DetailView, epoch: number, base: Size, native: Size): boolean {
  if (held.epoch !== epoch) return false;
  const sx = 0.5 / native.width;
  const sy = 0.5 / native.height;
  const { rect } = held;
  const { box } = view;
  const contains =
    rect.x <= box.x + sx &&
    rect.y <= box.y + sy &&
    rect.x + rect.w >= box.x + box.w - sx &&
    rect.y + rect.h >= box.y + box.h - sy;
  const scale = gainScale(held, base);
  return contains && scale >= KEEP_DENSITY * view.need && scale <= KEEP_DENSER * view.need;
}

/** Whether a frame of `view` draws with `held` on the source drawn under
 *  `epoch`: cut for that source, overlapping the view's box, and no more than
 *  DRAW_DENSER times as dense as the view. */
export function gainServes(held: HeldGain, view: DetailView, epoch: number, base: Size): boolean {
  if (held.epoch !== epoch) return false;
  const { rect } = held;
  const { box } = view;
  const overlaps =
    rect.x < box.x + box.w && box.x < rect.x + rect.w && rect.y < box.y + box.h && box.y < rect.y + rect.h;
  return overlaps && gainScale(held, base) <= DRAW_DENSER * view.need;
}
