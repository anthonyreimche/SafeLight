// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The import pipeline's public surface. The work lives in import-decode (the
// decode chain), import-record (building a photo), import-passes (background
// passes over the catalog) and cache-pass (the develop-preview cache fill).

export { isSupportedName, buildPreviewBlob, importPhoto, buildPhoto } from "./import-record";
export {
  repairMissingPreviews,
  readPendingMetadata,
  settlePendingMetadata,
  settleSelectedPhoto,
  rebuildThumbnails,
  reimportPhotos,
} from "./import-passes";
export { EAGER_CACHE_LIMIT, preDecodeRawsForCache } from "./cache-pass";
