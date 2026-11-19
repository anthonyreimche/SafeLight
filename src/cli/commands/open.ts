// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `open`: the photos to work on at the prompt. At the prompt it is the
// prompt's own word, and findOpenSet finds the photos it names. From a shell,
// `safelight open X` starts the prompt with X open (main.ts hands over), so on
// anything but a terminal it is refused.

import { stat } from "node:fs/promises";
import path from "node:path";
import { isSupportedName } from "@/catalog/photo-names";
import type { CatalogPhoto } from "@/catalog/types";
import { PHOTO_OPTIONS } from "../args";
import { importEvents } from "../engine-client";
import { hasGlob } from "../glob";
import { newRequestId } from "../preview";
import { buildSelectRequest, missingError, stdinPathsOf } from "../select";
import {
  CliError,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs,
  type ProjectRef,
  type ReadSession,
  type Selection,
  type WorkingSet,
  COMMAND,
} from "../types";

const SORTS = ["name", "date", "rating"] as const;
type OpenSort = (typeof SORTS)[number];

/** The words only the prompt knows, and what they say when run from a shell. */
const PROMPT_ONLY = new Set(["next", "prev", "close"]);

export function promptOnlyError(verb: string): CliError | null {
  return PROMPT_ONLY.has(verb) ? new CliError(1, `${verb} works at the prompt: ${COMMAND} open <photos>`) : null;
}

export const openCommand: CommandSpec = {
  verb: "open",
  group: "Library",
  summary: "Opens photos at the prompt. The current one shows with its values, and a command naming no photo acts on it.",
  usage: "open [photos…] [filters]",
  examples: [
    `${COMMAND} open DSC_0412.NEF`,
    `${COMMAND} open *.NEF --flag pick`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    { name: "sort", kind: "string", summary: `Order the set by ${SORTS.join(", ")} (lowest first).` },
    { name: "reverse", kind: "flag", summary: "Reverse the order." },
    { name: "no-preview", kind: "flag", summary: "Show the values without the picture." },
  ],
  writes: false,
  // Reached only when main didn't hand over to the prompt: no terminal, or --json.
  async run() {
    throw new CliError(1, "open works in a terminal. In scripts, use tools, preview or export.");
  },
};

function sortOf(args: ParsedArgs): OpenSort {
  const text = args.options.sort;
  if (text === undefined) return "name";
  const found = SORTS.find((s) => s === String(text).toLowerCase());
  if (!found) throw new CliError(1, `--sort ${String(text)} isn't one of ${SORTS.join(", ")}.`);
  return found;
}

const byName = (a: CatalogPhoto, b: CatalogPhoto): number => a.relPath.localeCompare(b.relPath, undefined, { numeric: true });

function ordered(photos: readonly CatalogPhoto[], sort: OpenSort, reverse: boolean): CatalogPhoto[] {
  const compare = (a: CatalogPhoto, b: CatalogPhoto): number => {
    if (sort === "rating") return a.rating - b.rating || byName(a, b);
    if (sort === "date") {
      const when = (p: CatalogPhoto) => p.exif.dateTimeOriginal ?? "";
      return when(a).localeCompare(when(b)) || byName(a, b);
    }
    return byName(a, b);
  };
  const sorted = [...photos].sort(compare);
  return reverse ? sorted.reverse() : sorted;
}

interface ToImport { project: ProjectRef; relPath: string; spec: string }

const pathsOf = (ctx: CommandContext): path.PlatformPath => (ctx.env.platform === "win32" ? path.win32 : path.posix);

/** The named photos that sit in a project but aren't in its catalogue yet (D-L4: open imports them first). */
async function notImported(ctx: CommandContext, selection: Selection<ReadSession>): Promise<ToImport[]> {
  const p = pathsOf(ctx);
  const found: ToImport[] = [];
  for (const missing of selection.missing) {
    if (missing.reason !== "not-in-catalogue" || hasGlob(missing.spec) || !isSupportedName(missing.spec)) continue;
    const abs = p.resolve(ctx.env.cwd, missing.spec);
    if (!(await stat(abs).then((s) => s.isFile(), () => false))) continue;
    const project = await ctx.projects.find(abs);
    if (!project) continue;
    found.push({ project, relPath: p.relative(project.root, abs).split(p.sep).join("/"), spec: missing.spec });
  }
  return found;
}

/** Imports these photos alone, as `import <photo>` does, through the engine. A write: refused with exit 4
 *  while Safelight has the project open. */
async function importAlone(ctx: CommandContext, project: ProjectRef, photos: readonly ToImport[]): Promise<void> {
  const request: Parameters<typeof importEvents>[1] = {
    id: newRequestId(),
    type: "import",
    project: { root: project.root },
    scope: { kind: "some", files: photos.map((p) => p.relPath), folders: [] },
    metadata: true,
    keepBackup: true,
  };
  for await (const event of importEvents(ctx.engine(), request)) {
    if (event.type === "import-file" && event.state === "failed") {
      throw new CliError(2, `${event.relPath} couldn't be imported${event.error ? `: ${event.error}` : "."}`);
    }
    if (event.type === "import-done" && event.stopped === "safelight-opened") {
      throw new CliError(4, `Safelight opened ${project.root}, so ${photos.map((p) => p.spec).join(", ")} wasn't imported.`);
    }
  }
  for (const photo of photos) ctx.out.print(`Imported ${photo.spec}.`);
}

/** The set `open` names: photos, globs, folders and filters as every verb takes them, from one project,
 *  in name order unless --sort says otherwise. Photos in a project but not imported are imported first. */
export async function findOpenSet(ctx: CommandContext, args: ParsedArgs): Promise<WorkingSet> {
  const sort = sortOf(args);
  const request = buildSelectRequest(args, args.positionals, await stdinPathsOf(ctx, args));
  let selection = await ctx.select.read(request);
  const toImport = await notImported(ctx, selection).catch(async (error: unknown) => {
    await selection.close();
    throw error;
  });
  if (toImport.length > 0) {
    await selection.close();
    const roots = [...new Set(toImport.map((t) => t.project.root))];
    for (const root of roots) {
      const photos = toImport.filter((t) => t.project.root === root);
      await importAlone(ctx, photos[0].project, photos);
    }
    selection = await ctx.select.read(request);
  }
  try {
    if (selection.missing.length > 0) throw missingError(selection.missing[0]);
    if (selection.groups.length > 1) {
      throw new CliError(1, "open takes photos from one project at a time.", "Name photos from one folder Safelight has opened.");
    }
    const group = selection.groups[0];
    if (!group || group.photos.length === 0) throw new CliError(2, "No photo matches.");
    const root = group.session.project.root;
    const photos = ordered(group.photos, sort, args.options.reverse === true);
    return { paths: photos.map((photo) => pathsOf(ctx).join(root, photo.relPath)), index: 0, root };
  } finally {
    await selection.close();
  }
}
