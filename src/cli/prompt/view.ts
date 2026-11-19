// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the prompt editor hands the renderer each keypress. The editor
// (src/cli/prompt/*) owns the state and the meaning of every token; the
// renderer (src/cli/output/prompt-render.ts) owns how it looks. Both build
// against these shapes only.

import type { ValueInfo } from "../types";

export type TokenKind =
  | "verb"
  | "verb-unknown"
  | "photo"
  | "photo-missing"
  | "glob"
  | "key"
  | "operator"
  | "value"
  | "value-past"
  | "value-wrong"
  | "unit"
  | "option"
  | "quoted"
  | "plain";

/** A run of the typed line, `start` and `end` in UTF-16 units of `PromptView.line`. */
export interface Token { start: number; end: number; kind: TokenKind }

/** The one muted line under the prompt, about what the cursor is on. */
export type FooterView =
  | { kind: "hints" }
  | { kind: "verb"; usage: string; summary: string }
  | {
    kind: "photo"; name: string; rating: number; flag: "pick" | "reject" | "none"; step?: { at: number; of: number };
    /** The open photo a verb naming none acts on: "→ DSC_0412.NEF · @all for the 3 open". */
    target?: { open: number };
    /** On an empty line with a set open: "pgdn next". */
    paging?: boolean;
    /** On disk, not in the catalogue yet. */
    notImported?: boolean;
  }
  | {
    kind: "matches"; count: number;
    /** For `import` and `ls`, from the folder's disk listing: "412 photos here · 12 not imported · 2 files gone".
     *  `count` is then the photos on disk; `folder` is null for the prompt's own folder. */
    listing?: { folder: string | null; notImported: number; gone: number };
  }
  | { kind: "slider"; info: ValueInfo; now: number; next?: number }
  | { kind: "stops"; info: ValueInfo; limit: number }
  | { kind: "problem"; message: string; fix?: string }
  | { kind: "running"; label: string; startedAt: number }
  | { kind: "done"; message: string; ok: boolean };

export interface MenuItem { label: string; detail?: string; group?: string }
/** The tab menu under the line; at most `rows` items show, scrolled to keep `selected` in view. */
export interface MenuView { items: MenuItem[]; selected: number; rows: number }

/** A picker opened after enter on a line missing a photo, a key or a choice. */
export interface PickerView {
  title: string;
  query: string;
  items: MenuItem[];
  selected: number;
  rows: number;
  /** Shown when `items` is empty. */
  empty: string;
}

export interface PromptView {
  /** The project name at the left of the prompt, or null outside a project. */
  projectName: string | null;
  /** The prompt's folder inside the project, "/"-separated: `Iceland 2026/Day 2 ›`. Absent at the project's root. */
  folder?: string;
  /** The open photo, without its extension, and where it is in the set: `DSC_0412 2/3 ›`. */
  open?: { name: string; at: number; of: number };
  /** Safelight has the project open: the read-only pill before `›`. */
  readOnly?: boolean;
  line: string;
  /** Cursor position in `line`, UTF-16 units. */
  cursor: number;
  tokens: Token[];
  /** Faint text after the cursor, or null. */
  ghost: string | null;
  footer: FooterView;
  menu: MenuView | null;
  picker: PickerView | null;
}

/** The rendered live area: the rows to paint below where the prompt starts, and where the cursor goes. */
export interface PromptFrame { rows: string[]; cursorRow: number; cursorCol: number }
