// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Everything `safelight` shows goes through Output: pure builders that return text,
// plus thin writers. Commands never format text themselves. index.ts holds
// resolveOutputOptions and createOutput.

import type { ValueInfo, Trust, GraphicsMode, HelpGroup } from "../types";
import type { Capabilities } from "./capabilities";

export interface OutputOptions {
  /** Resolved: stdout/stderr TTY, NO_COLOR unset, TERM != "dumb", or FORCE_COLOR set. */
  colour: { stdout: boolean; stderr: boolean };
  unicode: boolean;         // false on legacy consoles: "..." for "…", "*" for "✱"
  width: number;            // terminal columns, 80 when unknown
  /** 24-bit colour reaches the screen. Unset means 256 colours, which every colour terminal has. */
  trueColour?: boolean;
  verbosity: "quiet" | "normal" | "verbose" | "debug";
  /**
   * What the terminal can take. A stream it marks `rich` gets the designed
   * look; without it, or on a stream that isn't one, output is the plain text.
   */
  caps?: Capabilities;
}

/** `fix` is a line the user can run to put it right; a terminal shows it as the card's last row. */
export interface Problem { message: string; hint?: string; fix?: string }

export interface ToolRow { tool: string; state?: "in use" | "idle" | "not installed" | "off"; values: ValueRow[] }
export interface ValueRow { info: ValueInfo; value: unknown; changed: boolean; note?: string }
/** How a file on disk stands with the catalogue. A row without a state is an imported photo. */
export type PhotoState = "imported" | "new" | "removed" | "missing";
export interface PhotoRow { name: string; rating: number; flag: "pick" | "reject" | "none"; label: string; edited: boolean; size?: string; state?: PhotoState }
/** A folder in `ls`; its counts are for its whole subtree. */
export interface FolderRow { name: string; photos: number; edited: number; notImported: number }
/** A folder in `ls --tree`; `path` is what the plain list prints. */
export interface FolderNode extends FolderRow { path: string; children: readonly FolderNode[] }
/** The line over a listing: where it is, and what is there. */
export interface ListingSummary { title: string; photos: number; edited: number; notImported: number; otherFiles?: number }
export interface Listing {
  summary: ListingSummary;
  folders: readonly FolderRow[];
  photos: readonly PhotoRow[];
  /** A last line that says what to run next: the command in prompt colours, then what it does. */
  fix?: { command: string; does: string };
}
export interface KeywordRow { keyword: string; count: number }
export interface PhotoKeywords { photo: string; keywords: readonly string[] }
/** What `forget` is about to drop for good, for its refusal and for the card a question sits under. */
export interface ForgetRisk { photos: number; edited: readonly string[]; /** The line that goes ahead, such as "forget *.NEF --yes". */ command?: string }
export interface ExtensionRow { name: string; id: string; version: string; enabled: boolean | null; trust: Trust; update?: string; description?: string }
export interface SearchRow { installName: string; name: string; version: string; category: string; trust: Trust; description?: string }
export interface HistoryRow { index: number; label: string; timestamp: number; current: boolean }
/** One changed value; `info`, `before` and `after` let a result draw the slider moving. */
export interface ResultChange { label: string; value: string; info?: ValueInfo; before?: unknown; after?: unknown; clamped?: boolean }
export interface ResultLine { photo: string; changes: ResultChange[]; step?: number; note?: string }
export interface BatchSummary { photos: number; stepEach: boolean; failed: number; skipped: number }
export interface PhotoHeader {
  name: string; camera?: string; megapixels?: number; edited: boolean; processVersion: number;
  /** Shown on a terminal when given: the step the photo is on, and its rating, flag and label. */
  step?: { at: number; of: number };
  rating?: number;
  flag?: "pick" | "reject" | "none";
  label?: string;
}
/** How `toolTable` lays out on a terminal. */
export interface ToolView {
  /** Lists values at their defaults too; without it a terminal folds them into one line a tool. */
  all?: boolean;
  /** The photo as lines of text (half blocks), set to the right of the values at 96 columns and wider. */
  picture?: readonly string[];
}
/** One cell of the contact sheet; `picture` is the thumbnail as lines of half blocks, when there is one. */
export interface GridCell extends PhotoRow { picture?: GridPicture }
/** A JPEG that iTerm2 draws itself, in a box `rows` cells tall. */
export interface ItermPicture { jpeg: Uint8Array; rows: number }
export type GridPicture = readonly string[] | ItermPicture;
export interface PreviewCaption { mode: GraphicsMode; trueColour: boolean; width: number; height: number; ms?: number }
export type ProgressItemState = "waiting" | "working" | "done" | "failed";
export interface ProgressItem { name: string; state: ProgressItemState; ms?: number; bytes?: number; error?: string }
export interface ProgressState {
  label: string;
  done: number;
  total: number;
  /** Per photo (export) or per extension (install, update), in order. */
  items?: ProgressItem[];
  /** Where the files go (export). */
  folder?: string;
  /** Downloads: bytes so far and in all, when known. */
  bytes?: { done: number; total: number | null };
  startedAt?: number;
}
export interface HelpVerb { verb: string; group: HelpGroup; summary: string }
export interface HelpScreen { version: string; verbs: HelpVerb[] }
export interface VerbHelp { verb: string; usage: string; summary: string; options: { flag: string; summary: string }[]; examples: string[] }
export interface DoctorItem { label: string; value: string; status: "ok" | "warn" | "fail" | "info"; hint?: string }
export interface ExportedLine { path: string; width: number; height: number; colourSpace: string; bytes: number }
/** How an export ended. `folder`, `bytes` and `ms` are shown on a terminal when given. */
export interface ExportSummary { exported: number; failed: readonly { name: string; error: string }[]; folder?: string; bytes?: number; ms?: number }

