// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes every `safelight` command and service is built against.

import type { CatalogPhoto, EditState, DevelopParams } from "@/catalog/types";
import type { Output } from "./output/types";
import type { EngineClient } from "./engine-client";
import type { LookOverride } from "@/engine/protocol";

/** The shell command, as users type it. The one place a rename touches. */
export const COMMAND = "safelight";

export type ExitCode =0 | 1 | 2 | 3 | 4 | 5 | 6 | 130;

/** Every expected failure. `hint` is the second line ("safelight tools X lists them."); `fix` a line that
 *  puts it right, which a terminal shows on the error card and the prompt offers to run. */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;
  readonly fix: string | undefined;
  constructor(code: ExitCode, message: string, hint?: string, fix?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
    this.fix = fix;
  }
}

export type AssignOp = "=" | "+=" | "-=";
export interface Assignment { raw: string; key: string; op: AssignOp; value: string }

export type OptionKind = "flag" | "string" | "number" | "list";
export interface OptionSpec { name: string; alias?: string; kind: OptionKind; summary: string }

export interface ParsedArgs {
  verb: string | null;
  /** Positionals before `--`, minus assignments. */
  positionals: string[];
  assignments: Assignment[];
  /** Everything after `--`: always photos. */
  afterDashDash: string[];
  /** A lone "-" was given: read photo paths from stdin. */
  stdinList: boolean;
  options: Record<string, string | boolean | number | string[]>;
}

export type HelpGroup = "Look" | "Library" | "Edit" | "Share" | "Organize" | "Output" | "Extensions" | "More";

export interface CommandSpec {
  verb: string;
  aliases?: string[];
  group: HelpGroup;
  summary: string;
  usage: string;
  examples: string[];
  options: OptionSpec[];
  /** Takes the project writer lock. */
  writes: boolean;
  /** Winds down by itself on the first Ctrl+C, through `ctx.stops`; without it main stops the command where it stands. */
  ownsStop?: boolean;
  run(ctx: CommandContext, args: ParsedArgs): Promise<CommandOutcome>;
}

export interface CommandOutcome { code: ExitCode; json?: unknown }

export type Verbosity = "quiet" | "normal" | "verbose" | "debug";

export interface CliEnv {
  cwd: string;
  /** The GUI's userData (guiUserData()). */
  userData: string;
  /** Repo root in dev (has package.json), else <resources>/app.asar. */
  appRoot: string;
  /** The Electron binary the engine runs on; null when none was found. */
  electronBinary: string | null;
  appVersion: string;
  platform: NodeJS.Platform;
  isTTY: { stdin: boolean; stdout: boolean; stderr: boolean };
  env: Readonly<Record<string, string | undefined>>;
}

export interface CommandContext {
  env: CliEnv;
  out: Output;
  json: boolean;
  verbosity: Verbosity;
  strict: boolean;
  yes: boolean;
  /** Seconds to wait for the writer lock; null = don't wait (exit 4). Infinity = no limit. */
  waitSeconds: number | null;
  projects: ProjectService;
  select: PhotoSelector;
  values: ValueService;
  extensions: ExtensionService;
  engine: () => EngineClient;
  preview: PreviewService;
  readStdin(): Promise<string>;
  /** Asks a question on the terminal; the prompt supplies it, otherwise a command reads stdin itself. */
  ask?(question: string): Promise<string>;
  /** The photos the prompt has open: a command naming none acts on the current one. */
  working?: WorkingSet;
  /** Ctrl+C, for a command that `ownsStop`. */
  stops?: Stops;
}

/** The first Ctrl+C aborts `signal`: finish what is in flight, keep it, and stop. The second aborts `force`: stop now. */
export interface Stops { signal: AbortSignal; force: AbortSignal }

/** The prompt's open photos, in order: absolute paths, the current index and the project they are in. */
export interface WorkingSet { paths: string[]; index: number; root: string }

// ---- projects (P1.3 implements) -------------------------------------------

export interface ProjectRef {
  /** The folder the GUI opened as the project. */
  root: string;
  /** Where catalog.json lives: <root>/.safelight or a separate catalogue. */
  workingDir: string;
  location: "in-folder" | "external";
}

export interface ReadSession {
  readonly project: ProjectRef;
  photos(): readonly CatalogPhoto[];
  photoByRelPath(relPath: string): CatalogPhoto | undefined;
  /** The grid preview the app stored for this photo (a JPEG), or null: the picture without an engine. */
  previewFile(photo: CatalogPhoto): string | null;
  edit(photoId: string): Promise<EditState | undefined>;
  close(): Promise<void>;
}

export interface WriteSession extends ReadSession {
  putEdits(states: EditState[]): Promise<void>;
  putPhotos(photos: CatalogPhoto[]): Promise<void>;
  /** Removes the records, their edits and virtual copies; the files are tombstoned, not deleted. */
  removePhotos(ids: string[]): Promise<void>;
  /** Flush, release the lock, close. Always call, also after an error. */
  close(): Promise<void>;
}

export interface ProjectService {
  /** Nearest project holding `absPath` (cli-plumbing §1.3), or null. */
  find(absPath: string): Promise<ProjectRef | null>;
  openRead(project: ProjectRef): Promise<ReadSession>;
  /** Throws CliError(4) when Safelight holds the lock and waitSeconds runs out. */
  /** `signal` stops the wait for the lock, for Ctrl+C. */
  openWrite(project: ProjectRef, waitSeconds: number | null, signal?: AbortSignal): Promise<WriteSession>;
}

