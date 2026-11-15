// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What copy, paste and apply share: the clipboard file, the saved presets, and
// the write that appends one history step per photo.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { appendStep, currentLook } from "@/catalog/edit-steps";
import { defaultCopy, pasteLook, type PartialLook } from "@/catalog/paste-look";
import { NEUTRAL_TEMPERATURE_K, type CatalogPhoto, type DevelopParams } from "@/catalog/types";
import { readSharedSettings } from "../mirror";
import { buildSelectRequest, stdinPathsOf } from "../select";
import {
  CliError,
  type CommandContext,
  type CommandOutcome,
  type ParsedArgs,
  type ReadSession,
  type SelectRequest,
  type Selection, COMMAND } from "../types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const photoName = (photo: CatalogPhoto): string => basename(photo.relPath);

// ---- selecting photos -------------------------------------------------------

export async function selectRequest(ctx: CommandContext, args: ParsedArgs, specs: string[]): Promise<SelectRequest> {
  return buildSelectRequest(args, specs, await stdinPathsOf(ctx, args));
}

const MISSING_TEXT = {
  "not-found": `isn't a photo or folder ${COMMAND} can find.`,
  "not-in-catalogue": `isn't in a Safelight catalogue, so ${COMMAND} won't edit it.`,
  "no-match": "matched no photos.",
} as const;

function warnMissing(ctx: CommandContext, selection: Selection<ReadSession>): void {
  for (const m of selection.missing) {
    const hint = m.reason === "not-in-catalogue" ? "Open its folder in Safelight first." : undefined;
    ctx.out.warn({ message: `${m.spec} ${MISSING_TEXT[m.reason]}`, ...(hint ? { hint } : {}) });
  }
}

export function toolsOf(value: string | boolean | number | string[] | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.flatMap((v) => v.split(",")).map((v) => v.trim()).filter((v) => v !== "");
  return names.length > 0 ? names : undefined;
}

// ---- the clipboard ----------------------------------------------------------

export interface ClipboardFile {
  version: 1;
  look: PartialLook;
  tools?: string[];
  from: string;
}

const clipboardPath = (userData: string): string => join(userData, "slu", "clipboard.json");

export async function writeClipboard(userData: string, clip: ClipboardFile): Promise<void> {
  await mkdir(join(userData, "slu"), { recursive: true });
  await writeFile(clipboardPath(userData), JSON.stringify(clip, null, 2), "utf8");
}

export async function readClipboard(userData: string): Promise<ClipboardFile> {
  const empty = new CliError(2, "Nothing is copied yet.", `${COMMAND} copy <photo> remembers a photo's settings, or give paste --from <photo>.`);
  let raw: string;
  try {
    raw = await readFile(clipboardPath(userData), "utf8");
  } catch {
    throw empty;
  }
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw empty;
  }
  if (!isRecord(doc) || doc.version !== 1 || !isRecord(doc.look)) throw empty;
  const { params, paramBag } = doc.look;
  if (!isRecord(params) || !isRecord(paramBag)) throw empty;
  return {
    version: 1,
    look: { params: params as Partial<DevelopParams>, paramBag },
    ...(Array.isArray(doc.tools) ? { tools: doc.tools.filter((t): t is string => typeof t === "string") } : {}),
    from: typeof doc.from === "string" ? doc.from : "",
  };
}

/** `look` cut down to the values the named tools own. */
export function restrictToTools(ctx: CommandContext, look: PartialLook, tools: string[]): PartialLook {
  const keys = new Set(tools.flatMap((name) => ctx.values.values(ctx.values.tool(name).id).map((v) => v.key)));
  const topLevel = new Set([...keys].map((k) => k.split(".")[0]));
  const params: Partial<DevelopParams> = {};
  for (const key of Object.keys(look.params) as (keyof DevelopParams)[]) {
    if (key === "processVersion" || !topLevel.has(key)) continue;
    (params as Record<string, unknown>)[key] = structuredClone(look.params[key]);
  }
  const paramBag: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(look.paramBag)) {
    if (keys.has(key)) paramBag[key] = structuredClone(value);
  }
  return { params, paramBag };
}