/** What an import is about to do, said before its first file. */
export interface ImportPlan {
  project: string;
  newFiles: number;
  gone?: number;
  /** Set when this import starts the catalogue: where it lives, and whether that is outside the folder. */
  started?: { workingDir: string; external: boolean };
  /** `import --dry-run`: the plan is what would happen, and nothing was changed. */
  dryRun?: boolean;
}
export interface ImportedFile { path: string; state: "ok" | "no-preview" | "failed"; error?: string }
/** Where an import is. Files first, each named while it is read; then the camera data of the RAWs. */
export type ImportProgress =
  | { phase: "files"; done: number; total: number; reading: readonly string[]; startedAt: number }
  | { phase: "camera-data"; done: number; total: number; startedAt: number };
export interface ImportSummary {
  project: string;
  imported: number;
  /** Files in scope, for "after 137 of 412" when it stopped early. */
  total: number;
  ms?: number;
  failed: readonly string[];
  moved: readonly { from: string; to: string }[];
  dropped: readonly { relPath: string; edited?: boolean }[];
  /** Photos whose camera data is still to read. */
  pending: number;
  stopped: null | "interrupted" | "safelight-opened";
}
/** One of doctor's checks; a terminal shows `label` beside a lamp until `run` settles. */
export interface DoctorCheck { label: string; run(): Promise<DoctorItem | readonly DoctorItem[]> }

