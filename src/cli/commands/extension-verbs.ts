// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions' console commands as `safelight` verbs. An installed extension
// that is on declares them in its manifest (`commands`), which is read here
// without the engine, for help, completion and dispatch. Running one hands the
// words to the engine, where the extension registered it (api.commands); what
// it saves beside its photos is imported afterwards, as `import` would.

import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CatalogPhoto } from "@/catalog/types";
import type { EngineEvent, ImportScope } from "@/engine/protocol";
import { COMMAND_NAME, RESERVED_COMMAND_NAMES, readOnlyFolder } from "@/extensions/command-rules";
import { PHOTO_OPTIONS } from "../args";
import { importEvents, type RequestOptions } from "../engine-client";
import { disabledIdsSync, installedManifests, type Manifest } from "../extensions";
import { readSharedSettings } from "../mirror";
import { newRequestId, projectWire, withLamp } from "../preview";
import { catalogueStamp } from "../preview-cache";
import { applyWorkingSet, buildSelectRequest, missingError, stdinPathsOf } from "../select";
import { CliError, type CommandContext, type CommandOutcome, type CommandSpec, type ExitCode, type ParsedArgs, type ProjectRef, type Stops, COMMAND } from "../types";
import { waitForWriterLock } from "./import";

/** A command as a manifest declares it, checked. */
export interface DeclaredCommand {
  name: string;
  summary: string;
  usage: string[];
  examples: string[];
  subcommands: { name: string; summary: string }[];
}

/** A declared command that didn't become a verb, and why: for doctor. */
export interface SkippedVerb { extension: string; name: string; reason: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isLines = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

function subcommandsOf(value: unknown): { name: string; summary: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((s) => (isRecord(s) && typeof s.name === "string" && typeof s.summary === "string" ? [{ name: s.name, summary: s.summary }] : []));
}

/** The commands `manifest` declares, and what it declares that isn't one. */
function declaredCommands(manifest: Manifest): { commands: DeclaredCommand[]; skipped: SkippedVerb[] } {
  const raw = manifest.commands;
  const skip = (name: string, reason: string): SkippedVerb => ({ extension: manifest.id, name, reason });
  if (raw === undefined) return { commands: [], skipped: [] };
  if (!Array.isArray(raw)) return { commands: [], skipped: [skip("", "its commands aren't a list")] };
  const commands: DeclaredCommand[] = [];
  const skipped: SkippedVerb[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      skipped.push(skip("", "a command that isn't an object"));
      continue;
    }
    const name = typeof entry.name === "string" ? entry.name : "";
    if (!COMMAND_NAME.test(name)) skipped.push(skip(name, `"${name}" isn't a command name`));
    else if (typeof entry.summary !== "string" || !isLines(entry.usage) || entry.usage.length === 0) {
      skipped.push(skip(name, `${name} needs a summary and its usage lines`));
    } else {
      commands.push({
        name,
        summary: entry.summary,
        usage: entry.usage,
        examples: isLines(entry.examples) ? entry.examples : [],
        subcommands: subcommandsOf(entry.subcommands),
      });
    }
  }
  return { commands, skipped };
}

const exampleLine = (line: string): string => (line.startsWith(`${COMMAND} `) ? line : `${COMMAND} ${line}`);

function verbOf(manifest: Manifest, c: DeclaredCommand): CommandSpec {
  return {
    verb: c.name,
    group: "Extensions",
    summary: c.summary,
    usage: c.usage.join(`\n${COMMAND} `),
    examples: c.examples.map(exampleLine),
    options: [...PHOTO_OPTIONS],
    writes: false,
    ownsStop: true,
    rawArgs: true,
    subcommands: c.subcommands,
    run: (ctx, args) => runExtensionCommand(ctx, args, manifest.id, c.name, ctx.stops),
  };
}

