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
