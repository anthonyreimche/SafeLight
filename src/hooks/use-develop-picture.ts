// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the develop canvas holds of the open photo, and how a new picture reaches it:
// painted at once, or held for the commit that resizes the box, and eased in from the
// tier before it when it is of the same shape and place.

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CropRect } from "@/catalog/types";
import type { RenderBridge } from "@/rendering/render-bridge";
import { cancelCrossfade, snapshotCrossfade } from "@/ui/canvas-crossfade";
import { endHandover } from "@/ui/canvas-handover";
import type { ImageWindow } from "@/ui/viewport-view";

/** What the develop canvas shows of the open photo: "stored", its stored preview, drawn
 *  as it is; "preview", frames of the camera's embedded preview while the full decode
 *  runs, or for good when the load settled on a preview; "final", frames of the image
 *  the load settled on (the full decode, the decode cache, or the source still resident
 *  on the GPU). */
export type DevelopTier = "stored" | "preview" | "final";

// What the canvas holds of the open photo eases into the next tier of it: the stored
// preview into the first developed frame, the camera's preview into the full decode.
// Anything else cuts, and so does every move to another photo.
const STORED_FADE_MS = 150;
const PREVIEW_FADE_MS = 220;

function fadeMs(from: DevelopTier, to: DevelopTier): number | null {
  if (from === "stored" && to !== "stored") return STORED_FADE_MS;
  if (from === "preview" && to === "final") return PREVIEW_FADE_MS;
  return null;
}

// A photo opened this soon after the one before (an arrow key held) cuts between its
// tiers. Kept per bridge: DevelopStage mounts a new canvas, and so a new view, per photo.
const QUICK_SWITCH_MS = 150;
const lastOpened = new WeakMap<RenderBridge, { photoId: string; at: number; fades: boolean }>();

/** Notes that `bridge`'s view opened `photoId`, and says whether its tiers may fade.
 *  The same photo opened again at once (React's StrictMode runs a mounting view's
 *  effects twice) is the same open. */
function noteOpened(bridge: RenderBridge, photoId: string): boolean {
  const at = performance.now();
  const before = lastOpened.get(bridge);
  if (before?.photoId === photoId && at - before.at < QUICK_SWITCH_MS) return before.fades;
  const fades = at - (before?.at ?? -Infinity) >= QUICK_SWITCH_MS;
  lastOpened.set(bridge, { photoId, at, fades });
  return fades;
}

/** Whether one size scaled into a box of the other's shows unstretched. */
function sameAspect(aw: number, ah: number, bw: number, bh: number): boolean {
  if (!(aw > 0 && ah > 0 && bw > 0 && bh > 0)) return false;
  return Math.abs(aw / ah / (bw / bh) - 1) < 0.01;
}

