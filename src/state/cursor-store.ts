// Central cursor system. Two concerns live here:
//
//  1. A *registry* of named cursors — built-in semantic tokens (zoom-in, pan,
//     crop-resize-*, …) plus any an extension contributes — each resolving to a
//     native CSS keyword or a custom image (inline SVG or a URL) with a hotspot.
//     Core UI and overlays ask for a token by name instead of hardcoding CSS, so
//     the whole app shares one cursor vocabulary.
//
//  2. A priority *stack* of canvas-cursor requests. A develop tool (built-in or
//     an extension) pushes the cursor it wants while active; the Develop canvas
//     resolves the highest-priority request. This replaces the old "every layer
//     sets its own div cursor and they fight" with one resolved value.
//
// Extensions reach both through `api.registerCursor` and `api.develop
// .setCanvasCursor`; disabling an extension sweeps its cursors and any live
// request (see clearExtensionCursors, called from registry.unregisterExtension).

import { create } from "zustand";

/** A cursor definition: either a native CSS cursor value, or a custom image
 *  (inline `<svg…>` markup or an image/data URL) positioned by a hotspot. */
export type CursorSpec =
  | { css: string }
  | {
      /** Inline SVG markup (starts with "<svg") or an image / data URL. */
      image: string;
      /** Hotspot in image pixels (the active point). Default 0,0. */
      hotspotX?: number;
      hotspotY?: number;
      /** CSS keyword used if the image can't load (CSP, 404, size). Default "auto". */
      fallback?: string;
    };

/** The public shape an extension passes to api.registerCursor. Supply either
 *  `css` or `image` (with an optional hotspot). */
export interface CursorContribution {
  /** Globally unique, e.g. "my-ext.measure". */
  id: string;
  css?: string;
  image?: string;
  hotspotX?: number;
  hotspotY?: number;
  fallback?: string;
}

interface RegisteredCursor {
  spec: CursorSpec;
  /** Owning extension id, so disabling it sweeps the cursor. Undefined = core. */
  extensionId?: string;
}

interface CanvasCursorRequest {
  /** One slot per owner (e.g. an extension id); re-requesting replaces it. */
  key: string;
  spec: CursorSpec;
  priority: number;
  /** Monotonic insertion order, so equal priorities resolve most-recent-wins. */
  seq: number;
}

// Browser cursor images cap at ~128×128 (often 32×32 in practice); keep custom
// art small. Hotspot is in the image's own pixel space.
const EYEDROPPER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
  '<g fill="none" stroke="#fff" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 21l5-5"/><path d="M8 16l9-9 3 3-9 9-4 1z"/></g>' +
  '<g fill="none" stroke="#111" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M3 21l5-5"/><path d="M8 16l9-9 3 3-9 9-4 1z"/></g></svg>';

/** Built-in semantic cursor tokens. Overlays and the canvas reference these by
 *  name; extensions may reuse them or register their own. */
export const BUILTIN_CURSORS: Record<string, CursorSpec> = {
  default: { css: "default" },
  pointer: { css: "pointer" },
  crosshair: { css: "crosshair" },
  "not-allowed": { css: "not-allowed" },
  wait: { css: "wait" },
  progress: { css: "progress" },
  "zoom-in": { css: "zoom-in" },
  "zoom-out": { css: "zoom-out" },
  pan: { css: "grab" },
  panning: { css: "grabbing" },
  "crop-move": { css: "move" },
  "crop-resize-nwse": { css: "nwse-resize" },
  "crop-resize-nesw": { css: "nesw-resize" },
  "crop-resize-ns": { css: "ns-resize" },
  "crop-resize-ew": { css: "ew-resize" },
  // Sampling eyedropper, hotspot at the tip (bottom-left), crosshair fallback.
  pick: { image: EYEDROPPER_SVG, hotspotX: 3, hotspotY: 21, fallback: "crosshair" },
};

interface CursorState {
  cursors: Record<string, RegisteredCursor>;
  requests: CanvasCursorRequest[];
  seq: number;
}

export const useCursorStore = create<CursorState>(() => ({
  cursors: Object.fromEntries(
    Object.entries(BUILTIN_CURSORS).map(([id, spec]) => [id, { spec }]),
  ),
  requests: [],
  seq: 0,
}));

