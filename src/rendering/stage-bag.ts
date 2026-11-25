// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams, Mask } from "@/catalog/types";
import { effectivePipelineId, resolvePipelineFor } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { variantTextureKey } from "./webgl/stage-texture-variant";
import { bagForRender } from "@/extensions/transform-derive";
import { denoiseBag } from "./webgl/builtin-denoise";
import { simpleHash } from "./webgl/hash";
import { maskComponentKind, maskComponentKinds, maskRasterChannels, type RegisteredMaskComponentKind } from "./mask-component-kinds";

/** The stage bag a frame of `params` draws with: `paramBag`, the photo's own stage
 *  entries, under the entries Safelight's built-in stages take from `params` (the
 *  Detail panel's noise reduction). Every render of an edit draws with it: the live
 *  Develop view (with its bypassed panels taken out first), the edited grid
 *  thumbnail, `api.develop.renderPhotoFrame`, export and the Library histogram. The
 *  render bridge adds the display transform's derived uniforms to a bag it is
 *  handed; a renderer in the window takes windowFrameBag. */
export function frameStageBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
  photoId?: string,
): Record<string, unknown> {
  return { ...photoVariants(params, photoId), ...maskRasterNames(params, photoId), ...paramBag, ...denoiseBag(params) };
}

/** Masking's raster of the extension mask components (#287), one channel each. */
export const MASK_RASTERS_KEY = "safelight.masks.coverage.uMaskRasters";

/** What a variant of MASK_RASTERS_KEY holds: the photo's extension components
 *  in channel order (maskRasterChannels), each with what its coverage is made
 *  from and whether the raster holds it inverted. */
export interface MaskRasterVariant {
  photoId: string;
  components: { id: string; type: string; values: Record<string, unknown>; invert: boolean }[];
}

// The variants named lately, by name, for the provider that makes them
// (render-bridge/mask-rasters.ts); the least recently named go first.
const MAX_NAMED_RASTERS = 256;
const rasterVariants = new Map<string, MaskRasterVariant>();
const namedFor = new WeakMap<
  readonly Mask[],
  { photoId: string; kinds: readonly RegisteredMaskComponentKind[]; name: string | null }
>();

function fileRaster(name: string, variant: MaskRasterVariant): void {
  rasterVariants.delete(name);
  rasterVariants.set(name, variant);
  if (rasterVariants.size > MAX_NAMED_RASTERS) rasterVariants.delete(rasterVariants.keys().next().value!);
}

/** What raster variant `name` holds, while it is among those named lately. */
export function maskRasterVariant(name: string): MaskRasterVariant | undefined {
  return rasterVariants.get(name);
}

function rasterOf(masks: readonly Mask[], photoId: string): MaskRasterVariant | null {
  const channels = maskRasterChannels(masks);
  const components: MaskRasterVariant["components"] = [];
  for (const mask of masks) {
    for (const c of mask.components) {
      if (!c.extension || (channels[c.id] ?? -1) < 0) continue;
      components.push({ id: c.id, type: c.extension.type, values: c.extension.values, invert: c.invert });
    }
  }
  return components.length > 0 ? { photoId, components } : null;
}

/** The variant of Masking's raster a frame of photo `photoId` draws: named by
 *  the photo, each extension component's kind, values and inversion in channel
 *  order, and each kind's generation, so new coverage is a new variant. None
 *  without extension components, or while Masking declares no raster. */
function maskRasterNames(params: DevelopParams, photoId: string | undefined): Record<string, string> {
  if (photoId === undefined || params.masks.length === 0) return {};
  const stage = useRegistry.getState().processingStages["safelight.masks.coverage"];
  if (!stage?.textures?.some((t) => `${stage.id}.${t.key}` === MASK_RASTERS_KEY)) return {};
  const kinds = maskComponentKinds();
  const known = namedFor.get(params.masks);
  if (known?.photoId === photoId && known.kinds === kinds) {
    if (known.name === null) return {};
    const variant = rasterVariants.get(known.name);
    if (variant) {
      fileRaster(known.name, variant);
      return { [MASK_RASTERS_KEY]: known.name };
    }
  }
  const raster = rasterOf(params.masks, photoId);
  let name: string | null = null;
  if (raster) {
    const text = JSON.stringify(
      raster.components.map((c) => [c.type, c.values, c.invert, maskComponentKind(c.type)?.generation ?? null]),
    );
    name = `${simpleHash(photoId)}-${simpleHash(text)}-${text.length.toString(36)}`;
    fileRaster(name, raster);
  }
  namedFor.set(params.masks, { photoId, kinds, name });
  return name ? { [MASK_RASTERS_KEY]: name } : {};
}

/** The variant each per-photo stage texture (TextureRequirement.perPhoto)
 *  draws for photo `photoId`: the one filed under its id. A stage that belongs
 *  to a transform the photo doesn't render with names none, so the frame never
 *  waits on its provider. */
function photoVariants(params: DevelopParams, photoId: string | undefined): Record<string, string> {
  const named: Record<string, string> = {};
  if (photoId === undefined) return named;
  const transform = effectivePipelineId(params.displayTransform);
  for (const stage of Object.values(useRegistry.getState().processingStages)) {
    if (stage.transform !== undefined && stage.transform !== transform) continue;
    for (const t of stage.textures ?? []) {
      const key = `${stage.id}.${t.key}`;
      if (t.perPhoto === true && variantTextureKey(key, photoId)) named[key] = photoId;
    }
  }
  return named;
}

/** frameStageBag with the derived uniforms of the display transform `params`
 *  picks (bagForRender), for a renderer in the window, which the render bridge
 *  doesn't feed. */
export function windowFrameBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
  photoId?: string,
): Record<string, unknown> {
  return bagForRender(resolvePipelineFor(params.displayTransform), frameStageBag(params, paramBag, photoId));
}