/** Whether two pictures hold the same window of the image (null: all of it). */
function sameWindow(a: ImageWindow | null, b: ImageWindow | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** What a picture on the canvas is of, which the view sizes and places it by. */
export interface Shown {
  width: number;
  height: number;
  // The window of the image it holds (FrameResult.roi); null, the whole image.
  window: ImageWindow | null;
  // The size of a picture of the whole image (FrameResult.wholeWidth); null, unknown.
  whole: { width: number; height: number } | null;
  // The region of the transformed image it is of (FrameResult.crop); null, unknown.
  crop: CropRect | null;
}

const NOTHING_SHOWN: Shown = { width: 0, height: 0, window: null, whole: null, crop: null };

/** Whether two pictures hold the same window of the same image: whole size and region. */
function samePlace(a: Shown, b: Shown): boolean {
  const sameWhole =
    !a.whole || !b.whole
      ? a.whole === b.whole
      : a.whole.width === b.whole.width && a.whole.height === b.whole.height;
  const sameCrop =
    !a.crop || !b.crop
      ? a.crop === b.crop
      : a.crop.x === b.crop.x &&
        a.crop.y === b.crop.y &&
        a.crop.width === b.crop.width &&
        a.crop.height === b.crop.height;
  return sameWindow(a.window, b.window) && sameWhole && sameCrop;
}

/** Whether two pictures are of the same size and place. */
function sameShown(a: Shown, b: Shown): boolean {
  return a.width === b.width && a.height === b.height && samePlace(a, b);
}

/** What `p` is of, without its pixels. */
function shownOf(p: Shown): Shown {
  return { width: p.width, height: p.height, window: p.window, whole: p.whole, crop: p.crop };
}

/** Something to put on the canvas: a frame, or the stored preview. Owns its bitmap. */
export interface Picture extends Shown {
  bitmap: ImageBitmap;
  tier: DevelopTier;
}

/** A picture of the whole image at its own size: the stored preview. */
export function storedPicture(bitmap: ImageBitmap): Picture {
  return { bitmap, width: bitmap.width, height: bitmap.height, tier: "stored", window: null, whole: null, crop: null };
}

export interface DevelopPicture {
  /** The canvas's box size and what of the image it holds. Changes in the same commit as
   *  the pixels (see present). */
  size: Shown;
  /** The highest tier of the open photo on the canvas; null while it holds nothing of it
   *  (blank, or the photo before). */
  tier: DevelopTier | null;
  /** The 2D context the view draws through, set while the view is wired to a bridge. */
  ctxRef: RefObject<CanvasRenderingContext2D | null>;
  /** Shows `next`: at once when it is of the size and place already painted (a drag costs
   *  no React render), else with the commit that resizes and places the box. */
  present: (next: Picture) => void;
  /** Forgets a picture still waiting for its box, which goes back to what is painted. */
  dropPending: () => void;
  /** Empties the canvas and its box: what it holds of the photo is no longer true. */
  clearPicture: () => void;
  /** The display canvas while it holds a picture of the open photo, else null. */
  pictureCanvas: () => HTMLCanvasElement | null;
  /** Whether the canvas holds a picture of the open photo. */
  isShowing: () => boolean;
  /** Starts a load of `photoId`: what the canvas holds is of another photo, or of this
   *  one's load before, so the first picture of this load cuts. The canvas keeps its last
   *  picture until then. Only a reload of the same photo reaches here with one:
   *  DevelopStage builds a new view per photo, and canvas-handover holds the photo before
   *  for a moment over the new, blank canvas. */
  beginPhoto: (bridge: RenderBridge, photoId: string) => void;
}

export function useDevelopPicture(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  // The overlay laid over the canvas with the same placement, which a tier of the
  // photo fades out on over the next (see fadeMs).
  fadeCanvasRef?: RefObject<HTMLCanvasElement | null>,
): DevelopPicture {
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const tierRef = useRef<DevelopTier | null>(null);
  const [tier, setTier] = useState<DevelopTier | null>(null);
  // The canvas's box size and what of the image it holds. Change in the same commit as
  // the pixels (see present).
  const [size, setSize] = useState<Shown>(NOTHING_SHOWN);
  // What the canvas holds of the open photo, and at what size; the tier is null while
  // it holds nothing of it (blank, or the photo before).
  const shownRef = useRef<DevelopTier | null>(null);
  const paintedRef = useRef<Shown>(NOTHING_SHOWN);
  // The photo the load effect opened last, and the one the canvas holds a picture of.
  const openedRef = useRef<string | null>(null);
  const paintedPhotoRef = useRef<string | null>(null);
  // Whether this photo's tiers may fade into each other (QUICK_SWITCH_MS).
  const fadesRef = useRef(true);
  // A picture of another size than the box, waiting for the commit that resizes it.
  const pendingRef = useRef<Picture | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  const resize = useCallback((next: Shown) => {
    setSize((s) => (sameShown(s, next) ? s : shownOf(next)));
  }, []);

  // Draws `next` now. What the canvas held eases into it when that was a lower tier of
  // the same photo, of the same shape and place. A picture of another shape or place
  // ends any fade: the overlay takes the canvas's new box and placement, and would show
  // the old picture stretched in it or where the new window's pixels belong.
  const paint = useCallback(
    (next: Picture) => {
      const cv = canvasRef.current;
      const ctx = ctxRef.current;
      if (!cv || !ctx) {
        next.bitmap.close();
        return;
      }
      const from = shownRef.current;
      const ms = from === null ? null : fadeMs(from, next.tier);
      const overlay = fadeCanvasRef?.current;
      const sameShape =
        sameAspect(cv.width, cv.height, next.width, next.height) &&
        samePlace(paintedRef.current, next);
      if (overlay && ms !== null && fadesRef.current && sameShape) {
        snapshotCrossfade(cv, overlay, ms);
      } else if (overlay && !sameShape) {
        cancelCrossfade(overlay);
      }
      if (cv.width !== next.width) cv.width = next.width;
      if (cv.height !== next.height) cv.height = next.height;
      ctx.drawImage(next.bitmap, 0, 0);
      next.bitmap.close();
      // The photo's first picture replaces what the view before left on screen.
      if (from === null) endHandover();
      shownRef.current = next.tier;
      paintedRef.current = shownOf(next);
      paintedPhotoRef.current = openedRef.current;
    },
    [canvasRef, fadeCanvasRef],
  );

  // Not `shownRef`: a photo loading again keeps its last picture on screen.
  const pictureCanvas = useCallback(
    () =>
      paintedPhotoRef.current !== null && paintedPhotoRef.current === openedRef.current
        ? canvasRef.current
        : null,
    [canvasRef],
  );

  // Shows `next`. A picture of the size and place already painted is drawn at once, so
  // a drag costs no React render. Another waits for the commit that resizes and places
  // the box (the layout effect below): drawn ahead of it, it showed stretched to the old
  // box, at the old window's place, by the old image's shape, or under a crop box drawn
  // for the old region.
  const present = useCallback(
    (next: Picture) => {
      if (!pendingRef.current && sameShown(paintedRef.current, next)) {
        paint(next);
      } else {
        pendingRef.current?.bitmap.close();
        pendingRef.current = next;
        resize(next);
        setPendingCount((n) => n + 1);
      }
      if (tierRef.current !== next.tier) {
        tierRef.current = next.tier;
        setTier(next.tier);
      }
    },
    [paint, resize],
  );

  const dropPending = useCallback(() => {
    const next = pendingRef.current;
    if (!next) return;
    next.bitmap.close();
    pendingRef.current = null;
    resize(paintedRef.current);
  }, [resize]);

  const clearPicture = useCallback(() => {
    dropPending();
    const cv = canvasRef.current;
    if (cv) {
      cv.width = 0;
      cv.height = 0;
    }
    const overlay = fadeCanvasRef?.current;
    if (overlay) cancelCrossfade(overlay);
    shownRef.current = null;
    paintedRef.current = NOTHING_SHOWN;
    paintedPhotoRef.current = null;
    tierRef.current = null;
    setTier(null);
    resize(NOTHING_SHOWN);
  }, [canvasRef, fadeCanvasRef, dropPending, resize]);

  const isShowing = useCallback(() => shownRef.current !== null, []);

  const beginPhoto = useCallback(
    (bridge: RenderBridge, photoId: string) => {
      tierRef.current = null;
      setTier(null);
      shownRef.current = null;
      openedRef.current = photoId;
      dropPending();
      const overlay = fadeCanvasRef?.current;
      if (overlay) cancelCrossfade(overlay);
      fadesRef.current = noteOpened(bridge, photoId);
    },
    [fadeCanvasRef, dropPending],
  );

  useLayoutEffect(() => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    paint(next);
  }, [pendingCount, paint]);

  return { size, tier, ctxRef, present, dropPending, clearPicture, pictureCanvas, isShowing, beginPhoto };
}
