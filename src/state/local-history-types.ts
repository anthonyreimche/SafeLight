// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes of an extension's local history (#281), as the extension API
// hands them out. Types only, so the API's types can import them.

/** One step an extension made. */
export interface LocalStep {
  /** The step's place in the photo's history (`useDevelopStore().history`). */
  index: number;
  label: string;
  timestamp: number;
}

export interface LocalHistory {
  /** The extension's id. */
  source: string;
  /** The extension's steps on the open photo, oldest first; those past
   *  `cursor` are its redo. */
  steps: LocalStep[];
  /** The step whose values the extension's settings show now, -1 before its first. */
  cursor: number;
}

export interface LocalHistoryView extends LocalHistory {
  /** The extension's name, or its id once it is gone. */
  name: string;
}

/** An extension with steps on the open photo. */
export interface HistorySource {
  id: string;
  name: string;
}
