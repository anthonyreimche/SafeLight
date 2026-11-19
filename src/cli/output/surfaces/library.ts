// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The library on a terminal: `ls` as folders then photos, `ls --tree`,
// keywords, and what `forget` is about to drop. Amber is kept for what there
// is to act on: photos not imported yet, files that have gone.

import { panel } from "../components/panel";
import { grid } from "../components/table";
import { treeRows } from "../components/tree";
import { flowChunks, wrapText } from "../format";
import { flowDots, joinDots, paintCommand } from "../look";
import type { Look } from "../look";
import type { FolderNode, FolderRow, ForgetRisk, KeywordRow, Listing, ListingSummary, PhotoKeywords } from "../types";
import { cells, clip, clipStart } from "../width";
import { photoList } from "./photos";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const photos = (n: number): string => plural(n, "photo", "photos");

const NAME_MIN = 12;
const CARD_WIDTH = 68;
/** Names listed in a sentence before it says how many more there are. */
export const MOST_NAMES = 5;

/** "a, b, c and 4 more": a list that stays a line or two however long it is. */
export function someNames(names: readonly string[], most = MOST_NAMES): string {
  if (names.length <= most) return names.join(", ");
  return `${names.slice(0, most).join(", ")} and ${names.length - most} more`;
}

export function listingSummary(s: ListingSummary, look: Look): string[] {
  const { glyphs, theme } = look;
  const muted = (text: string): string => theme.paint("muted", text);
  return flowDots([
    theme.paint("strong", clipStart(glyphs.fold(s.title), Math.max(NAME_MIN, look.width - 24), glyphs.ellipsis)),
    muted(photos(s.photos)),
    s.edited > 0 ? muted(`${s.edited} edited`) : "",
    s.notImported > 0 ? theme.paint("amber", `${s.notImported} not imported`) : "",
    s.otherFiles ? muted(plural(s.otherFiles, "other file", "other files")) : "",
  ], look.width, look);
}

/** Under this many columns a folder row is its photos and what isn't imported, said short. */
const COUNTS_FROM = 60;

function folderCounts(folder: FolderRow, look: Look): string[] {
  const { theme } = look;
  const narrow = look.columns < COUNTS_FROM;
  return [
    folder.edited > 0 && !narrow ? theme.paint("muted", `${folder.edited} edited`) : "",
    folder.notImported > 0 ? theme.paint("amber", `${folder.notImported} ${narrow ? "new" : "not imported"}`) : "",
  ];
}

function folderRows(folders: readonly FolderRow[], look: Look): string[] {
  const { glyphs, theme } = look;
  const counts = folders.map((folder) => [look.columns < COUNTS_FROM ? String(folder.photos) : photos(folder.photos), ...folderCounts(folder, look)]);
  const taken = Math.max(0, ...grid(counts).map(cells));
  const room = Math.max(NAME_MIN, look.width - taken - 4);
  return grid(folders.map((folder, i) => [
    theme.paint("strong", clip(glyphs.fold(folder.name), room, glyphs.ellipsis)) + theme.paint("faint", "/"),
    ...counts[i],
  ]));
}

export function listingLines(l: Listing, look: Look): string[] {
  const { theme } = look;
  const blocks = [
    l.folders.length > 0 ? folderRows(l.folders, look) : [],
    l.photos.length > 0 ? photoList(l.photos, look) : [],
  ].filter((block) => block.length > 0);
  if (blocks.length === 0) blocks.push([theme.paint("muted", "No photos here.")]);
  const fix = l.fix ? ["", `${paintCommand(l.fix.command, look)} ${theme.paint("muted", look.glyphs.fold(l.fix.does))}`] : [];
  return [...listingSummary(l.summary, look), ...blocks.flatMap((block) => ["", ...block]), ...fix];
}

/** Folders only, nested, each with the photos directly in it. */
export function folderTreeLines(root: FolderNode, summary: ListingSummary, look: Look, depth = Infinity): string[] {
  const { glyphs } = look;
  const rows = treeRows(root, look, depth);
  const counts = rows.map(({ node }) => [String(node.photos), ...folderCounts(node, look)]);
  const taken = Math.max(0, ...grid(counts).map(cells));
  return [
    ...listingSummary(summary, look),
    "",
    ...grid(rows.map(({ node, lines }, i) => {
      const room = Math.max(NAME_MIN, look.width - taken - 3 - cells(lines));
      return [lines + clip(glyphs.fold(node.name), room, glyphs.ellipsis), ...counts[i]];
    }), [{}, { align: "right" }]),
  ];
}

export function keywordTableLines(rows: readonly KeywordRow[], look: Look): string[] {
  const { glyphs, theme } = look;
  if (rows.length === 0) return [theme.paint("muted", "No keywords.")];
  const room = Math.max(NAME_MIN, look.width - 3 - Math.max(...rows.map((r) => String(r.count).length)));
  return grid(
    rows.map((r) => [clip(glyphs.fold(r.keyword), room, glyphs.ellipsis), theme.paint("muted", String(r.count))]),
    [{}, { align: "right" }],
  );
}

/** Each photo with its keywords after it; a long list continues under its own first word. */
export function keywordListLines(rows: readonly PhotoKeywords[], look: Look): string[] {
  const { glyphs, theme } = look;
  const names = rows.map((r) => clipStart(r.photo, Math.max(NAME_MIN, Math.floor(look.width / 2)), glyphs.ellipsis));
  const column = Math.max(0, ...names.map(cells)) + 3;
  const room = Math.max(NAME_MIN, look.width - column);
  return rows.flatMap((r, i) => {
    const words = r.keywords.length === 0
      ? [theme.paint("faint", glyphs.none)]
      : flowChunks(r.keywords.map((word) => clip(glyphs.fold(word), room, glyphs.ellipsis)), glyphs.dot, room).map((line) => joinDots(line, look));
    return words.map((line, at) => (at === 0 ? names[i] + " ".repeat(column - cells(names[i])) : " ".repeat(column)) + line);
  });
}

const forgetSentence = (risk: ForgetRisk): string => (risk.edited.length === risk.photos
  ? risk.photos === 1 ? "It has edits that would be lost." : `${risk.photos === 2 ? "Both" : `All ${risk.photos}`} have edits that would be lost.`
  : `${risk.edited.length} of these ${risk.photos} have edits that would be lost.`);

/** What `forget` says when it stops short: plain sentences, for either look. */
export function forgetMessage(risk: ForgetRisk): { message: string; hint: string } {
  return { message: forgetSentence(risk), hint: "Add --yes to remove them anyway." };
}

/** The card a "Forget them?" question sits under: what goes, what stays, and which photos lose edits. */
export function forgetCard(risk: ForgetRisk, look: Look): string[] {
  const { glyphs, theme } = look;
  const width = Math.min(CARD_WIDTH, look.width);
  const inner = width - 4;
  const lost = risk.edited.length > 0
    ? [
      "",
      ...wrapText(forgetSentence(risk), inner - 2).map((line, i) => `${i === 0 ? theme.paint("amber", glyphs.warn) : " "} ${line}`),
      ...wrapText(glyphs.fold(someNames(risk.edited)), inner - 2).map((line) => `  ${line}`),
    ]
    : [];
  return panel({
    title: theme.paint("strong", `Remove ${photos(risk.photos)} from the catalogue`),
    body: [
      ...wrapText("Their records, edit history and previews go.", inner),
      ...wrapText("The files stay on disk and aren't imported again.", inner).map((line) => theme.paint("muted", line)),
      ...lost,
    ],
    width,
    tone: "amber",
  }, look);
}
