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
// without it (photoMarkerKey), each decoder's under its own id. A decoder that
// checks files first and declined the photo's is left out of its chain, so the
// photo keeps the keys libraw alone gives it; what such a decoder answered is
// kept beside the photo's markers (recallDecoderVerdicts, settleDecoderVerdicts).

import type { CatalogPhoto } from "@/catalog/types";
import {
  acceptsVerdict,
  answeringChain,
  askAccepts,
  decoderChain,
  formatOf,
  isExtensionEntry,
  rememberAccepts,
  signatureOf,
  type ChainEntry,
  type ExtensionChainEntry,
} from "@/catalog/image-decoders";
import {
  DECODER_ID,
  decoderMarkerId,
  deleteCachedPreview,
  hasDecodeMarker,
  rawCacheKey,
  readDecoderVerdict,
  writeDecoderVerdict,
} from "@/raw/raw-cache";

type KeyedPhoto = Pick<CatalogPhoto, "relPath" | "fileSize" | "rotation" | "sourceKey">;
type FilePhoto = Pick<CatalogPhoto, "relPath" | "fileSize">;

function nameOf(photo: KeyedPhoto): string {
  return photo.sourceKey === undefined ? photo.relPath : `/source/${photo.sourceKey}`;
}

/** The decoders that read the photo's RAW, in the person's order, without
 *  those known to decline it; none for a photo that isn't a RAW. */
export function rawDecoders(photo: FilePhoto): readonly ChainEntry[] {
  const format = formatOf(photo.relPath);
  return format?.raw ? answeringChain(format.id, photo.relPath, photo.fileSize) : [];
}

/** What reads the photo's RAW, for keys of its decodes: "" while libraw leads
 *  (image-decoders.ts chainSignature), or once every decoder ahead of it has
 *  declined the photo. */
export function rawSignature(photo: FilePhoto): string {
  return signatureOf(rawDecoders(photo));
}

/** The decoders ahead of libraw that check files first and haven't answered
 *  for the photo this session. */
function unasked(photo: FilePhoto): ExtensionChainEntry[] {
  const format = formatOf(photo.relPath);
  if (!format?.raw) return [];
  const chain = decoderChain(format.id);
  const ahead = chain.slice(0, Math.max(0, chain.findIndex((entry) => entry.owner === "core")));
  return ahead
    .filter(isExtensionEntry)
    .filter((entry) => acceptsVerdict(entry, photo.relPath, photo.fileSize) === undefined);
}

/** Recall what the photo's leading decoders that check files first answered
 *  in earlier sessions, kept beside its markers, so its keys follow them
 *  without reading the original; null, at once, when there is nothing to
 *  recall (no such decoder leads, or each has answered this session), so a
 *  load without one waits on nothing. */
export function recallDecoderVerdicts(photo: KeyedPhoto): Promise<void> | null {
  const entries = unasked(photo);
  if (entries.length === 0) return null;
  const key = photoMarkerKey(photo);
  return Promise.all(
    entries.map(async (entry) => {
      const accepts = await readDecoderVerdict(key, decoderMarkerId(entry));
      if (accepts !== undefined) rememberAccepts(entry, photo.relPath, photo.fileSize, accepts);
    }),
  ).then(() => {});
}

/** Ask the photo's leading decoders that check files first about `file`, its
 *  original, and keep each answer beside its markers for later sessions
 *  (`generation`: the cache's when the work began). Whether the photo's cache
 *  key changed, as it does when one declines it; null, at once, when there is
 *  nobody to ask. */
export function settleDecoderVerdicts(photo: KeyedPhoto, file: Blob, generation: number): Promise<boolean> | null {
  const entries = unasked(photo);
  if (entries.length === 0) return null;
  const before = photoCacheKey(photo);
  const key = photoMarkerKey(photo);
  return Promise.all(
    entries.map(async (entry) => {
      const accepts = await askAccepts(entry, file, photo.relPath);
      if (acceptsVerdict(entry, photo.relPath, photo.fileSize) === undefined) return;
      await writeDecoderVerdict(key, decoderMarkerId(entry), accepts, generation);
    }),
  ).then(() => photoCacheKey(photo) !== before);
}

export function photoCacheKey(photo: KeyedPhoto): string {
  return rawCacheKey(nameOf(photo), photo.fileSize, photo.rotation ?? 0, rawSignature(photo));
}

/** The key the decoders' markers on the photo are kept under, whichever leads. */
export function photoMarkerKey(photo: KeyedPhoto): string {
  return rawCacheKey(nameOf(photo), photo.fileSize, photo.rotation ?? 0);
}

/** What a reimport or a removal drops of the photo's kept decodes: its cache
 *  entry under the chain it has now, under its format's whole chain and under
 *  libraw's, and the markers and answers of libraw and of every decoder that
 *  reads its format. */
export function photoDecodeKeys(photo: KeyedPhoto): { entries: string[]; decoders: string[] } {
  const format = formatOf(photo.relPath);
  const whole = format?.raw ? decoderChain(format.id) : [];
  const chained = rawCacheKey(nameOf(photo), photo.fileSize, photo.rotation ?? 0, signatureOf(whole));
  const entries = [...new Set([photoCacheKey(photo), chained, photoMarkerKey(photo)])];
  const decoders = [...new Set([...whole.map(decoderMarkerId), DECODER_ID])];
  return { entries, decoders };
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
