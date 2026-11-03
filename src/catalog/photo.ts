// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { DevelopParams } from "./develop-params";

export interface CatalogPhoto {
  id: string;
  filename: string;
  /** Path relative to the project root, e.g. "2024/trip/IMG_001.NEF". */
  relPath: string;
  /** Containing folder: dirname of relPath ("" = project root). */
  folder: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;
  colorLabel: ColorLabel;
  flag: FlagStatus;
  rotation: number; // baked-in display rotation, degrees CW (0/90/180/270)
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
  /** Set when the last decode attempt failed (no thumbnail). Human-readable
   *  reason for the grid's warning tooltip; cleared once a preview is built. */
  decodeError?: string;
  /** Set on a RAW imported from its camera preview alone: libraw has yet to read
   *  its frame size, as-shot white balance and exposure bias from the whole file
   *  (readPendingMetadata, in the background once the import is done). Until
   *  then width/height are the preview's. */
  metadataPending?: true;
  /** The editFingerprint of the edit the stored preview was rendered with.
   *  Undefined when the preview was built from the file, without any edit. The
   *  edit can change without a new preview (Paste Settings, Update processing,
   *  an extension), so Develop draws the preview first only while this matches
   *  the edit it opens with. */
  previewEdit?: string;
  /** The rotation the stored preview was made at; undefined means `rotation`. They
   *  can differ: a turn is stored before its preview, whose write can fail or be cut
   *  short by a quit. A preview made at another rotation is never shown: one is
   *  built from the file instead. */
  previewRotation?: number;
  /** Set on a *virtual copy* — a second catalogue record that shares another
   *  photo's source file but keeps its own id, edits and metadata. Holds the id
   *  of the master record (the one that owns the file on disk). A virtual copy
   *  has no disk file of its own, so the project scan re-attaches the master's
   *  live handles to it on open instead of dropping it (see project-storage).
   *  Copies of copies still point at the root master. Undefined on a master. */
  copyOf?: string;
  /** A virtual copy's user-facing distinguisher (e.g. "copy", "copy 2", or a
   *  name the user typed). `filename` still mirrors the master's real file; the
   *  displayed/exported name folds them together as `base_<copyName>.ext` (see
   *  catalog/copy-name.ts). Undefined on a master. */
  copyName?: string;
}

/** A grid preview as a loader returns it, with the edit it shows. `previewEdit` is
 *  the edit its record named when it was read from the stored copy; one without it,
 *  such as a preview built from the photo's source file, shows none. It rides on
 *  the Blob because the project's reader also hands its result on as a plain Blob. */
export type LoadedPreview = Blob & { readonly previewEdit?: string };

/** A photo record as catalog.json stores it. The live file handles, the preview
 *  blob and its object URL belong to the window holding the record. */
export type StoredPhoto = Omit<
  CatalogPhoto,
  "directoryHandle" | "fileHandle" | "thumbnailBlob" | "thumbnailUrl"
>;

export function storedPhoto(photo: CatalogPhoto): StoredPhoto {
  const {
    directoryHandle: _d,
    fileHandle: _f,
    thumbnailBlob: _b,
    thumbnailUrl: _u,
    ...stored
  } = photo;
  return stored;
}

/** The record `stored`, which another window wrote, with this window's own
 *  handles, preview blob and URL from `local`. A field the other window cleared
 *  by leaving it out is cleared here too. */
export function mergeStoredPhoto(local: CatalogPhoto, stored: StoredPhoto): CatalogPhoto {
  return {
    ...stored,
    directoryHandle: local.directoryHandle,
    fileHandle: local.fileHandle,
    thumbnailBlob: local.thumbnailBlob,
    thumbnailUrl: local.thumbnailUrl,
  };
}

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";
export type FlagStatus = "none" | "pick" | "reject";

export interface ExifData {
  cameraMake?: string;
  cameraModel?: string;
  bodySerial?: string;
  lens?: string;
  lensMake?: string;
  lensSerial?: string;
  focalLength?: number;
  focalLength35mm?: number;
  aperture?: number;
  maxAperture?: number;
  shutterSpeed?: string;
  iso?: number;
  exposureCompensation?: number;
  exposureProgram?: string;
  exposureMode?: string;
  meteringMode?: string;
  whiteBalance?: string;
  flash?: string;
  subjectDistance?: number; // metres
  sceneCaptureType?: string;
  colorSpace?: string;
  artist?: string;
  copyright?: string;
  software?: string;
  imageDescription?: string;
  dateTimeOriginal?: string;
  subSecTimeOriginal?: string; // fractional-second digits of dateTimeOriginal
  orientation?: number; // EXIF Orientation tag (1..8)
  colorTemperature?: number; // as-shot WB in Kelvin (from AsShotNeutral / libraw)
  rawExposureBias?: number;  // EV the sensor sat below the tagged ISO (Fujifilm DR modes); the decode compensates it
  // EV the camera baseline adds to a RAW to reach its camera's brightness,
  // learned from the embedded JPEG at its first decode (raw/camera-match.ts);
  // null when that preview gave no usable match, so the maker table applies.
  baselineExposure?: number | null;
  // The Shadows the camera baseline adds with it (0 to 100), learned in the same
  // match; null beside a null exposure. Undefined on a photo matched before the
  // lift was learned, which is matched again.
  baselineShadows?: number | null;
  // The camera match version (raw/camera-match.ts) the two above were learned
  // by; a photo matched by an older one is matched again.
  cameraMatchVersion?: number;
  gpsLatitude?: number;  // decimal degrees (positive = N, negative = S)
  gpsLongitude?: number; // decimal degrees (positive = E, negative = W)
  gpsAltitude?: number;  // metres above sea level
}

export interface EditState {
  photoId: string;
  stack: EditSnapshot[];
  currentIndex: number;
}

export interface EditSnapshot {
  timestamp: number;
  label: string;
  params: DevelopParams;
  /** Generic extension-contributed processing-stage params (e.g. denoise),
   *  keyed by qualified key "{stageId}.{key}". Optional so pre-existing stacks
   *  load unchanged; validated on load via normalizeParamBag. */
  paramBag?: Record<string, unknown>;
}

export type SortField = 'dateImported' | 'dateCreated' | 'filename' | 'rating';
export type SortDirection = 'asc' | 'desc';
export type ViewMode = 'grid' | 'list';
/** A top-level module id: "library", "develop", or one an extension registered
 *  through api.registerModule. */
export type ModuleId = 'library' | 'develop' | (string & {});
export type AppModule = ModuleId;
