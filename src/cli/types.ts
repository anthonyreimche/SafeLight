// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shapes every `slu` command and service is built against.

import type { CatalogPhoto, EditState, DevelopParams } from "@/catalog/types";
import type { Output } from "./output/types";
import type { EngineClient } from "./engine-client";

export type ExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 130;

/** Every expected failure. `hint` is the second line ("slu tools X lists them."). */
export class CliError extends Error {
  readonly code: ExitCode;
  readonly hint: string | undefined;
  constructor(code: ExitCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
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

export type HelpGroup = "Look" | "Edit" | "Share" | "Organize" | "Output" | "Extensions" | "More";

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
}

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
  edit(photoId: string): Promise<EditState | undefined>;
  close(): Promise<void>;
}

export interface WriteSession extends ReadSession {
  putEdits(states: EditState[]): Promise<void>;
  putPhotos(photos: CatalogPhoto[]): Promise<void>;
  /** Flush, release the lock, close. Always call, also after an error. */
  close(): Promise<void>;
}

export interface ProjectService {
  /** Nearest project holding `absPath` (cli-plumbing §1.3), or null. */
  find(absPath: string): Promise<ProjectRef | null>;
  openRead(project: ProjectRef): Promise<ReadSession>;
  /** Throws CliError(4) when Safelight holds the lock and waitSeconds runs out. */
  openWrite(project: ProjectRef, waitSeconds: number | null): Promise<WriteSession>;
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
  /** Can slu set its values this round. */
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
  /** Why not, in user words ("Edit Tone Curve's points in Safelight; slu can't set them yet."). */
  notSettableReason?: string;
  /** Ranges unknown: extension installed but no descriptor file. */
  rangeUnknown?: boolean;
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
  id: string; name: string; version: string; enabled: boolean; trust: Trust; repo: string | null;
}

export interface SearchHit {
  id: string; name: string; version: string; category: string; trust: Trust; repo: string; installName: string;
}

export interface ExtensionService {
  installed(): Promise<InstalledExtension[]>;
  search(words: string[]): Promise<SearchHit[]>;
  /** Name → one repo or id (cli-commands §2 rules); CliError(5) lists candidates when ambiguous. */
  resolve(name: string): Promise<{ repo: string; id?: string } | { kit: string; repos: string[] }>;
  install(repo: string, opts: { version?: string; confirm: (risk: InstallRisk) => Promise<boolean> }): Promise<InstalledExtension>;
  uninstall(id: string): Promise<void>;
  updatesAvailable(ids?: string[]): Promise<{ id: string; from: string; to: string }[]>;
  setEnabled(id: string, enabled: boolean): Promise<void>;
  /** True when the GUI looks to be running (fresh shared-settings heartbeat). */
  guiRunning(): Promise<boolean>;
}

export interface InstallRisk { name: string; trust: Trust; permissions: string[] }

// ---- preview (P1.10 implements) -------------------------------------------

export type GraphicsMode = "kitty" | "iterm" | "blocks" | "none";

export interface PreviewService {
  /** Render and print one photo after the command's own output. */
  show(project: ProjectRef, photo: CatalogPhoto, opts: { widthCols?: number; tryAssigns?: Assignment[]; mode?: GraphicsMode }): Promise<void>;
}