// ─── Resolution (CSS-value building, cached) ────────────────────────────────

const urlCache = new Map<string, string>();

function imageToUrl(image: string): string {
  const cached = urlCache.get(image);
  if (cached) return cached;
  const s = image.trim();
  // Inline SVG → a UTF-8 data URL (no base64; encodeURIComponent keeps it small
  // and avoids btoa's unicode pitfalls). Anything else is already a URL.
  const url = s.startsWith("<svg")
    ? `data:image/svg+xml,${encodeURIComponent(s)}`
    : s;
  urlCache.set(image, url);
  return url;
}

function specToCss(spec: CursorSpec): string {
  if ("css" in spec) return spec.css;
  const { image, hotspotX = 0, hotspotY = 0, fallback = "auto" } = spec;
  return `url("${imageToUrl(image)}") ${hotspotX} ${hotspotY}, ${fallback}`;
}

/** Normalise a public CursorContribution into a CursorSpec, preferring `css`. */
export function contributionToSpec(c: CursorContribution): CursorSpec {
  if (c.css != null) return { css: c.css };
  if (c.image != null)
    return {
      image: c.image,
      hotspotX: c.hotspotX,
      hotspotY: c.hotspotY,
      fallback: c.fallback,
    };
  return { css: "default" };
}

/** Resolve a cursor to a CSS value. Accepts a registered token id (built-in or
 *  extension), an inline CursorSpec, or — if the string matches no token — a raw
 *  CSS cursor value (so callers can pass "crosshair" directly). Non-reactive;
 *  reads the latest registry. */
export function resolveCursorCss(input: string | CursorSpec): string {
  if (typeof input === "string") {
    const reg = useCursorStore.getState().cursors[input];
    return reg ? specToCss(reg.spec) : input;
  }
  return specToCss(input);
}

// ─── Registry (extension-facing) ────────────────────────────────────────────

export function registerCursor(extensionId: string, c: CursorContribution): void {
  useCursorStore.setState((s) => ({
    cursors: {
      ...s.cursors,
      [c.id]: { spec: contributionToSpec(c), extensionId },
    },
  }));
}

/** Drop every cursor a given extension registered, and any active canvas-cursor
 *  request it owns. Called from registry.unregisterExtension. */
export function clearExtensionCursors(extensionId: string): void {
  useCursorStore.setState((s) => ({
    cursors: Object.fromEntries(
      Object.entries(s.cursors).filter(([, v]) => v.extensionId !== extensionId),
    ),
    requests: s.requests.filter((r) => r.key !== extensionId),
  }));
}

// ─── Canvas-cursor request stack ────────────────────────────────────────────

/** Push (or, with null, clear) a canvas-cursor request under `key`. Re-calling
 *  with the same key replaces it. Returns a release fn that clears this request.
 *  Higher `priority` wins; equal priority resolves most-recent-wins. */
export function setCanvasCursor(
  key: string,
  cursor: string | CursorSpec | null,
  opts?: { priority?: number },
): () => void {
  const release = () =>
    useCursorStore.setState((s) => ({
      requests: s.requests.filter((r) => r.key !== key),
    }));
  if (cursor == null) {
    release();
    return release;
  }
  const spec: CursorSpec =
    typeof cursor === "string"
      ? useCursorStore.getState().cursors[cursor]?.spec ?? { css: cursor }
      : cursor;
  useCursorStore.setState((s) => ({
    seq: s.seq + 1,
    requests: [
      ...s.requests.filter((r) => r.key !== key),
      { key, spec, priority: opts?.priority ?? 10, seq: s.seq + 1 },
    ],
  }));
  return release;
}

function topRequest(reqs: CanvasCursorRequest[]): CanvasCursorRequest | null {
  let best: CanvasCursorRequest | null = null;
  for (const r of reqs) {
    if (
      !best ||
      r.priority > best.priority ||
      (r.priority === best.priority && r.seq > best.seq)
    )
      best = r;
  }
  return best;
}

/** Reactive: the resolved CSS for the highest-priority active canvas-cursor
 *  request, or null if none. The Develop canvas uses this as an override over
 *  its own base (hover/zoom) cursor. */
export function useCanvasCursor(): string | null {
  return useCursorStore((s) => {
    const top = topRequest(s.requests);
    return top ? specToCss(top.spec) : null;
  });
}
