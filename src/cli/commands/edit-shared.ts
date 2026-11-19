// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the verbs that write to photos share: choosing the photos, one write
// session per command, per-photo failures, and the output lines.

import path from "node:path";
import { appendStep, currentLook, moveCursor } from "@/catalog/edit-steps";
import type { StoredLook } from "@/catalog/stored-edit-look";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { NEUTRAL_TEMPERATURE_K } from "@/catalog/types";
import type { ResultLine } from "../output/types";
import { applyWorkingSet, buildSelectRequest, importFix, isEdited, stdinPathsOf } from "../select";
import {
  CliError,
  type CommandContext,
  type CommandOutcome,
  type ParsedArgs,
  type ProjectRef,
  type SelectRequest,
  type ToolRef,
  type ValueChange,
  type WriteSession, COMMAND } from "../types";

export const asShotOf = (photo: CatalogPhoto): number => photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K;

export const photoName = (photo: CatalogPhoto): string => photo.relPath.split(/[\\/]/).pop() ?? photo.relPath;

/** The photo specs the command line names, given the positionals already taken as the command's own words. */
export async function selectRequest(ctx: CommandContext, args: ParsedArgs, specs: string[]): Promise<SelectRequest> {
  const request = applyWorkingSet(buildSelectRequest(args, specs, await stdinPathsOf(ctx, args)), ctx.working);
  if (request.specs.length === 0 && request.stdinPaths.length === 0 && !request.all) {
    throw new CliError(1, `Say which photos ${args.verb ?? "this"} should change.`, `${COMMAND} help ${args.verb ?? ""}`.trim() + " shows how.");
  }
  return request;
}

const MISSING_TEXT = {
  "not-found": (spec: string) => new CliError(2, `${spec} wasn't found.`),
  "not-in-catalogue": (spec: string) =>
    new CliError(2, `${spec} isn't imported, so ${COMMAND} won't change it.`, importFix(spec)),
  "no-match": (spec: string) => new CliError(2, `Nothing matches ${spec}.`),
} as const;

export interface PhotoWork {
  photo: CatalogPhoto;
  state: EditState | undefined;
  asShot: number;
  project: ProjectRef;
}

/** What one photo's handler decided. `edit` and `photo` are written after every photo has been worked out. */
export interface PhotoOutcome {
  line: ResultLine;
  json: Record<string, unknown>;
  edit?: EditState;
  photo?: CatalogPhoto;
  /** Nothing to write: reported, and counted as skipped. */
  skipped?: boolean;
}

export type PhotoHandler = (work: PhotoWork) => PhotoOutcome;

/** One photo's result can draw its sliders moving; with several photos each stays a plain line. */
export function showResult(ctx: CommandContext, single: boolean, line: ResultLine): void {
  if (single) ctx.out.result(line);
  else ctx.out.print(ctx.out.resultLine(line));
}

interface Previewable { project: ProjectRef; photo: CatalogPhoto }

/** Runs `handle` on every selected photo inside one write session per project.
 *  A usage error (exit 1) aborts before anything is written; any other error fails that photo only. */
export async function runOnPhotos(
  ctx: CommandContext,
  args: ParsedArgs,
  specs: string[],
  stepEach: boolean,
  handle: PhotoHandler,
): Promise<CommandOutcome> {
  const request = await selectRequest(ctx, args, specs);
  const selection = await ctx.select.write(request, ctx.waitSeconds);
  const results: Record<string, unknown>[] = [];
  const single = selection.groups.reduce((n, g) => n + g.photos.length, 0) === 1;
  const missing = selection.missing.map((m) => MISSING_TEXT[m.reason](m.spec));
  const failures: CliError[] = [...missing];
  let done = 0;
  let skipped = 0;
  let last: Previewable | null = null;
  const pending: { session: WriteSession; edits: EditState[]; photos: CatalogPhoto[] }[] = [];
  try {
    for (const group of selection.groups) {
      const edits: EditState[] = [];
      const photos: CatalogPhoto[] = [];
      for (const photo of group.photos) {
        let outcome: PhotoOutcome;
        try {
          outcome = handle({ photo, state: await group.session.edit(photo.id), asShot: asShotOf(photo), project: group.session.project });
        } catch (e) {
          if (!(e instanceof CliError) || e.code === 1) throw e;
          failures.push(new CliError(e.code, `${photoName(photo)}: ${e.message}`, e.hint));
          results.push({ photo: photo.relPath, ok: false, error: e.message });
          continue;
        }
        if (outcome.edit) edits.push(outcome.edit);
        if (outcome.photo) photos.push(outcome.photo);
        if (outcome.skipped) skipped++;
        else done++;
        results.push({ photo: photo.relPath, ok: true, ...outcome.json });
        if (!ctx.json) showResult(ctx, single, outcome.line);
        last = { project: group.session.project, photo: outcome.photo ?? photo };
      }
      pending.push({ session: group.session, edits, photos });
    }
    // A usage error in any group stops before the first one is written.
    for (const p of pending) await write(p.session, p.edits, p.photos);
  } finally {
    await selection.close();
  }

  for (const f of failures) ctx.out.error({ message: f.message, hint: f.hint });
  for (const f of missing) results.push({ photo: null, ok: false, error: f.message });
  if (ctx.json) ctx.out.json({ slu: 1, photos: results });
  else if (done + skipped > 1) {
    ctx.out.print(ctx.out.summary({ photos: done + skipped, stepEach, failed: failures.length, skipped }));
  }

  if (args.options.preview === true && last && done + skipped === 1) await ctx.preview.show(last.project, last.photo, {});

  if (failures.length === 0) return { code: 0 };
  if (done + skipped === 0) return { code: failures[0].code };
  return { code: 6 };
}

async function write(session: WriteSession, edits: EditState[], photos: CatalogPhoto[]): Promise<void> {
  if (edits.length > 0) await session.putEdits(edits);
  if (photos.length > 0) await session.putPhotos(photos);
}

const sameLook = (a: StoredLook, b: StoredLook): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The photo as a path from where the command ran, as it would be typed there. */
function typedPath(ctx: CommandContext, project: ProjectRef, photo: CatalogPhoto): string {
  return path.relative(ctx.env.cwd, path.resolve(project.root, ...photo.relPath.split("/")));
}

/** The outcome of appending `look` as one history step; skipped when it equals the photo's current look. */
export function stepOutcome(
  ctx: CommandContext,
  { photo, state, asShot, project }: PhotoWork,
  look: StoredLook,
  label: string,
  changes: readonly ValueChange[],
): PhotoOutcome {
  const name = photoName(photo);
  // The first step seeds "Original" with the as-shot white balance, which a pending RAW doesn't have yet.
  if (photo.metadataPending && !isEdited(state)) {
    throw new CliError(2, "its camera data hasn't been read yet, so its white balance isn't known.", importFix(typedPath(ctx, project, photo)));
  }
  const json = {
    changes: changes.map((c) => ({ key: c.info.key, before: c.before, after: c.after })),
  };
  if (sameLook(look, currentLook(state, asShot))) {
    return { line: { photo: name, changes: [], note: "no change" }, json: { ...json, changed: false }, skipped: true };
  }
  const edit = appendStep(state, { photoId: photo.id, asShot }, label, look, Date.now());
  return {
    line: {
      photo: name,
      changes: changes.map((c) => ({
        label: c.info.label,
        value: ctx.out.formatValue(c.info, c.after),
        info: c.info,
        before: c.before,
        after: c.after,
        clamped: c.clamped !== undefined,
      })),
      step: edit.currentIndex,
      note: changes.length === 0 ? label : undefined,
    },
    json: { ...json, changed: true, step: edit.currentIndex },
    edit,
  };
}

/** `<photos> <tool>`: the last positional names the tool. */
export function toolOperand(ctx: CommandContext, args: ParsedArgs): { tool: ToolRef; photos: string[] } {
  const name = args.positionals[args.positionals.length - 1];
  if (name === undefined) throw new CliError(1, "Name a tool.", `${COMMAND} tools lists them.`);
  return { tool: ctx.values.tool(name), photos: args.positionals.slice(0, -1) };
}

/** undo (-1) and redo (+1): `n` steps, default 1, taken from a trailing number. */
export function moveHistory(ctx: CommandContext, args: ParsedArgs, direction: -1 | 1): Promise<CommandOutcome> {
  const last = args.positionals[args.positionals.length - 1];
  const hasPhotos = args.positionals.length > 1 || args.options.all === true || args.stdinList || args.afterDashDash.length > 0;
  const countGiven = last !== undefined && hasPhotos && /^\d+$/.test(last);
  const steps = countGiven ? Number(last) : 1;
  if (steps < 1) throw new CliError(1, "The number of steps must be 1 or more.");
  const photos = countGiven ? args.positionals.slice(0, -1) : args.positionals;
  const none = direction < 0 ? "Already at the first step." : "Already at the last step.";
  return runOnPhotos(ctx, args, photos, false, ({ photo, state }) => {
    const name = photoName(photo);
    const moved = state ? moveCursor(state, direction * steps) : undefined;
    if (!state || !moved || moved === state) {
      return { line: { photo: name, changes: [], note: none }, json: { changed: false }, skipped: true };
    }
    return {
      line: { photo: name, changes: [], step: moved.currentIndex, note: `Now at "${moved.stack[moved.currentIndex].label}".` },
      json: { changed: true, step: moved.currentIndex },
      edit: moved,
    };
  });
}

/** rate, flag and label: the last positional is the new value; the record changes with no history step. */
export function setRecordField<K extends "rating" | "colorLabel" | "flag">(
  ctx: CommandContext,
  args: ParsedArgs,
  field: K,
  parse: (word: string) => CatalogPhoto[K],
  describe: string,
): Promise<CommandOutcome> {
  const word = args.positionals[args.positionals.length - 1];
  if (word === undefined) throw new CliError(1, `Say what to set: ${describe}.`);
  const value = parse(word);
  return runOnPhotos(ctx, args, args.positionals.slice(0, -1), false, ({ photo }) => {
    const name = photoName(photo);
    const jsonKey = field === "colorLabel" ? "label" : field;
    if (photo[field] === value) {
      return { line: { photo: name, changes: [], note: "no change" }, json: { [jsonKey]: value, changed: false }, skipped: true };
    }
    return {
      line: { photo: name, changes: [{ label: jsonKey[0].toUpperCase() + jsonKey.slice(1), value: String(value) }] },
      json: { [jsonKey]: value, changed: true },
      photo: { ...photo, [field]: value },
    };
  });
}
