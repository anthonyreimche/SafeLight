// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Masking's raster of a photo's extension mask components (#287): core is the
// provider of its variants (stage-texture-providers.ts), which every frame of
// the photo names (stage-bag.ts). A variant asks each component's kind for its
// coverage, resamples each to one size and packs them a channel each, with
// the component's inversion in its channel, so a component whose coverage
// isn't there, or isn't held yet, never covers the photo. Once a photo's new
// variant is held its older ones go, bar those a frame still draws with. The
// live view keeps drawing the photo's last variant while the next is made, so
// a click that adds a seed doesn't blink the mask off.

import type { StageTextureData } from "@/extensions/types";
import { useRegistry } from "@/extensions/registry";
import { maskComponentKind, subscribeMaskComponentKinds, type MaskCoverageBitmap } from "../mask-component-kinds";
import { MASK_RASTERS_KEY, maskRasterVariant, type MaskRasterVariant } from "../stage-bag";
import {
  dropStageTextureVariants,
  holdsStageVariant,
  prepareStageVariant,
  setStageTextureProvider,
  stageTextureProviderOwner,
  stageVariantInUse,
} from "./stage-texture-providers";

/** The longest edge a mask raster is packed at. */
export const MASK_RASTER_MAX_EDGE = 2048;

const MASKS_STAGE_ID = "safelight.masks.coverage";

const usable = (b: MaskCoverageBitmap | null): b is MaskCoverageBitmap =>
  b !== null &&
  Number.isInteger(b.width) &&
  Number.isInteger(b.height) &&
  b.width > 0 &&
  b.height > 0 &&
  b.data instanceof Uint8Array &&
  b.data.length === b.width * b.height;

/** The size a raster of `bitmaps` is packed at: the largest one's, its long
 *  edge held to MASK_RASTER_MAX_EDGE, at least 2 px a side, so the program can
 *  tell it from core's 1×1 stand-in. */
function packedSize(bitmaps: readonly MaskCoverageBitmap[]): { width: number; height: number } {
  let largest: MaskCoverageBitmap | undefined;
  for (const b of bitmaps) if (!largest || Math.max(b.width, b.height) > Math.max(largest.width, largest.height)) largest = b;
  if (!largest) return { width: 2, height: 2 };
  const scale = Math.min(1, MASK_RASTER_MAX_EDGE / Math.max(largest.width, largest.height));
  return {
    width: Math.max(2, Math.round(largest.width * scale)),
    height: Math.max(2, Math.round(largest.height * scale)),
  };
}

/** Writes `b`, sampled bilinearly at width×height texel centres, into channel
 *  `channel` of `out` (`stride` bytes a texel), inverted when asked. */
function writeChannel(
  b: MaskCoverageBitmap,
  invert: boolean,
  out: Uint8Array,
  stride: number,
  channel: number,
  width: number,
  height: number,
): void {
  const flip = (v: number) => (invert ? 255 - v : v);
  if (b.width === width && b.height === height) {
    for (let i = 0; i < width * height; i++) out[i * stride + channel] = flip(b.data[i]);
    return;
  }
  const sx = b.width / width;
  const sy = b.height / height;
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), b.height - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, b.height - 1);
    const ty = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), b.width - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, b.width - 1);
      const tx = fx - x0;
      const top = b.data[y0 * b.width + x0] * (1 - tx) + b.data[y0 * b.width + x1] * tx;
      const bottom = b.data[y1 * b.width + x0] * (1 - tx) + b.data[y1 * b.width + x1] * tx;
      out[(y * width + x) * stride + channel] = flip(Math.round(top * (1 - ty) + bottom * ty));
    }
  }
}

/** The raster of `bitmaps`, one channel each in order (r8 for one, rgba8 for
 *  two to four), each resampled to the largest one's size (packedSize) and
 *  inverted where `inverts` says. A missing or malformed bitmap is a channel of
 *  zeros, inverted or not. Row 0 is source v 0, as each bitmap's. */
export function packMaskRasters(
  bitmaps: readonly (MaskCoverageBitmap | null)[],
  inverts: readonly boolean[],
): StageTextureData {
  const held = bitmaps.map((b) => (usable(b) ? b : null));
  const { width, height } = packedSize(held.filter((b) => b !== null));
  const single = bitmaps.length <= 1;
  const stride = single ? 1 : 4;
  const data = new Uint8Array(width * height * stride);
  held.forEach((b, channel) => {
    if (b) writeChannel(b, inverts[channel] === true, data, stride, channel, width, height);
  });
  return { data, width, height, format: single ? "r8" : "rgba8", version: 0 };
}

// The variants made for each photo, oldest first, so older ones can go once a
// newer is held.
const MAX_MADE = 256;
const madeFor = new Map<string, string>();