// ---- photo selection (P1.4 implements) ------------------------------------

export interface PhotoFilters {
  rating?: { min: number; max: number };
  flag?: "pick" | "reject" | "none";
  label?: "red" | "yellow" | "green" | "blue" | "purple" | "none";
  edited?: boolean;
}

export interface SelectRequest {
  specs: string[];
  recursive: boolean;
  all: boolean;
  projectOverride: string | null;
  filters: PhotoFilters;
  stdinPaths: string[];
}

export interface SelectedGroup<S extends ReadSession> { session: S; photos: CatalogPhoto[] }

export interface Selection<S extends ReadSession> {
  groups: SelectedGroup<S>[];
  missing: { spec: string; reason: "not-found" | "not-in-catalogue" | "no-match" }[];
  close(): Promise<void>;
}

export interface PhotoSelector {
  read(req: SelectRequest): Promise<Selection<ReadSession>>;
  write(req: SelectRequest, waitSeconds: number | null): Promise<Selection<WriteSession>>;
}

// ---- values (P1.5 implements) ---------------------------------------------

export interface Look { params: DevelopParams; paramBag: Record<string, unknown> }

export type ValueKind = "number" | "switch" | "choice" | "id";
export type ValueUnit = "EV" | "K" | "°";

export interface ToolRef {
  /** Extension id, e.g. "safelight.basic"; core-only values use "core". */
  id: string;
  name: string;
  kind: "core" | "extension";
  installed: boolean;
  enabled: boolean;
  /** Can safelight set its values this round. */
  settable: boolean;
  /** Pipeline position for listing. */
  order: number;
  /** Registers catalogue hooks (D-P4 warning), from descriptors. */
  hasCommitHooks: boolean;
}

export interface ValueInfo {
  key: string;
  label: string;
  tool: ToolRef;
  kind: ValueKind;
  min?: number;
  max?: number;
  step?: number;
  unit?: ValueUnit;
  decimals?: number;
  choices?: readonly { value: string; label: string }[];
  settable: boolean;
  /** Why not, in user words ("Edit Tone Curve's points in Safelight; safelight can't set them yet."). */
  notSettableReason?: string;
  /** Ranges unknown: extension installed but no descriptor file. */
  rangeUnknown?: boolean;
  /** Where the default sits, for slider bars; the control's default when known. */
  default?: number;
  /** Maps a value to 0…1 along the slider when the panel's slider isn't linear (temperature). */
  position?: (value: number) => number;
}

export interface ValueChange {
  info: ValueInfo;
  before: unknown;
  after: unknown;
  clamped?: { requested: number; limit: number };
}

export interface ApplyResult { look: Look; changes: ValueChange[]; label: string }

export interface ValueService {
  tools(): ToolRef[];
  tool(name: string): ToolRef;                    // CliError(1) when unknown
  values(toolId?: string): ValueInfo[];
  resolveKey(input: string): ValueInfo;           // CliError(1) with "Did you mean …?"
  read(look: Look, info: ValueInfo): unknown;
  isDefault(look: Look, info: ValueInfo, asShot: number): boolean;
  apply(look: Look, assigns: Assignment[], opts: { asShot: number; strict: boolean }): ApplyResult;
  resetTool(look: Look, toolId: string, asShot: number): Look;
  resetKeys(look: Look, keys: string[] | "all", asShot: number): Look;
}

// ---- extensions (P1.9 implements) -----------------------------------------

export type Trust = "official" | "verified" | "unverified" | "banned";

export interface InstalledExtension {
  id: string; name: string; version: string;
  /** Null until the app has written its list of what is on. */
  enabled: boolean | null;
  trust: Trust;
  /** Where safelight or the official list says it came from; null when that isn't known. */
  repo: string | null;
  /** What it may reach, as install lists it. */
  permissions: string[];
  /** The manifest's one line about it. */
  description?: string;
}

export interface SearchHit {
  id: string; name: string; version: string; category: string; trust: Trust; repo: string; installName: string;
  /** The registry's one line about it. */
  description?: string;
}

export interface ExtensionService {
  installed(): Promise<InstalledExtension[]>;
  search(words: string[]): Promise<SearchHit[]>;
  /** Name → one repo or id (cli-commands §2 rules); CliError(5) lists candidates when ambiguous. */
  resolve(name: string): Promise<{ repo: string; id?: string } | { kit: string; repos: string[] }>;
  install(repo: string, opts: { version?: string; confirm: (risk: InstallRisk) => Promise<boolean> }): Promise<InstalledExtension>;
  /** Rolls back an install still waiting on its question; for Ctrl+C. */
  abandon(): Promise<void>;
  uninstall(id: string): Promise<void>;
  updatesAvailable(ids?: string[]): Promise<{ id: string; from: string; to: string }[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** True when the GUI looks to be running (fresh shared-settings heartbeat). */
  guiRunning(): Promise<boolean>;
}

export interface InstallRisk { name: string; trust: Trust; permissions: string[] }

// ---- preview (P1.10 implements) -------------------------------------------

export type GraphicsMode = "kitty" | "iterm" | "sixel" | "blocks" | "none";

export interface PreviewService {
  /** Render and print one photo after the command's own output. */
  show(project: ProjectRef, photo: CatalogPhoto, opts: {
    widthCols?: number;
    tryAssigns?: Assignment[];
    mode?: GraphicsMode;
    overrides?: LookOverride;
    /** The stored look's key (preview-cache.ts lookKey), so a rendered one can be shown again without the engine. */
    look?: string;
  }): Promise<void>;
}
