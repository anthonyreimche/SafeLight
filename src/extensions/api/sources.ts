// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of a library source (api.library.registerSource): photos kept
// somewhere other than a folder on disk, a photo server say, opened as a
// project the way a folder is (src/project/library-sources.ts).

import type { ExifData } from "@/catalog/types";

/** One photo of a source. `key` names it to the source and must stay the same
 *  from one listing to the next: the catalogue knows the photo, its ratings,
 *  edits and kept original by it, so they follow the photo to another folder
 *  or name. A key listed in two folders (a photo in two albums) is two photos
 *  in the catalogue, sharing one kept original. `name` is its file name,
 *  extension included, which decides how it is read: a name Safelight can't
 *  import is left out, as in a folder. */
export interface LibrarySourceItem {
  key: string;
  name: string;
  /** The original's size in bytes; leave it out when the source doesn't know.
   *  An original that arrives at another size is not kept. */
  size?: number;
  /** When the original last changed, ms since the epoch. */
  modified?: number;
  /** When the photo was taken, ms since the epoch: its capture date in the
   *  catalogue when `exif.dateTimeOriginal` gives none. */
  taken?: number;
  /** The upright frame's size in pixels, as the grid and the Info panel show it
   *  before the photo is opened. Without it the photo takes its preview's size
   *  when the grid first reads it, then its original's once that is decoded. */
  width?: number;
  height?: number;
  mimeType?: string;
  /** What the Info panel and the filters show before the original is read. Give
   *  `orientation` (the EXIF tag, 1 to 8) when the original carries one: the
   *  photo is turned upright by it. Fields of another type than ExifData's are
   *  left out, and so are the ones the RAW decode learns (colorTemperature,
   *  rawExposureBias, baselineExposure, baselineShadows, cameraMatchVersion). */
  exif?: ExifData;
  /** 0 to 5 stars, as the photo arrives in the catalogue. */
  rating?: number;
  keywords?: string[];
}

export interface LibrarySourceListing {
  folders?: LibrarySourceFolder[];
  items?: LibrarySourceItem[];
}

/** A folder of the source (an album). Its name is made into a plain folder
 *  name: separators become "-". Of folders sharing a name, the one with the
 *  lowest `key` keeps it and the others add part of their key, so each keeps
 *  its name whatever order the source lists them in; without keys they get
 *  " (2)", " (3)" in listing order. */
export interface LibrarySourceFolder extends LibrarySourceListing {
  name: string;
  /** Names the folder to the source, the same from one listing to the next. */
  key?: string;
}

export interface LibrarySourceContribution {
  /** Unique among every extension's sources. */
  id: string;
  /** The project's name, as the Folders tree's root row and the welcome
   *  screen show it. */
  name: string;
  /** Which library the source shows now (a server and an account, say). Each
   *  value has its own catalogue; registering again with another value closes
   *  the project if it is open on the old one. */
  library?: string;
  /** Everything the source holds, folders within folders. Called each time the
   *  project opens. When it fails (offline), the listing kept from the last
   *  open is shown instead and the person is told; with none, the open fails.
   *  Bounded at 2 minutes, and stopped through `signal` when the person opens
   *  something else first. */
  list(options: { signal: AbortSignal }): Promise<LibrarySourceListing>;
  /** A small upright preview of the photo, about `maxEdge` px on its long edge
   *  (a JPEG or WebP): what the grid shows. Read when the photo first comes into
   *  view in the grid, a few at a time, and kept; a read whose photo leaves view
   *  first is stopped through `signal`. */
  readPreview(item: LibrarySourceItem, options: { maxEdge: number; signal: AbortSignal }): Promise<Blob>;
  /** The photo's original file, byte for byte: read when the photo is opened
   *  in Develop or exported, then kept in the catalogue's own folder (within
   *  `keptOriginalsLimit`), so it is read only once. Bound it with a time limit that suits its size. Nothing
   *  else ever reads it (no background decode, no prefetch). */
  readOriginal(item: LibrarySourceItem, options: { signal: AbortSignal }): Promise<Blob>;
  /** The most bytes of originals the catalogue keeps (3.2.4). Past it the ones
   *  used longest ago are removed, never one in use (the photo open in Develop,
   *  photos being exported), and one removed is read again when it is next
   *  needed. Left out: 10 GB. `null`: no limit. */
  keptOriginalsLimit?: number | null;
}

/** A registered source, as api.library.useSources lists it. */
export interface LibrarySourceEntry {
  id: string;
  name: string;
  extensionId: string;
  /** Whether it is the project open now. */
  open: boolean;
}