function dropSuperseded(photoId: string, newest: string): void {
  if (!holdsStageVariant(MASK_RASTERS_KEY, newest)) return;
  for (const [name, photo] of [...madeFor]) {
    if (name === newest) return;
    if (photo !== photoId || stageVariantInUse(MASK_RASTERS_KEY, name)) continue;
    madeFor.delete(name);
    dropStageTextureVariants(MASK_RASTERS_KEY, name);
  }
}

async function provide(variant: string, signal: AbortSignal): Promise<StageTextureData | null> {
  const raster = maskRasterVariant(variant);
  if (!raster) return null;
  const bitmaps = await Promise.all(
    raster.components.map((c) => {
      const kind = maskComponentKind(c.type);
      if (!kind) return Promise.resolve(null);
      return kind.coverage({ photoId: raster.photoId, componentId: c.id, values: c.values, signal });
    }),
  );
  if (signal.aborted) return null;
  madeFor.delete(variant);
  madeFor.set(variant, raster.photoId);
  if (madeFor.size > MAX_MADE) madeFor.delete(madeFor.keys().next().value!);
  setTimeout(() => dropSuperseded(raster.photoId, variant), 0);
  return packMaskRasters(
    bitmaps,
    raster.components.map((c) => c.invert),
  );
}

let revision = 0;
const listeners = new Set<() => void>();

function changed(): void {
  revision++;
  for (const listener of listeners) listener();
}

/** Bumped whenever the variant the live view should name may have changed: a
 *  kind came, went or has new coverage, or a variant it waited for landed. */
export function maskRastersRevision(): number {
  return revision;
}

/** Call `listener` on each maskRastersRevision bump; returns the way to stop. */
export function subscribeMaskRasters(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The variant the live view last drew for each photo, and those it is waiting
// for or couldn't have.
const shown = new Map<string, string>();
const pending = new Set<string>();
const failed = new Set<string>();

const sameLayout = (a: MaskRasterVariant | undefined, b: MaskRasterVariant): boolean =>
  a !== undefined &&
  a.photoId === b.photoId &&
  a.components.length === b.components.length &&
  a.components.every((c, i) => c.id === b.components[i].id);

function want(variant: string): void {
  if (pending.has(variant)) return;
  pending.add(variant);
  prepareStageVariant(MASK_RASTERS_KEY, variant)
    .catch((e: unknown) => {
      failed.add(variant);
      console.warn(`[render] ${e instanceof Error ? e.message : String(e)}`);
    })
    .finally(() => {
      pending.delete(variant);
      changed();
    });
}

/** The live view's `bag`, drawing the photo's last mask raster in place of
 *  the one it names while that one is made, when both hold the same components
 *  in the same channels. */
export function liveMaskRasterBag(bag: Record<string, unknown>): Record<string, unknown> {
  const wanted = bag[MASK_RASTERS_KEY];
  if (typeof wanted !== "string" || stageTextureProviderOwner(MASK_RASTERS_KEY) === undefined) return bag;
  const raster = maskRasterVariant(wanted);
  if (!raster) return bag;
  if (holdsStageVariant(MASK_RASTERS_KEY, wanted) || failed.has(wanted)) {
    shown.set(raster.photoId, wanted);
    return bag;
  }
  want(wanted);
  const last = shown.get(raster.photoId);
  if (last === undefined || last === wanted || !holdsStageVariant(MASK_RASTERS_KEY, last)) return bag;
  return sameLayout(maskRasterVariant(last), raster) ? { ...bag, [MASK_RASTERS_KEY]: last } : bag;
}

/** `bag` without the mask raster it names: a frame read ahead of the masks
 *  (a mask capture) doesn't wait for it, which may wait for that very frame. */
export function withoutMaskRasters(bag: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(bag, MASK_RASTERS_KEY)) return bag;
  const rest = { ...bag };
  delete rest[MASK_RASTERS_KEY];
  return rest;
}

/** Core provides the raster while Masking declares it, under Masking's name,
 *  whose texture budget it takes. */
function syncProvider(): void {
  const stage = useRegistry.getState().processingStages[MASKS_STAGE_ID];
  const declares = stage?.textures?.some((t) => `${stage.id}.${t.key}` === MASK_RASTERS_KEY) === true;
  const owner = declares ? stage.extensionId : undefined;
  if (stageTextureProviderOwner(MASK_RASTERS_KEY) === owner) return;
  if (owner === undefined) setStageTextureProvider(MASK_RASTERS_KEY, "", null);
  else setStageTextureProvider(MASK_RASTERS_KEY, owner, provide);
  shown.clear();
  failed.clear();
  madeFor.clear();
  changed();
}

let started = false;

/** Follow Masking and the mask component kinds from now on. */
export function startMaskRasters(): void {
  if (started) return;
  started = true;
  useRegistry.subscribe((s, prev) => {
    if (s.processingStages !== prev.processingStages) syncProvider();
  });
  subscribeMaskComponentKinds(() => {
    failed.clear();
    changed();
  });
  syncProvider();
}
