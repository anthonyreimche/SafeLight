// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The RAW cache key of a catalogue photo, from its record alone (a cached decode
// is served while the original is offline). A photo in a folder is its path,
// size and turn. A library source's photo is its source key instead of its path:
// the cache folder is its catalogue's own, one per extension, source and
// library, so that key names the photo there, and follows it through an album
// move or a rename while a photo that takes a removed one's path never takes its
// decode. A relative path never starts with "/", so the two never meet. An
// extension's decoder ahead of libraw adds its chain's signature, so its decodes
// are kept apart from libraw's; the decoders' markers stay under the key
// without it (photoMarkerKey), each decoder's under its own id.

import type { CatalogPhoto } from "@/catalog/types";
import { chainSignature, decoderChain, formatOf, type ChainEntry } from "@/catalog/image-decoders";
import { DECODER_ID, decoderMarkerId, deleteCachedPreview, hasDecodeMarker, rawCacheKey } from "@/raw/raw-cache";

type KeyedPhoto = Pick<CatalogPhoto, "relPath" | "fileSize" | "rotation" | "sourceKey">;

function nameOf(photo: KeyedPhoto): string {
  return photo.sourceKey === undefined ? photo.relPath : `/source/${photo.sourceKey}`;
}

/** The decoders that read the photo's RAW, in the person's order; none for a
 *  photo that isn't a RAW. */
export function rawDecoders(photo: Pick<CatalogPhoto, "relPath">): readonly ChainEntry[] {
  const format = formatOf(photo.relPath);
  return format?.raw ? decoderChain(format.id) : [];
}

/** What reads the photo's RAW, for keys of its decodes: "" while libraw leads
 *  (image-decoders.ts chainSignature). */
export function rawSignature(photo: Pick<CatalogPhoto, "relPath">): string {
  const format = formatOf(photo.relPath);
  return format?.raw ? chainSignature(format.id) : "";
}

export function photoCacheKey(photo: KeyedPhoto): string {
  return rawCacheKey(nameOf(photo), photo.fileSize, photo.rotation ?? 0, rawSignature(photo));
}

/** The key the decoders' markers on the photo are kept under, whichever leads. */
export function photoMarkerKey(photo: KeyedPhoto): string {
  return rawCacheKey(nameOf(photo), photo.fileSize, photo.rotation ?? 0);
}

/** What a reimport or a removal drops of the photo's kept decodes: its cache
 *  entry under the chain it has now and under libraw's, and the markers of
 *  libraw and of every decoder that reads its format. */
export function photoDecodeKeys(photo: KeyedPhoto): { entries: string[]; decoders: string[] } {
  const signed = photoCacheKey(photo);
  const plain = photoMarkerKey(photo);
  const decoders = [...new Set([...rawDecoders(photo).map(decoderMarkerId), DECODER_ID])];
  return { entries: signed === plain ? [plain] : [signed, plain], decoders };
}

/** Whether every decoder that reads the photo's RAW has failed on it for good. */
export async function unsupportedByEvery(photo: KeyedPhoto): Promise<boolean> {
  const key = photoMarkerKey(photo);
  const decoders = rawDecoders(photo);
  if (decoders.length === 0) return hasDecodeMarker(key, "unsupported");
  const verdicts = await Promise.all(
    decoders.map((entry) => hasDecodeMarker(key, "unsupported", decoderMarkerId(entry))),
  );
  return verdicts.every(Boolean);
}

/** Drop the photo's kept decodes and every decoder's verdict on it. */
export async function deletePhotoDecodes(photo: KeyedPhoto): Promise<void> {
  const { entries, decoders } = photoDecodeKeys(photo);
  const plain = photoMarkerKey(photo);
  await Promise.all(entries.map((key) => deleteCachedPreview(key, key === plain ? decoders : [])));
}