/** One verb per command an installed extension that is on declares. A
 *  `safelight` verb or a prompt word wins over an extension's; between
 *  extensions, the lowest id wins. What lost is in `skipped`. */
export function extensionVerbs(core: readonly CommandSpec[], userData: string): { specs: CommandSpec[]; skipped: SkippedVerb[] } {
  const disabled = new Set(disabledIdsSync(userData));
  const taken = new Set([...RESERVED_COMMAND_NAMES, ...core.flatMap((c) => [c.verb, ...(c.aliases ?? [])])]);
  const owners = new Map<string, Manifest>();
  const specs: CommandSpec[] = [];
  const skipped: SkippedVerb[] = [];
  const manifests = installedManifests(userData)
    .filter((m) => !disabled.has(m.id))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const manifest of manifests) {
    const declared = declaredCommands(manifest);
    skipped.push(...declared.skipped);
    for (const c of declared.commands) {
      const owner = owners.get(c.name);
      if (taken.has(c.name) && !owner) {
        skipped.push({ extension: manifest.id, name: c.name, reason: `${c.name} is one of ${COMMAND}'s own verbs` });
      } else if (owner) {
        skipped.push({ extension: manifest.id, name: c.name, reason: `${c.name} is ${owner.name}'s (${owner.id})` });
      } else {
        owners.set(c.name, manifest);
        taken.add(c.name);
        specs.push(verbOf(manifest, c));
      }
    }
  }
  return { specs, skipped };
}

/** `core` and then the extensions' verbs. */
export function withExtensionVerbs(core: readonly CommandSpec[], userData: string): CommandSpec[] {
  return [...core, ...extensionVerbs(core, userData).specs];
}

// ---- running one ------------------------------------------------------------

export interface RunDeps {
  /** Whether a file can be written into the folder at `dir` now. */
  canWrite(dir: string): Promise<boolean>;
}

/** Writes and removes a hidden file, which the project scan skips: the only
 *  sure sign on every platform that the folder takes writes. */