/** What `copy` and `paste --from` take from the one photo `spec` names. */
export async function copyFromPhoto(
  ctx: CommandContext,
  args: ParsedArgs,
  spec: string,
  tools: string[] | undefined,
): Promise<ClipboardFile> {
  const source: SelectRequest = {
    specs: [spec],
    recursive: false,
    all: false,
    projectOverride: typeof args.options.project === "string" ? args.options.project : null,
    filters: {},
    stdinPaths: [],
  };
  const selection = await ctx.select.read(source);
  try {
    warnMissing(ctx, selection);
    const photos = selection.groups.flatMap((g) => g.photos.map((photo) => ({ photo, session: g.session })));
    if (photos.length !== 1) {
      throw new CliError(photos.length === 0 ? 2 : 1, photos.length === 0 ? `No photo to copy from "${spec}".` : `Copy from one photo; "${spec}" is ${photos.length}.`);
    }
    const { photo, session } = photos[0];
    const look = currentLook(await session.edit(photo.id), photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K);
    const copied = tools && tools.length > 0 ? restrictToTools(ctx, look, tools) : defaultCopy(look);
    if (Object.keys(copied.params).length === 0 && Object.keys(copied.paramBag).length === 0) {
      throw new CliError(2, `${photoName(photo)} has no edits to copy.`);
    }
    return { version: 1, look: copied, ...(tools && tools.length > 0 ? { tools } : {}), from: photoName(photo) };
  } finally {
    await selection.close();
  }
}

// ---- presets ----------------------------------------------------------------

export interface SavedPreset {
  id: string;
  name: string;
  group?: string;
  params: Partial<DevelopParams>;
  paramBag?: Record<string, unknown>;
}

function isPreset(v: unknown): v is SavedPreset {
  return (
    isRecord(v) &&
    typeof v.id === "string" &&
    typeof v.name === "string" &&
    isRecord(v.params) &&
    (v.group === undefined || typeof v.group === "string") &&
    (v.paramBag === undefined || isRecord(v.paramBag))
  );
}

export function parsePresets(raw: string | undefined): SavedPreset[] {
  if (!raw) return [];
  try {
    const stored: unknown = JSON.parse(raw);
    return Array.isArray(stored) ? stored.filter(isPreset) : [];
  } catch {
    return [];
  }
}

export function loadPresets(userData: string): SavedPreset[] {
  return parsePresets(readSharedSettings(userData)?.storage["safelight-presets"]);
}

// ---- writing one step per photo ---------------------------------------------

/** Appends `label` to every selected photo with `partial` merged over its look. */
export async function writeLooks(
  ctx: CommandContext,
  args: ParsedArgs,
  specs: string[],
  label: string,
  partial: PartialLook,
): Promise<CommandOutcome> {
  const selection = await ctx.select.write(await selectRequest(ctx, args, specs), ctx.waitSeconds);
  const results: { photo: string; ok: boolean; step?: number; unchanged?: boolean; error?: string }[] = [];
  let previewTarget: { group: (typeof selection.groups)[number]; photo: CatalogPhoto } | undefined;
  let written = 0;
  try {
    warnMissing(ctx, selection);
    for (const m of selection.missing) results.push({ photo: m.spec, ok: false, error: MISSING_TEXT[m.reason] });
    for (const group of selection.groups) {
      const states = [];
      for (const photo of group.photos) {
        const name = photoName(photo);
        const asShot = photo.exif.colorTemperature ?? NEUTRAL_TEMPERATURE_K;
        const state = await group.session.edit(photo.id);
        const base = currentLook(state, asShot);
        const next = pasteLook(base, partial);
        if (JSON.stringify(next) === JSON.stringify(base)) {
          results.push({ photo: name, ok: true, unchanged: true });
          if (!ctx.json) ctx.out.print(ctx.out.resultLine({ photo: name, changes: [], note: "already matches" }));
          continue;
        }
        const after = appendStep(state, { photoId: photo.id, asShot }, label, next, Date.now());
        states.push(after);
        results.push({ photo: name, ok: true, step: after.currentIndex });
        if (!ctx.json) ctx.out.print(ctx.out.resultLine({ photo: name, changes: [{ label, value: "" }], step: after.currentIndex }));
        previewTarget = { group, photo };
      }
      if (states.length > 0) await group.session.putEdits(states);
      written += states.length;
    }
  } finally {
    await selection.close();
  }

  const failed = selection.missing.length;
  const photos = results.length - failed;
  if (photos + failed === 0) throw new CliError(2, "No photos matched.", `${COMMAND} help lists the ways to name photos.`);
  if (photos > 1 && !ctx.json) {
    ctx.out.print(ctx.out.summary({ photos, stepEach: true, failed, skipped: results.filter((r) => r.unchanged).length }));
  }
  if (ctx.json) ctx.out.json({ slu: 1, photos: results });

  if (args.options.preview === true && photos === 1 && previewTarget && written === 1) {
    await ctx.preview.show(previewTarget.group.session.project, previewTarget.photo, {});
  }
  if (failed === 0) return { code: 0 };
  return { code: photos === 0 ? 2 : 6 };
}
