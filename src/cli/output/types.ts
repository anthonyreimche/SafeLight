// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Everything `safelight` shows goes through Output: pure builders that return text,
// plus thin writers. Commands never format text themselves. index.ts holds
// resolveOutputOptions and createOutput.

import type { ValueInfo, Trust, GraphicsMode, HelpGroup } from "../types";

export interface OutputOptions {
  /** Resolved: stdout/stderr TTY, NO_COLOR unset, TERM != "dumb", or FORCE_COLOR set. */
  colour: { stdout: boolean; stderr: boolean };
  unicode: boolean;         // false on legacy consoles: "..." for "…", "*" for "✱"
  width: number;            // terminal columns, 80 when unknown
  /** 24-bit colour reaches the screen. Unset means 256 colours, which every colour terminal has. */
  trueColour?: boolean;
  verbosity: "quiet" | "normal" | "verbose" | "debug";
}

export interface Problem { message: string; hint?: string }

export interface ToolRow { tool: string; state?: "in use" | "idle" | "not installed" | "off"; values: ValueRow[] }
export interface ValueRow { info: ValueInfo; value: unknown; changed: boolean; note?: string }
export interface PhotoRow { name: string; rating: number; flag: "pick" | "reject" | "none"; label: string; edited: boolean; size?: string }
export interface ExtensionRow { name: string; id: string; version: string; enabled: boolean | null; trust: Trust; update?: string }
export interface SearchRow { installName: string; name: string; version: string; category: string; trust: Trust }
export interface HistoryRow { index: number; label: string; timestamp: number; current: boolean }
export interface ResultLine { photo: string; changes: { label: string; value: string }[]; step?: number; note?: string }
export interface BatchSummary { photos: number; stepEach: boolean; failed: number; skipped: number }
export interface PhotoHeader { name: string; camera?: string; megapixels?: number; edited: boolean; processVersion: number }
export interface PreviewCaption { mode: GraphicsMode; trueColour: boolean; width: number; height: number; ms?: number }
export interface ProgressState { label: string; done: number; total: number }
export interface HelpVerb { verb: string; group: HelpGroup; summary: string }
export interface HelpScreen { version: string; verbs: HelpVerb[] }
export interface VerbHelp { verb: string; usage: string; summary: string; options: { flag: string; summary: string }[]; examples: string[] }
export interface DoctorItem { label: string; value: string; status: "ok" | "warn" | "fail" | "info" }
export interface ExportedLine { path: string; width: number; height: number; colourSpace: string; bytes: number }

export interface Output {
  readonly options: OutputOptions;
  // pure: return text, write nothing
  formatValue(info: ValueInfo, value: unknown): string;          // "+0.70 EV", "5600 K", "on"
  formatRange(info: ValueInfo): string;                          // "−5…5", "2000…50000"
  photoHeader(h: PhotoHeader): string;
  toolTable(rows: ToolRow[]): string;
  photoTable(rows: PhotoRow[]): string;
  extensionTable(rows: ExtensionRow[]): string;
  searchTable(rows: SearchRow[]): string;
  historyList(rows: HistoryRow[]): string;
  resultLine(r: ResultLine): string;
  summary(s: BatchSummary): string;
  exported(e: ExportedLine): string;
  help(s: HelpScreen): string;
  verbHelp(v: VerbHelp): string;
  doctor(items: DoctorItem[]): string;
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
}

export interface HomeStatus {
  version: string;
  cwd: string;
  /** The project holding cwd, if any. */
  project: { root: string; name: string; photos: number; edited: number } | null;
  /** Safelight has that project open, so writes will be refused. */
  guiHasProjectOpen: boolean;
  /** GPU backend from the app, e.g. "d3d11"; null = not known yet. */
  graphics: string | null;
  /** The app has written its settings file. */
  settingsShared: boolean;
  /** updates null = not checked. */
  extensions: { installed: number; updates: number | null };
}
export interface PromptState { projectName: string | null; /** A command is running. */ busy?: boolean }
export type ReplNoteKind = "interrupt" | "bye" | "cancelled" | "unknown";

export interface OutputStreams { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream }
