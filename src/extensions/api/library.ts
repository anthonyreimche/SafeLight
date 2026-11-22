// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of api.catalog, api.project and api.presets that aren't catalogue
// records themselves.

import type { MouseEvent, ReactNode } from "react";
import type { DevelopParams } from "@/catalog/types";

export type RenamePhotoResult =
  | { ok: true; filename: string }
  | { ok: false; reason: string };

/** The Library's photo right-click menu, for a surface that lists photos. */
export interface PhotoActions {
  /** Right-click handler for a photo cell. Right-clicking a photo that's part
   *  of the current selection targets the whole selection; right-clicking an
   *  unselected one selects just it first. */
  onContextMenu: (id: string, e: MouseEvent) => void;
  /** The menu and its dialogues. Render them inside the surface. */
  overlays: ReactNode;
}

export interface CullingShortcutOptions {
  /** Handle the thumbnail-size actions (- / =), which step the Library grid's
   *  cell size. Surfaces whose cells are sized by their container (a filmstrip
   *  follows its rail) pass false and leave the keys alone. Default true. */
  sizeSteps?: boolean;
}

/** One line of a preset's summary. */
export interface PresetDiff {
  label: string;
  value: string;
}

/** One selectable adjustment in the Save Preset dialogue. `keys` are the
 *  DevelopParams keys copied when the field is checked; `changed` marks fields
 *  that differ from the defaults (pre-checked by default). */
export interface PresetField {
  id: string;
  label: string;
  keys: (keyof DevelopParams)[];
  changed: boolean;
  /** Short current value, shown beside scalar fields. */
  value?: string;
  /** Qualified paramBag keys copied when checked (extension-stage fields and
   *  the Display transform field; core fields copy `keys` instead). */
  bagKeys?: string[];
  /** The Display transform field's defaults for `bagKeys`, copied in place of
   *  a key the bag holds no value for. */
  bagDefaults?: Record<string, unknown>;
  /** "global" (default) is offered and pre-checked when changed; "per-image" is
   *  hidden under "Show all" and never pre-selected — spatial edits (crop,
   *  retouch, warp …) that don't transfer meaningfully to another photo. */
  scope?: "global" | "per-image";
  /** Set on extension-contributed stage fields (drives the "per-image" tag). */
  extension?: boolean;
}

export interface ImportedPreset {
  name: string;
  group?: string;
  params: Partial<DevelopParams>;
  paramBag?: Record<string, unknown>;
}

export type PresetImportOutcome =
  | { status: "imported"; preset: ImportedPreset }
  /** No installed importer claims this file type. */
  | { status: "no-importer"; extension: string }
  /** An importer claimed the file but found no develop settings in it. */
  | { status: "no-settings" }
  /** An importer claimed the file but threw or ran out of time reading it. */
  | { status: "failed"; reason: string }
  /** A .json file that isn't a Safelight preset this build can read. */
  | { status: "unreadable" };

/** A folder an extension keeps across launches (`api.project.pickKeptDirectory`),
 *  opened again by its token: the folder, or why it can't be written into now.
 *  "gone": no folder at that path, or its drive or share isn't connected.
 *  "unwritable": the folder is there but may not be written into; on Windows
 *  only a folder that can't even be looked at shows here, and one whose
 *  permissions refuse writes is reported by its first write instead. "unknown": the token
 *  names no folder kept for this extension (forgotten, the extension
 *  uninstalled since, or, in the browser build, picked before the page was
 *  loaded). */
export type KeptDirectory =
  | { folder: FileSystemDirectoryHandle }
  | { problem: "gone" | "unwritable" | "unknown" };

/** What core asks of an image decoder (api.library.registerDecoder). */
export interface ImageDecodeRequest {
  /** The file's name, its extension included. */
  name: string;
  /** The long edge the caller needs, such as a grid thumbnail's. A hint: a
   *  decoder may answer at any size from this up to the full size. */
  targetEdge?: number;
  /** For a RAW format: core keeps this decode as the photo's source at native
   *  resolution, so an answer smaller than the frame is refused. */
  fullSize: boolean;
  /** For a RAW format, the white balance the photo is known to have been shot
   *  at (green at 1). Balance by these when given, and by the camera's own
   *  otherwise. */
  asShotMultipliers?: readonly [number, number, number];
  /** Work for a background pass (thumbnails, the cache) rather than a photo the
   *  person is waiting on. Interactive requests run first. */
  background: boolean;
  /** Aborted when core no longer needs the answer or the decode ran out of
   *  time. Stop work when it fires. */
  signal: AbortSignal;
}

/** A decoder's image: RGBA rows from the top, `width` × `height`, four values
 *  per pixel with the fourth ignored. `oriented` says the pixels already stand
 *  as the photo's EXIF orientation shows it; with false, core turns them. A
 *  HEIF image must be upright (its own rotation applied). The array must be
 *  whole (not a view into a larger buffer, or core copies it) and becomes
 *  core's: don't touch it after answering. */
