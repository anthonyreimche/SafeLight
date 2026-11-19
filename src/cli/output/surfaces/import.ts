// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `import` on a terminal: what it is about to do, a row a file as each
// lands, and what it came to. Its live region is export's, in two phases:
// the files, each named while it is read, then the RAWs' camera data.

import { elapsedText } from "../components/lamp";
import { wrapText } from "../format";
import { flowDots } from "../look";
import type { Look } from "../look";
import type { ImportPlan, ImportProgress, ImportSummary, ImportedFile, ProgressState } from "../types";
import { clipStart, padEnd } from "../width";
import { someNames } from "./library";
import { DRY_RUN_NOTE, startedLine } from "../library";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function importPlanLines(p: ImportPlan, look: Look): string[] {
  const { glyphs, theme } = look;
  const muted = (text: string): string => theme.paint("muted", text);
  const started = p.started
    ? wrapText(startedLine(p), look.width).map((line) => muted(glyphs.fold(line)))
    : [];
  return [
    ...started,
    ...flowDots([
      `${muted(p.dryRun ? "Would import into" : "Importing into")} ${glyphs.fold(p.project)}`,
      muted(`${p.newFiles} new`),
      p.gone ? theme.paint("amber", plural(p.gone, "file gone", "files gone")) : "",
    ], look.width, look),
    ...(p.dryRun ? [theme.paint("amber", DRY_RUN_NOTE)] : []),
  ];
}

const NOTE: Record<ImportedFile["state"], string> = { ok: "", "no-preview": "no preview yet", failed: "couldn't be read" };

export function importedFileLine(f: ImportedFile, look: Look): string {
  const { glyphs, theme } = look;
  const failed = f.state === "failed";
  const note = glyphs.fold(failed ? f.error ?? NOTE.failed : NOTE[f.state]);
  const path = clipStart(f.path, Math.max(12, look.width - 5 - note.length), glyphs.ellipsis);
  const mark = failed ? theme.paint("lamp", glyphs.fail) : theme.paint("ok", glyphs.ok);
  return `${mark} ${path}${note ? `   ${failed ? note : theme.paint("muted", note)}` : ""}`;
}

/** The import's place as the live region's state: export's frame for the files, the one-line bar for the camera data. */
export function importProgressState(p: ImportProgress): ProgressState {
  if (p.phase === "camera-data") return { label: "Reading camera data", done: p.done, total: p.total, startedAt: p.startedAt };
  return {
    label: "reading",
    done: p.done,
    total: p.total,
    startedAt: p.startedAt,
    items: p.reading.map((name) => ({ name, state: "working" as const })),
  };
}

/** The sentences an import ends with, each with the mark it wears on a terminal. */
export function importSummaryParts(s: ImportSummary, arrow: string): { mark: "ok" | "warn" | "fail" | "note"; text: string; names?: readonly string[] }[] {
  const took = s.ms !== undefined ? ` · ${elapsedText(s.ms)}` : "";
  const parts: ReturnType<typeof importSummaryParts> = [];
  if (s.stopped === "safelight-opened") {
    parts.push({ mark: "warn", text: `Safelight opened ${s.project}, so the import stopped after ${s.imported} of ${s.total}. Safelight imports the rest itself.` });
  } else if (s.stopped === "interrupted") {
    parts.push({ mark: "warn", text: `Stopped after ${s.imported} of ${s.total}. import carries on from there.` });
  } else if (s.imported > 0 || s.failed.length === 0) {
    parts.push({ mark: "ok", text: s.imported > 0 ? `${s.imported} imported into ${s.project}${took}` : `Nothing new to import into ${s.project}${took}` });
  }
  if (s.failed.length > 0) parts.push({ mark: "fail", text: `${s.failed.length} couldn't be read`, names: s.failed });
  if (s.dropped.length > 0) {
    const edited = s.dropped.filter((photo) => photo.edited).length;
    const lost = edited > 0 ? ` (${edited} had edits)` : "";
    parts.push({
      mark: "note",
      text: `${plural(s.dropped.length, "photo whose file is gone", "photos whose files are gone")} left the catalogue${lost}`,
      names: s.dropped.map((photo) => photo.relPath),
    });
  }
  if (s.moved.length > 0) {
    parts.push({
      mark: "note",
      text: `${plural(s.moved.length, "photo was", "photos were")} found under a new name`,
      names: s.moved.map((move) => `${move.from} ${arrow} ${move.to}`),
    });
  }
  if (s.pending > 0) {
    parts.push({
      mark: "note",
      text: `${plural(s.pending, "photo's", "photos'")} camera data is still to read; Safelight reads it in the background, or run import again.`,
    });
  }
  return parts;
}

export function importSummaryLines(s: ImportSummary, look: Look): string[] {
  const { glyphs, theme } = look;
  const marks = {
    ok: theme.paint("ok", glyphs.ok),
    warn: theme.paint("amber", glyphs.warn),
    fail: theme.paint("lamp", glyphs.fail),
    note: theme.paint("faint", glyphs.none),
  };
  const pad = " ".repeat(glyphs.ok.length);
  return importSummaryParts(s, glyphs.arrow).flatMap((part) => {
    const text = part.names ? `${part.text}: ${someNames(part.names)}` : part.text;
    return wrapText(glyphs.fold(text), look.width - pad.length - 1).map((line, i) => {
      const body = part.mark === "note" ? theme.paint("muted", line) : line;
      return `${i === 0 ? padEnd(marks[part.mark], pad.length) : pad} ${body}`;
    });
  });
}
