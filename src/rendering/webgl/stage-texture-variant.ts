// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Variants of a "lut" or "dynamic" stage texture: data supplied under one name
// each (api.setStageTexture's `variant`), of which a photo's param bag picks one
// by holding its name under the texture's own key "{stageId}.{key}". Every
// renderer holds every variant, so a live view, a thumbnail and an export each
// draw the variant their own photo names. A name the renderer holds no data
// for draws as a texture with none yet: opaque black.

const VARIANT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** Where variant `name` of stage texture `qualifiedKey` is filed, or null for
 *  a name that isn't 1 to 64 letters, digits, `-` or `_`. */
export function variantTextureKey(qualifiedKey: string, name: string): string | null {
  return VARIANT_NAME.test(name) ? `${qualifiedKey}#${name}` : null;
}

/** The key whose data stage texture `qualifiedKey` draws with for a frame of
 *  `bag`: the variant the bag names, else the plain texture. */
export function boundStageTextureKey(qualifiedKey: string, bag: Readonly<Record<string, unknown>>): string {
  const named = bag[qualifiedKey];
  return (typeof named === "string" && variantTextureKey(qualifiedKey, named)) || qualifiedKey;
}