export type DecodedImageResult =
  | {
      /** 8-bit sRGB, for a non-RAW format only. */
      kind: "rgba8";
      width: number;
      height: number;
      data: Uint8ClampedArray;
      oriented: boolean;
      /** The image's full size when this decode is reduced (to `targetEdge`). */
      sourceWidth?: number;
      sourceHeight?: number;
    }
  | {
      /** Linear light, Rec. 709 primaries at D65, nothing clipped: colour
       *  outside Rec. 709 as negative channels, highlights above 1 kept. For a
       *  non-RAW format the values are display-referred (1 is the file's
       *  white). For a RAW format this is the only kind accepted: the camera's
       *  black subtracted and its matrix applied, balanced at the as-shot
       *  multipliers, scaled so the least amplified channel saturates at 1,
       *  with no tone curve, gamma, auto-brightening or baseline exposure. */
      kind: "linear";
      width: number;
      height: number;
      data: Float32Array;
      oriented: boolean;
      /** RAW: the multipliers the image was balanced at, green at 1. */
      asShotMultipliers?: [number, number, number];
      /** RAW: the as-shot white balance in kelvin. */
      colorTemperature?: number;
      /** RAW: EV the sensor sat below the tagged ISO (Fujifilm DR modes),
       *  already made up for in `data`. */
      rawExposureBias?: number;
      /** The image's full size when this decode is reduced (to `targetEdge`). */
      sourceWidth?: number;
      sourceHeight?: number;
    };

/** A decoder an extension offers for formats Safelight already reads (see
 *  api.library.registerDecoder). */
export interface ImageDecoderContribution {
  /** Unique among your decoders. */
  id: string;
  /** Shown in Preferences ▸ File formats. */
  label: string;
  /** Change it when your decoder's output changes: decodes core keeps (the
   *  RAW cache) are filed under it, so a new version decodes afresh. Default
   *  "1". */
  version?: string;
  /** The file extensions it reads, such as [".heic", ".heif"] or [".cr3"]:
   *  only extensions Safelight already imports. */
  extensions: readonly string[];
  /** The image in `file`, or null when this decoder can't read it (the next
   *  decoder in the person's order is tried, and the file is remembered as one
   *  this version can't read). For a failure that may pass (a Worker that
   *  didn't start, a download that failed), throw an error with `transient:
   *  true` (TransientDecodeError): the next decoder is tried and nothing is
   *  remembered. Running out of memory (a RangeError) counts as transient too.
   *  Any other throw counts as null. */
  decode(file: Blob, request: ImageDecodeRequest): Promise<DecodedImageResult | null>;
  /** Optional, and cheap: whether this decoder reads `file`, for a decoder
   *  that reads only some of a format's files (pixel-shift DNGs among plain
   *  ones, say). Read a header, not the image. Core asks it before queueing a
   *  decode, outside the one-at-a-time queue, and remembers the answer for
   *  the file (its name and size) and this `version`; for a RAW photo, also
   *  across launches. A file it declines is passed to the next decoder as if
   *  this one weren't in the person's order: it never waits behind your
   *  decodes, and its kept decodes and failure marks stay exactly as without
   *  your decoder. Base the answer on the file's content alone. A throw, an
   *  answer later than 5 s (`signal` is then aborted) or one that isn't a
   *  boolean counts as true and isn't remembered. Without it, every file of
   *  your formats is yours to decode. Needs Safelight 3.2.7. */
  accepts?(file: Blob, request: ImageAcceptRequest): boolean | Promise<boolean>;
}

/** What core passes ImageDecoderContribution.accepts. */
export interface ImageAcceptRequest {
  /** The file's name, its extension included. */
  name: string;
  /** Aborted when the check has run past its 5 s. */
  signal: AbortSignal;
}

/** An error a decoder throws for a failure that may pass: core tries the next
 *  decoder now and the file again later, never remembering it as one the
 *  decoder can't read. Any error with `transient: true` counts the same, so an
 *  extension can make its own: `Object.assign(new Error(message), { transient:
 *  true })`. Needs Safelight 3.2.7. */
export interface TransientDecodeError extends Error {
  transient: true;
}

/** A decoder as Preferences lists it: core's or an extension's. */
export interface ImageDecoderInfo {
  /** Core's: "browser", "tiff", "netpbm", "heif", "libraw"; an extension's:
   *  "<extension id>/<id>". */
  id: string;
  label: string;
  /** "core", or the id of the extension that registered it. */
  owner: string;
  /** Ids of the formats it reads (see Preferences ▸ File formats). */
  formats: readonly string[];
}
