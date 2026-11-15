// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Turns photo specs (files, globs, folders, --all, filters, stdin) into photos,
// grouped by project with one session each.

import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { expandGlob, hasGlob } from "./glob";
import {
  CliError,
  type CliEnv,
  type CommandContext,
  type ParsedArgs,
  type PhotoFilters,
  type PhotoSelector,
  type ProjectRef,
  type ProjectService,
  type ReadSession,
  type SelectRequest,
  type Selection,
  type SelectedGroup,
  type WriteSession,
} from "./types";

const FLAGS = ["pick", "reject", "none"] as const;
export const LABELS = ["red", "yellow", "green", "blue", "purple", "none"] as const;

/** "3" is exactly 3 stars, "3+" is 3 or more, "2-4" is 2 to 4. */
export function parseRating(text: string): { min: number; max: number } {
  const m = /^([0-5])(?:(\+)|-([0-5]))?$/.exec(text.trim());
  if (!m) throw new CliError(1, `--rating ${text} isn't a rating.`, "Use 3, 3+ or 2-4.");
  const min = Number(m[1]);
  const max = m[2] ? 5 : m[3] !== undefined ? Number(m[3]) : min;
  if (min > max) throw new CliError(1, `--rating ${text} runs backwards.`, "Use 2-4, not 4-2.");
  return { min, max };
}

function choice<T extends string>(text: string, allowed: readonly T[], option: string): T {
  const found = allowed.find((a) => a === text.toLowerCase());
  if (!found) throw new CliError(1, `--${option} ${text} isn't one of ${allowed.join(", ")}.`);
  return found;
}

/** Whether a photo's history holds a step beyond the one it opened on. */
export function isEdited(state: EditState | undefined): boolean {
  return state !== undefined && state.currentIndex > 0;
}

/** The photo paths on stdin, one per line. */
export function stdinPhotoPaths(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
}

/** The request a verb's parsed arguments make. `specs` are the verb's own photo
 *  positionals; names after `--` and stdin paths are added here. */
export function buildSelectRequest(args: ParsedArgs, specs: string[], stdinPaths: string[]): SelectRequest {
  const o = args.options;
  const filters: PhotoFilters = {};
  if (typeof o.rating === "string") filters.rating = parseRating(o.rating);
  if (typeof o.flag === "string") filters.flag = choice(o.flag, FLAGS, "flag");
  if (typeof o.label === "string") filters.label = choice(o.label, LABELS, "label");
  if (o.edited === true && o.unedited === true) throw new CliError(1, "--edited and --unedited can't be used together.");
  if (o.edited === true) filters.edited = true;
  if (o.unedited === true) filters.edited = false;
  return {
    specs: [...specs, ...args.afterDashDash],
    recursive: o.recursive === true,
    all: o.all === true,
    projectOverride: typeof o.project === "string" ? o.project : null,
    filters,
    stdinPaths,
  };
}

/** The photo paths a command line gives: `-` reads them from stdin. */
export async function stdinPathsOf(ctx: CommandContext, args: ParsedArgs): Promise<string[]> {
  return args.stdinList ? stdinPhotoPaths(await ctx.readStdin()) : [];
}

/** What a photo spec that selected nothing means, as a user-facing error. */
export function missingError(m: Selection<ReadSession>["missing"][number]): CliError {
  switch (m.reason) {
    case "not-found":
      return new CliError(2, `${m.spec} wasn't found.`);
    case "not-in-catalogue":
      return new CliError(2, `${m.spec} isn't in a Safelight catalogue.`, "Open its folder in Safelight first.");
    case "no-match":
      return new CliError(2, `Nothing matches ${m.spec}.`);
  }
}

export interface OnePhoto {
  photo: CatalogPhoto;
  session: ReadSession;
  /** Always call, also after an error. */
  close(): Promise<void>;
}

/** Exactly one photo, for the verbs that show a single photo's edit. */
export async function selectOnePhoto(ctx: CommandContext, args: ParsedArgs, spec: string | undefined): Promise<OnePhoto> {
  const request = buildSelectRequest(args, spec === undefined ? [] : [spec], await stdinPathsOf(ctx, args));
  if (request.specs.length === 0 && request.stdinPaths.length === 0 && !request.all) {
    throw new CliError(1, `Name a photo for ${args.verb ?? "this"}.`, `slu help ${args.verb ?? ""}`.trim() + " shows how.");
  }
  const selection = await ctx.select.read(request);
  const photos = selection.groups.flatMap((g) => g.photos);
  const fail = async (error: CliError): Promise<never> => {
    await selection.close();
    throw error;
  };
  if (selection.missing.length > 0) return fail(missingError(selection.missing[0]));
  if (photos.length === 0) return fail(new CliError(2, "No photo matches."));
  if (photos.length > 1) {
    return fail(new CliError(1, `${args.verb ?? "This verb"} shows one photo at a time, and ${photos.length} matched.`, "Name one photo."));
  }
  return { photo: photos[0], session: selection.groups[0].session, close: () => selection.close() };
}

type Pending =
  | { spec: string; kind: "file"; abs: string; fromGlob: boolean }
  | { spec: string; kind: "folder"; abs: string }
  | { spec: string; kind: "all" };

interface Bucket { ref: ProjectRef; pending: Pending[] }

export function createPhotoSelector(projects: ProjectService, env: CliEnv): PhotoSelector {
  const foldCase = env.platform === "win32" || env.platform === "darwin";
  const key = (text: string) => {
    const nfc = text.normalize("NFC");
    return foldCase ? nfc.toLowerCase() : nfc;
  };
  const relPathOf = (ref: ProjectRef, abs: string): string | null => {
    const rel = relative(ref.root, abs);
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return rel.split(sep).join("/");
  };

  async function resolveRequest<S extends ReadSession>(
    req: SelectRequest,
    open: (ref: ProjectRef) => Promise<S>,
  ): Promise<Selection<S>> {
    const missing: Selection<S>["missing"] = [];
    const buckets = new Map<string, Bucket>();
    const override = req.projectOverride
      ? await projects.find(resolve(env.cwd, req.projectOverride))
      : null;
    if (req.projectOverride && !override) {
      throw new CliError(2, `${req.projectOverride} isn't inside a Safelight project.`, "Open the folder in Safelight once, then try again.");
    }

    const bucketFor = async (abs: string): Promise<Bucket | null> => {
      const ref = override ?? (await projects.find(abs));
      if (!ref) return null;
      const id = key(ref.root);
      let bucket = buckets.get(id);
      if (!bucket) buckets.set(id, (bucket = { ref, pending: [] }));
      return bucket;
    };

    // Specs a glob matched only through files outside any catalogue.
    const uncatalogued = new Map<string, number>();
    const specs = [...req.specs, ...req.stdinPaths];

    for (const spec of specs) {
      const abs = resolve(env.cwd, spec);
      const info = await stat(abs).catch(() => null);
      if (info?.isDirectory()) {
        const bucket = await bucketFor(abs);
        if (bucket) bucket.pending.push({ spec, kind: "folder", abs });
        else missing.push({ spec, reason: "not-in-catalogue" });
      } else if (info) {
        const bucket = await bucketFor(abs);
        if (bucket) bucket.pending.push({ spec, kind: "file", abs, fromGlob: false });
        else missing.push({ spec, reason: "not-in-catalogue" });
      } else if (hasGlob(spec)) {
        const files = await expandGlob(spec, env.cwd, env.platform);
        for (const file of files) {
          const bucket = await bucketFor(file);
          if (bucket) bucket.pending.push({ spec, kind: "file", abs: file, fromGlob: true });
          else uncatalogued.set(spec, (uncatalogued.get(spec) ?? 0) + 1);
        }
        if (files.length === 0) missing.push({ spec, reason: "no-match" });
      } else {
        missing.push({ spec, reason: "not-found" });
      }
    }

    if (req.all || specs.length === 0) {
      const bucket = await bucketFor(env.cwd);
      if (!bucket) missing.push({ spec: req.all ? "--all" : ".", reason: "not-in-catalogue" });
      else bucket.pending.push(req.all ? { spec: "--all", kind: "all" } : { spec: ".", kind: "folder", abs: env.cwd });
    }

    const groups: SelectedGroup<S>[] = [];
    const opened: S[] = [];
    const close = async () => {
      await Promise.allSettled(opened.map((s) => s.close()));
    };

    try {
      const got = new Map<string, number>();
      for (const bucket of buckets.values()) {
        const session = await open(bucket.ref);
        opened.push(session);
        const photos = session.photos();
        const masters = new Map<string, CatalogPhoto>();
        for (const p of photos) {
          const k = key(p.relPath);
          if (!p.copyOf || !masters.has(k)) masters.set(k, p);
        }
        const chosen = new Map<string, CatalogPhoto>();
        const take = (spec: string, p: CatalogPhoto) => {
          if (!chosen.has(p.id)) {
            chosen.set(p.id, p);
            got.set(spec, (got.get(spec) ?? 0) + 1);
          }
        };

        for (const item of bucket.pending) {
          if (item.kind === "all") {
            photos.forEach((p) => take(item.spec, p));
          } else if (item.kind === "folder") {
            const rel = relPathOf(bucket.ref, item.abs);
            if (rel === null) {
              missing.push({ spec: item.spec, reason: "not-in-catalogue" });
              continue;
            }
            const prefix = rel === "" ? "" : key(`${rel}/`);
            for (const p of photos) {
              const k = key(p.relPath);
              if (!k.startsWith(prefix)) continue;
              if (req.recursive || !k.slice(prefix.length).includes("/")) take(item.spec, p);
            }
          } else {
            const rel = relPathOf(bucket.ref, item.abs);
            const photo = rel === null || rel === "" ? undefined : masters.get(key(rel));
            if (photo) take(item.spec, photo);
            else if (item.fromGlob) uncatalogued.set(item.spec, (uncatalogued.get(item.spec) ?? 0) + 1);
            else missing.push({ spec: item.spec, reason: "not-in-catalogue" });
          }
        }

        const kept: CatalogPhoto[] = [];
        for (const p of chosen.values()) if (await passes(session, p, req.filters)) kept.push(p);
        if (kept.length > 0) groups.push({ session, photos: kept });
        else {
          opened.splice(opened.indexOf(session), 1);
          await session.close();
        }
      }

      // A spec that named something real but selected nothing.
      for (const spec of specs) {
        if (got.has(spec) || missing.some((m) => m.spec === spec)) continue;
        missing.push({ spec, reason: uncatalogued.has(spec) ? "not-in-catalogue" : "no-match" });
      }
      if ((req.all || specs.length === 0) && !got.has(req.all ? "--all" : ".") && !missing.some((m) => m.spec === (req.all ? "--all" : "."))) {
        missing.push({ spec: req.all ? "--all" : ".", reason: "no-match" });
      }
    } catch (error) {
      await close();
      throw error;
    }

    return { groups, missing, close };
  }

  return {
    read: (req) => resolveRequest<ReadSession>(req, (ref) => projects.openRead(ref)),
    write: (req, waitSeconds) => resolveRequest<WriteSession>(req, (ref) => projects.openWrite(ref, waitSeconds)),
  };
}

async function passes(session: ReadSession, photo: CatalogPhoto, f: PhotoFilters): Promise<boolean> {
  if (f.rating && (photo.rating < f.rating.min || photo.rating > f.rating.max)) return false;
  if (f.flag && photo.flag !== f.flag) return false;
  if (f.label && photo.colorLabel !== f.label) return false;
  if (f.edited !== undefined && isEdited(await session.edit(photo.id)) !== f.edited) return false;
  return true;
}