async function canWriteDir(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.sl-write-${randomUUID()}`);
  try {
    await writeFile(probe, "");
  } catch {
    return false;
  }
  await rm(probe, { force: true }).catch(() => {});
  return true;
}

interface SavedJson { photo: string; relPath: string; path: string; id?: string; error?: string }

type CommandError = Extract<EngineEvent, { type: "error" }>;

function commandFailure(event: CommandError): CliError {
  const code: ExitCode = event.code === "command" ? 1 : event.code === "project" ? 2 : event.code === "locked" ? 4 : 3;
  return new CliError(code, event.message);
}

const folderOf = (photo: CatalogPhoto): string => photo.relPath.split("/").slice(0, -1).join("/");

/** Runs extension `extensionId`'s command `name` with the verb's raw words on
 *  the photos named after `--` (or the open one), then imports what it saved. */
export async function runExtensionCommand(
  ctx: CommandContext,
  args: ParsedArgs,
  extensionId: string,
  name: string,
  stops: Partial<Stops> = {},
  deps: RunDeps = { canWrite: canWriteDir },
): Promise<CommandOutcome> {
  const request = applyWorkingSet(buildSelectRequest(args, [], await stdinPathsOf(ctx, args)), ctx.working);
  const named = request.specs.length > 0 || request.stdinPaths.length > 0 || request.all;
  const selection = named ? await ctx.select.read(request) : null;
  try {
    if (selection && selection.missing.length > 0) throw missingError(selection.missing[0]);
    const groups = selection?.groups ?? [];
    if (groups.length > 1) throw new CliError(1, `${name} takes photos from one project at a time.`, "Name photos from one project.");
    if (named && groups.length === 0) throw new CliError(2, "No photo matches.");
    const project: ProjectRef | null = groups[0]?.session.project ?? null;
    const photos = groups[0]?.photos ?? [];

    if (project) {
      if (!(await waitForWriterLock(ctx, project.root, project.workingDir, stops.signal))) {
        ctx.out.error({ message: "Stopped." });
        return { code: 130 };
      }
      for (const folder of new Set(photos.map(folderOf))) {
        if (!(await deps.canWrite(path.join(project.root, ...folder.split("/").filter(Boolean))))) {
          throw new CliError(2, `${readOnlyFolder(folder)} ${name} can't save its results there.`);
        }
      }
    }

    const settings = readSharedSettings(ctx.env.userData)?.storage[`sl_ext_settings_${extensionId}`] ?? null;
    const catalogue = project ? await catalogueStamp(project.workingDir) : undefined;
    const saved: SavedJson[] = [];
    let result: unknown = null;
    let failure: CliError | null = null;
    const options: RequestOptions = { ...(stops.signal && { signal: stops.signal }), ...(stops.force && { force: stops.force }) };
    const items = ctx.engine().request({
      id: newRequestId(),
      type: "command",
      extension: extensionId,
      name,
      words: args.positionals,
      ...(project && { project: projectWire(project) }),
      photoIds: photos.map((p) => p.id),
      ...(catalogue !== undefined && { catalogue }),
      settings,
    }, options);
    try {
      for await (const item of withLamp(ctx.out, "Starting the engine…", items)) {
        if (!("type" in item)) continue;
        if (item.type === "command-output") {
          if (item.stream === "out") {
            if (!ctx.json) ctx.out.print(item.text);
          } else if (item.stream === "info") ctx.out.info(item.text);
          else ctx.out.warn({ message: item.text });
        } else if (item.type === "command-saved" && project) {
          saved.push({ photo: item.photoId, relPath: item.relPath, path: path.join(project.root, ...item.relPath.split("/")) });
        } else if (item.type === "command-result") {
          result = item.value;
        } else if (item.type === "progress" && item.text !== undefined) {
          ctx.out.progress(item.text === "" ? null : { label: item.text, done: item.done, total: item.total });
        } else if (item.type === "error") {
          failure = commandFailure(item);
        }
      }
    } catch (error) {
      failure = error instanceof CliError ? error : new CliError(3, error instanceof Error ? error.message : String(error));
    } finally {
      ctx.out.progress(null);
    }

    const unread = project && saved.length > 0 ? await importSaved(ctx, project, saved, stops) : 0;
    if (failure) throw failure;
    if (stops.signal?.aborted) return { code: 130, json: { slu: 1, result, saved } };
    return { code: unread > 0 ? 6 : 0, json: { slu: 1, result, saved } };
  } finally {
    await selection?.close();
    await ctx.engine().shutdown();
  }
}

/** Imports the files a command saved, under the writer lock as `import` does,
 *  and prints each; how many couldn't be read. Only a second Ctrl+C stops it:
 *  the files are on disk already. */
async function importSaved(ctx: CommandContext, project: ProjectRef, saved: SavedJson[], stops: Partial<Stops>): Promise<number> {
  if (!(await waitForWriterLock(ctx, project.root, project.workingDir, stops.force))) return saved.length;
  const scope: ImportScope = { kind: "some", files: saved.map((s) => s.relPath), folders: [] };
  const byRel = new Map(saved.map((s) => [s.relPath, s]));
  let unread = 0;
  const events = importEvents(
    ctx.engine(),
    { id: newRequestId(), type: "import", project: { root: project.root }, scope, metadata: true, keepBackup: true },
    stops.force ? { force: stops.force } : {},
  );
  for await (const event of events) {
    if (event.type !== "import-file") continue;
    const entry = byRel.get(event.relPath);
    if (event.state === "failed") {
      unread++;
      if (entry) entry.error = event.error ?? "couldn't be read";
    } else if (entry && event.photoId !== undefined) entry.id = event.photoId;
    if (!ctx.json) ctx.out.finished(ctx.out.importedFile({ path: event.relPath, state: event.state, ...(event.error !== undefined && { error: event.error }) }));
  }
  return unread;
}
