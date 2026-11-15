// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PHOTO_OPTIONS } from "../args";
import { thumbFrames } from "../engine-client";
import {
  LIST_SORTS,
  LIST_STATES,
  listPaths,
  type ListedFolder,
  type ListedPhoto,
  type Listing,
  type ListProblem,
  type ListSort,
} from "../listing";
import { formatPhotoGrid, gridPictureFromJpeg, gridPictureFromRgba } from "../output";
import type { FolderNode, GridCell, GridPicture, Listing as ListingView, ListingSummary, PhotoRow } from "../output/types";
import { newRequestId, projectWire, withLamp } from "../preview";
import { previewFileFor } from "../project";
import { buildSelectRequest, importFix, stdinPathsOf } from "../select";
import { speaksIterm } from "../terminal-image";
import { CliError, COMMAND, type CommandContext, type CommandSpec, type ExitCode, type ParsedArgs } from "../types";

/** The stored previews are fitted inside this for the contact sheet's blocks: more than a cell's 14 × 14 pixels, to average. */
const THUMB_EDGE = 64;

function sortOf(args: ParsedArgs): ListSort {
  const text = args.options.sort;
  if (text === undefined) return "name";
  const found = LIST_SORTS.find((s) => s === text);
  if (!found) throw new CliError(1, `--sort ${String(text)} isn't one of ${LIST_SORTS.join(", ")}.`);
  return found;
}

function depthOf(args: ParsedArgs): number {
  const depth = args.options.depth;
  if (depth === undefined) return Infinity;
  if (args.options.tree !== true) throw new CliError(1, "--depth goes with --tree.");
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0) throw new CliError(1, "--depth is a whole number of levels, 0 or more.");
  return depth;
}

const problemError = (p: ListProblem): CliError => {
  switch (p.reason) {
    case "not-found": return new CliError(2, `${p.spec} wasn't found.`);
    case "no-match": return new CliError(2, `Nothing matches ${p.spec}.`);
    case "not-a-photo": return new CliError(2, `${p.spec} isn't a photo Safelight opens.`);
  }
};

function photoJson(p: ListedPhoto): Record<string, unknown> {
  const head = { path: p.path, relPath: p.relPath, state: p.state };
  const photo = p.photo;
  if (!photo) return { ...head, fileSize: p.fileSize };
  return {
    ...head,
    id: photo.id,
    rating: photo.rating,
    flag: photo.flag,
    label: photo.colorLabel,
    edited: p.edited,
    step: p.step ?? 0,
    keywords: photo.keywords,
    width: photo.width,
    height: photo.height,
    fileSize: p.fileSize,
    dateCreated: photo.dateCreated,
    pending: photo.metadataPending === true,
  };
}

const folderJson = (f: ListedFolder, tree: boolean): Record<string, unknown> => ({
  path: f.path,
  relPath: f.relPath,
  photos: f.photos,
  imported: f.imported,
  edited: f.edited,
  picks: f.picks,
  new: f.new,
  ...(tree ? { depth: f.depth } : {}),
});

function sizeText(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !(bytes > 0)) return undefined;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

function photoRow(p: ListedPhoto): PhotoRow {
  return {
    name: p.name,
    rating: p.photo?.rating ?? 0,
    flag: p.photo?.flag ?? "none",
    label: p.photo?.colorLabel ?? "none",
    edited: p.edited,
    state: p.state,
    // A file the catalogue has no record of still has a size; a missing or removed one says so instead.
    ...((p.state === "imported" || p.state === "new") && { size: sizeText(p.fileSize) }),
  };
}

/** "Iceland 2026 › Day 2": the project and the folder in it, or outside a project the folder alone. */
function titleOf(listing: Listing): string {
  if (!listing.project) return path.basename(listing.folder) || listing.folder;
  const name = path.basename(listing.project.root) || listing.project.root;
  const rel = path.relative(listing.project.root, listing.folder);
  return rel === "" || rel.startsWith("..") ? name : [name, ...rel.split(path.sep)].join(" › ");
}

function summaryOf(listing: Listing): ListingSummary {
  const shown = listing.photos.filter((p) => p.state !== "removed");
  return {
    title: titleOf(listing),
    photos: shown.length,
    edited: shown.filter((p) => p.edited).length,
    notImported: shown.filter((p) => p.state === "new").length,
    otherFiles: listing.otherFiles,
  };
}

/** The import that takes in what is listed as not imported. */
function fixOf(listing: Listing, cwd: string, recursive: boolean): ListingView["fix"] {
  if (!listing.project) return listing.photos.length > 0 ? { command: `${COMMAND} import`, does: "starts a catalogue here." } : undefined;
  const fresh = listing.photos.filter((p) => p.state === "new").length;
  if (fresh === 0) return undefined;
  const where = path.relative(cwd, listing.folder) || ".";
  return { command: `${importFix(where)}${recursive ? " -r" : ""}`, does: `imports the ${plural(fresh, "new photo")}.` };
}

/** The tree rows, listed parent first, as nested folders: one tree for each folder listed. */
function treesOf(folders: readonly ListedFolder[]): { node: FolderNode; summary: ListingSummary }[] {
  type Building = { row: ListedFolder; children: Building[] };
  const roots: Building[] = [];
  const open: Building[] = [];
  for (const row of folders) {
    const node: Building = { row, children: [] };
    while (open.length > 0 && open[open.length - 1].row.depth >= row.depth) open.pop();
    if (open.length === 0) roots.push(node);
    else open[open.length - 1].children.push(node);
    open.push(node);
  }
  const toNode = ({ row, children }: Building): FolderNode => ({
    name: row.depth === 0 ? row.name : row.name.split("/").pop() ?? row.name,
    path: row.name,
    photos: row.photos,
    edited: row.edited,
    notImported: row.new,
    children: children.map(toNode),
  });
  return roots.map((root) => ({
    node: toNode(root),
    summary: { title: root.row.name, photos: root.row.photos, edited: root.row.edited, notImported: root.row.new },
  }));
}

/** Each imported photo's grid picture: the stored JPEG as it is on iTerm2, else the engine's
 *  decode of it as blocks. A photo with none, or an engine that won't start, leaves its cell bare. */
async function gridPictures(ctx: CommandContext, photos: readonly ListedPhoto[]): Promise<Map<ListedPhoto, GridPicture>> {
  const pictures = new Map<ListedPhoto, GridPicture>();
  const imported = photos.flatMap((p) => (p.state === "imported" && p.photo && p.project ? [{ listed: p, photo: p.photo, project: p.project }] : []));
  if (imported.length === 0) return pictures;

  if (speaksIterm(ctx.env)) {
    for (const { listed, photo, project } of imported) {
      const file = previewFileFor(project.workingDir, photo);
      if (file === null) continue;
      try {
        pictures.set(listed, gridPictureFromJpeg(await readFile(file), { width: photo.width, height: photo.height }));
      } catch {
        // A preview that can't be read leaves its cell bare, as one never made does.
      }
    }
    return pictures;
  }

  const byProject = new Map<string, typeof imported>();
  for (const item of imported) byProject.set(item.project.root, [...(byProject.get(item.project.root) ?? []), item]);
  try {
    for (const group of byProject.values()) {
      const byId = new Map(group.map((item) => [item.photo.id, item.listed]));
      const thumbs = thumbFrames(ctx.engine(), {
        id: newRequestId(),
        type: "thumbs",
        project: projectWire(group[0].project),
        photoIds: [...byId.keys()],
        edge: THUMB_EDGE,
        encoding: "rgba",
      });
      for await (const thumb of withLamp(ctx.out, "Starting the engine…", thumbs)) {
        const listed = byId.get(thumb.photoId);
        if ("error" in thumb || !listed) continue;
        const picture = gridPictureFromRgba({ width: thumb.width, height: thumb.height, rgba: thumb.bytes }, ctx.out.options);
        if (picture) pictures.set(listed, picture);
      }
    }
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    ctx.out.warn({ message: error.message, hint: "The contact sheet is drawn without its pictures." });
  } finally {
    await ctx.engine().shutdown();
  }
  return pictures;
}

/** The contact sheet, or false where stdout gets the plain list instead. */
async function printGrid(ctx: CommandContext, photos: readonly ListedPhoto[]): Promise<boolean> {
  const cells: GridCell[] = photos.map(photoRow);
  if (cells.length === 0 || formatPhotoGrid(cells, ctx.out.options) === null) return false;
  const pictures = await gridPictures(ctx, photos);
  const sheet = formatPhotoGrid(photos.map((p, i) => {
    const picture = pictures.get(p);
    return picture ? { ...cells[i], picture } : cells[i];
  }), ctx.out.options);
  if (sheet !== null) ctx.out.print(sheet);
  return true;
}

export const lsCommand: CommandSpec = {
  verb: "ls",
  group: "Library",
  summary: "Lists what is in a folder: folders with counts, and photos with their catalogue state.",
  usage: "ls [photos|folders…] [options]",
  examples: [
    `${COMMAND} ls`,
    `${COMMAND} ls "Day 2" --new`,
    `${COMMAND} ls --tree --depth 2`,
    `${COMMAND} ls --grid --flag pick`,
    `${COMMAND} ls -r --rating 4+ --json`,
  ],
  options: [
    ...PHOTO_OPTIONS,
    { name: "tree", kind: "flag", summary: "Show the folders alone, nested, with counts." },
    { name: "depth", kind: "number", summary: "With --tree, stop after this many levels." },
    { name: "grid", kind: "flag", summary: "Show the photos as a contact sheet, with their pictures." },
    { name: "sort", kind: "string", summary: `Order by ${LIST_SORTS.join(", ")} (lowest first).` },
    { name: "reverse", kind: "flag", summary: "Reverse the order." },
    { name: "new", kind: "flag", summary: "Only photos on disk the catalogue doesn't hold." },
    { name: "imported", kind: "flag", summary: "Only photos in the catalogue." },
    { name: "removed", kind: "flag", summary: "Only photos removed from the catalogue, their files still here." },
    { name: "missing", kind: "flag", summary: "Only photos in the catalogue whose file is gone." },
  ],
  writes: false,
  async run(ctx: CommandContext, args) {
    const select = buildSelectRequest(args, args.positionals, await stdinPathsOf(ctx, args));
    const tree = args.options.tree === true;
    if (tree && args.options.grid === true) throw new CliError(1, "--tree shows folders and --grid photos; use one.");
    const req = {
      specs: select.specs,
      cwd: ctx.env.cwd,
      platform: ctx.env.platform,
      recursive: select.recursive,
      tree,
      depth: depthOf(args),
      sort: sortOf(args),
      reverse: args.options.reverse === true,
      states: LIST_STATES.filter((s) => args.options[s] === true),
      filters: select.filters,
      all: select.all,
      projectOverride: select.projectOverride,
    };
    const listing = await listPaths({ env: ctx.env, projects: ctx.projects }, req);

    if (!ctx.json) {
      if (tree) {
        const trees = treesOf(listing.folders);
        if (trees.length > 0) ctx.out.print(trees.map((t) => ctx.out.folderTree(t.node, t.summary, req.depth)).join("\n\n"));
      } else if (!(args.options.grid === true && (await printGrid(ctx, listing.photos)))) {
        const text = ctx.out.listing({
          summary: summaryOf(listing),
          folders: listing.folders.map((f) => ({ name: f.name, photos: f.photos, edited: f.edited, notImported: f.new })),
          photos: listing.photos.map(photoRow),
          fix: fixOf(listing, ctx.env.cwd, req.recursive),
        });
        if (text !== "") ctx.out.print(text);
      }
    }
    const failed = new Set(listing.problems.map((p) => p.spec));
    for (const p of listing.problems) {
      const e = problemError(p);
      ctx.out.error({ message: e.message, hint: e.hint });
    }
    const asked = Math.max(1, select.specs.length + select.stdinPaths.length);
    const code: ExitCode = failed.size === 0 ? 0 : failed.size < asked ? 6 : 2;
    return {
      code,
      json: {
        slu: 1,
        folder: listing.folder,
        project: listing.project && {
          root: listing.project.root,
          workingDir: listing.project.workingDir,
          location: listing.project.location,
        },
        folders: listing.folders.map((f) => folderJson(f, tree)),
        photos: listing.photos.map(photoJson),
        otherFiles: listing.otherFiles,
      },
    };
  },
};