export interface Output {
  readonly options: OutputOptions;
  // pure: return text, write nothing
  formatValue(info: ValueInfo, value: unknown): string;          // "+0.70 EV", "5600 K", "on"
  formatRange(info: ValueInfo): string;                          // "−5…5", "2000…50000"
  photoHeader(h: PhotoHeader): string;
  toolTable(rows: ToolRow[], view?: ToolView): string;
  photoTable(rows: PhotoRow[]): string;
  extensionTable(rows: ExtensionRow[]): string;
  searchTable(rows: SearchRow[]): string;
  /** `photo` names the photo in the timeline's first and last lines on a terminal. */
  historyList(rows: HistoryRow[], photo?: string): string;
  resultLine(r: ResultLine): string;
  summary(s: BatchSummary): string;
  exported(e: ExportedLine): string;
  help(s: HelpScreen): string;
  verbHelp(v: VerbHelp): string;
  doctor(items: DoctorItem[]): string;
  /** `ls`: the summary, folders, then photos with their state. Off a terminal, one tab-separated line an entry. */
  listing(l: Listing): string;
  /** `ls --tree`: folders only, nested. Off a terminal, the same folder lines as `listing`, flat. */
  folderTree(root: FolderNode, summary: ListingSummary, depth?: number): string;
  /** The project's keywords with how many photos carry each. */
  keywordTable(rows: KeywordRow[]): string;
  /** Each photo's own keywords. */
  keywordList(rows: PhotoKeywords[]): string;
  exportSummary(s: ExportSummary): string;
  importPlan(p: ImportPlan): string;
  importedFile(f: ImportedFile): string;
  importSummary(s: ImportSummary): string;
  /** Why `forget` stopped: some of the photos have edits, and it wasn't told --yes. For `error`. */
  forgetProblem(risk: ForgetRisk): Problem;
  previewCaption(c: PreviewCaption): string;
  problem(kind: "error" | "warning", p: Problem): string;        // "safelight: …\n           hint"
  progressText(p: ProgressState): string;
  // writers
  print(text: string): void;                                     // stdout, adds "\n"; silent when quiet
  json(doc: unknown): void;                                      // stdout, one document
  warn(p: Problem): void;                                        // stderr unless quiet
  error(p: Problem): void;                                       // stderr always
  info(text: string): void;                                      // stderr, verbose only
  progress(p: ProgressState | null): void;                       // stderr TTY only, \r line; null clears
  writeRaw(bytes: Uint8Array): void;                             // stdout, for images
  /**
   * stdout: one finished row of a long job (`exported`, `importedFile`). On a terminal, once the job in
   * `progress` has more than 30 items, only the last five stay on screen, in the live region, unless -v.
   */
  finished(row: string): void;
  /** Shows where an import is; null clears, as `progress` does. */
  importProgress(p: ImportProgress | null): void;
  /**
   * stdout: runs doctor's checks in order and prints the checklist. On a terminal each row is a lamp
   * until its check settles. Resolves with every item, for the exit code and --json.
   */
  checklist(checks: readonly DoctorCheck[]): Promise<DoctorItem[]>;
  /** stdout: one photo's result; on a terminal it may animate its bars from before to after. */
  result(r: ResultLine): void;
  /** stderr: a working lamp while `task` runs longer than 150 ms; resolves with it. */
  working<T>(label: string, task: Promise<T>): Promise<T>;
}

export interface HomeStatus {
  version: string;
  cwd: string;
  /** The project holding cwd, if any. */
  project: { root: string; name: string; photos: number; edited: number; picks?: number } | null;
  /** Safelight has that project open, so writes will be refused. */
  guiHasProjectOpen: boolean;
  /** GPU backend from the app, e.g. "d3d11"; null = not known yet. */
  graphics: string | null;
  /** The app has written its settings file. */
  settingsShared: boolean;
  /** updates null = not checked. */
  extensions: { installed: number; updates: number | null };
}
/** Where the prompt is, beyond its project: said in the prompt line itself. */
export interface PromptPlace {
  /** The folder inside the project, from its root, such as "Day 2"; unset at the root. */
  folder?: string;
  /** The working set: the current photo's name and its place among the photos open, or with no name, just how many. */
  open?: { name?: string; at?: number; of: number };
  /** Safelight has the project open, so writes will be refused. */
  readOnly?: boolean;
}
export interface PromptState extends PromptPlace { projectName: string | null; /** A command is running. */ busy?: boolean }
export type ReplNoteKind = "interrupt" | "bye" | "cancelled" | "unknown";

export interface OutputStreams { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }
