// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The library commands off a terminal. Lists are one entry a line with tabs
// between fields, so `cut` and `awk` take them as they are; what a command
// says about itself is plain sentences.

import type { Style } from "./palette";
import { importSummaryParts } from "./surfaces/import";
import type { ExportSummary, FolderNode, FolderRow, ImportPlan, ImportSummary, ImportedFile, KeywordRow, Listing, PhotoKeywords, PhotoRow } from "./types";

const TAB = "\t";

const folderLine = (folder: FolderRow, path: string): string => ["folder", folder.photos, `${path}/`].join(TAB);

/** state, rating, flag, label, edited, path. A file with no record has the four fields between left empty. */
function photoLine(r: PhotoRow): string {
  const state = r.state ?? "imported";
  const known = state === "imported" || state === "missing";
  return [
    state,
    known ? r.rating : "",
    known ? r.flag : "",
    known ? (r.label === "" ? "none" : r.label) : "",
    known && r.edited ? "edited" : "",
    r.name,
  ].join(TAB);
}

export function listing(l: Listing): string {
  return [...l.folders.map((folder) => folderLine(folder, folder.name)), ...l.photos.map(photoLine)].join("\n");
}

export function folderTree(root: FolderNode, depth = Infinity): string {
  const lines: string[] = [];
  const walk = (node: FolderNode, level: number): void => {
    lines.push(folderLine(node, node.path));
    if (level < depth) node.children.forEach((child) => walk(child, level + 1));
  };
  walk(root, 0);
  return lines.join("\n");
}

export function keywordTable(rows: readonly KeywordRow[]): string {
  return rows.map((r) => [r.keyword, r.count].join(TAB)).join("\n");
}

export function keywordList(rows: readonly PhotoKeywords[]): string {
  return rows.map((r) => [r.photo, r.keywords.join(", ")].join(TAB)).join("\n");
}

/** The batch summary's own bytes: what export ended with before it had a closing line of its own. */
export function exportSummary(s: ExportSummary, style: Style): string {
  const { palette, glyphs } = style;
  const total = s.exported + s.failed.length;
  const parts = [`${total} ${total === 1 ? "photo" : "photos"}`];
  if (s.failed.length > 0) parts.push(palette.error(`${s.failed.length} failed`));
  return parts.join(palette.dim(glyphs.dot));
}

export const DRY_RUN_NOTE = "Dry run: nothing was changed.";

/** The line saying where a new catalogue goes, in the tense of a real or a dry run. */
export function startedLine(p: ImportPlan): string {
  const verb = p.dryRun ? "Would start" : "Starting";
  return p.started?.external
    ? `${verb} a catalogue for ${p.project}, kept separately at ${p.started.workingDir} because the folder is read-only.`
    : `${verb} a catalogue for ${p.project} in ${p.started?.workingDir ?? ""}`;
}

export function importPlan(p: ImportPlan, style: Style): string {
  const { glyphs } = style;
  const facts = [`${p.dryRun ? "Would import" : "Importing"} into ${p.project}`, `${p.newFiles} new`];
  if (p.gone) facts.push(`${p.gone} ${p.gone === 1 ? "file" : "files"} gone`);
  const started = p.started ? [startedLine(p)] : [];
  const dry = p.dryRun ? [DRY_RUN_NOTE] : [];
  return [...started, facts.join(glyphs.dot), ...dry].map(glyphs.fold).join("\n");
}

export function importedFile(f: ImportedFile): string {
  return [f.state, f.path].join(TAB);
}

export function importSummary(s: ImportSummary, style: Style): string {
  return importSummaryParts(s, "->")
    .map((part) => style.glyphs.fold(part.names ? `${part.text}: ${part.names.join(", ")}` : part.text))
    .join("\n");
}
