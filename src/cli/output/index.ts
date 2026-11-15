// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `safelight` looks like. The look is the darkroom's: quiet text, faint for
// what's secondary, one amber for what changed or needs a glance, red for
// errors only. Builders are pure; the writers at the bottom are the only
// code that touches a stream.

import type { ValueInfo } from "../types";
import { flowChunks, formatBytes, formatMegapixels, formatRange, formatValue, wrapText } from "./format";
import { help, verbHelp } from "./help";
import { createPalette, glyphsFor } from "./palette";
import type { Style } from "./palette";
import { createProgressWriter, progressText } from "./progress";
import { doctor, extensionTable, historyList, photoTable, searchTable, toolTable } from "./table";
import type {
  BatchSummary,
  ExportedLine,
  Output,
  OutputOptions,
  OutputStreams,
  PhotoHeader,
  PreviewCaption,
  Problem,
  ProgressState,
  ResultLine,
} from "./types";
import { COMMAND } from "../types";

export type * from "./types";
export { formatHome, formatPrompt, formatReplNote } from "./home";

type Env = Readonly<Record<string, string | undefined>>;

const MIN_WIDTH = 40;
const PREFIX = `${COMMAND}: `;

function streamColour(stream: NodeJS.WriteStream, env: Env): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined && force !== "0" && force !== "false") return true;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.TERM === "dumb") return false;
  return stream.isTTY === true;
}

/**
 * Whether "…", "−" and "✱" will arrive intact. The old Windows console has no
 * font fallback, and piped Windows output is re-read in the console's legacy
 * code page, so both get ASCII.
 */
function rendersUnicode(streams: OutputStreams, env: Env): boolean {
  if (env.TERM === "dumb" || env.TERM === "linux") return false;
  if (env.OS === "Windows_NT") {
    const modern = env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined || env.TERM !== undefined || env.ConEmuANSI === "ON";
    return modern && streams.stdout.isTTY === true;
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return locale === "" || /utf-?8/i.test(locale);
}

/** Terminals that say they take 24-bit colour. The rest get the 256-colour reds. */
function rendersTrueColour(env: Env): boolean {
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit") return true;
  if (env.WT_SESSION !== undefined) return true;
  return /^(iTerm\.app|vscode|WezTerm|ghostty)$/.test(env.TERM_PROGRAM ?? "") || /kitty|ghostty|direct/.test(env.TERM ?? "");
}

export function resolveOutputOptions(
  streams: OutputStreams,
  env: Readonly<Record<string, string | undefined>>,
  verbosity: OutputOptions["verbosity"],
): OutputOptions {
  return {
    colour: { stdout: streamColour(streams.stdout, env), stderr: streamColour(streams.stderr, env) },
    unicode: rendersUnicode(streams, env),
    width: streams.stdout.columns > 0 ? streams.stdout.columns : 80,
    trueColour: rendersTrueColour(env),
    verbosity,
  };
}

export function createOutput(streams: OutputStreams, options: OutputOptions): Output {
  const glyphs = glyphsFor(options.unicode);
  const width = Math.max(MIN_WIDTH, options.width);
  const onStdout: Style = { palette: createPalette(options.colour.stdout), glyphs, width };
  const onStderr: Style = { palette: createPalette(options.colour.stderr), glyphs, width };
  const { palette } = onStdout;
  const dot = palette.dim(glyphs.dot);
  const quiet = options.verbosity === "quiet";
  const verbose = options.verbosity === "verbose" || options.verbosity === "debug";
  const progressLine = createProgressWriter(streams.stderr);

  const problem = (kind: "error" | "warning", p: Problem): string => {
    const tone = kind === "error" ? onStderr.palette.error : onStderr.palette.accent;
    const indent = " ".repeat(PREFIX.length);
    const room = width - PREFIX.length;
    const message = wrapText(glyphs.fold(p.message), room).map((line, i) => (i === 0 ? `${tone(`${COMMAND}:`)} ${line}` : indent + line));
    const hint = p.hint ? wrapText(glyphs.fold(p.hint), room).map((line) => indent + onStderr.palette.dim(line)) : [];
    return [...message, ...hint].join("\n");
  };

  // A progress line in the way is wiped first, so nothing is written onto it.
  const write = (stream: NodeJS.WriteStream, text: string): void => {
    progressLine.clear();
    stream.write(text.endsWith("\n") ? text : `${text}\n`);
  };

  return {
    options,
    formatValue: (info: ValueInfo, value: unknown) => formatValue(info, value, glyphs),
    formatRange: (info: ValueInfo) => formatRange(info, glyphs),
    photoHeader(h: PhotoHeader) {
      const facts: string[] = [];
      if (h.camera) facts.push(h.camera);
      if (h.megapixels !== undefined) facts.push(formatMegapixels(h.megapixels));
      facts.push(h.edited ? "edited" : "not edited", `process version ${h.processVersion}`);
      return flowChunks([h.name, ...facts], glyphs.dot, width)
        .map((line, i) => line.map((part, at) => (i === 0 && at === 0 ? palette.heading(part) : part)).join(dot))
        .join("\n");
    },
    toolTable: (rows) => toolTable(rows, onStdout),
    photoTable: (rows) => photoTable(rows, onStdout),
    extensionTable: (rows) => extensionTable(rows, onStdout),
    searchTable: (rows) => searchTable(rows, onStdout),
    historyList: (rows) => historyList(rows, onStdout),
    resultLine(r: ResultLine) {
      const changes = r.changes.map((c) => glyphs.fold(c.value ? `${c.label} ${c.value}` : c.label));
      const note = r.note ? `  ${palette.dim(glyphs.fold(r.note))}` : "";
      const step = r.step !== undefined ? `   ${palette.dim(`(step ${r.step})`)}` : "";
      if (changes.length === 0) return r.photo + note + step;
      // Changes that don't fit continue under the first one, or near the margin when the name is long.
      const under = [...r.photo].length + 2;
      const indent = width - under >= 30 ? under : 4;
      const lines = flowChunks(changes, glyphs.dot, width - indent).map((line) => line.join(dot));
      return `${r.photo}  ${lines.join(`\n${" ".repeat(indent)}`)}${note}${step}`;
    },
    summary(s: BatchSummary) {
      const parts = [`${s.photos} ${s.photos === 1 ? "photo" : "photos"}`];
      if (s.stepEach) parts.push("1 step each");
      if (s.failed > 0) parts.push(palette.error(`${s.failed} failed`));
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
      return parts.join(dot);
    },
    exported(e: ExportedLine) {
      const facts = [`${e.width}${glyphs.times}${e.height}`, e.colourSpace, formatBytes(e.bytes)];
      return `${e.path}  ${palette.dim(facts.join(glyphs.dot))}`;
    },
    help: (s) => help(s, onStdout),
    verbHelp: (v) => verbHelp(v, onStdout),
    doctor: (items) => doctor(items, onStdout),
    previewCaption(c: PreviewCaption) {
      if (c.mode === "none") return palette.accent("No preview: this terminal can't show images.");
      const facts: string[] = [];
      if (verbose) facts.push(`${c.width}${glyphs.times}${c.height}`);
      if (c.ms !== undefined) facts.push(`${(c.ms / 1000).toFixed(1)} s`);
      if (c.trueColour) return palette.dim([c.mode, "24-bit", ...facts].join(glyphs.dot));
      const caution = palette.accent("reduced colour, so tones here are approximate");
      return [palette.dim(c.mode), caution, ...(facts.length > 0 ? [palette.dim(facts.join(glyphs.dot))] : [])].join(dot);
    },
    problem,
    progressText: (p: ProgressState) => progressText(p, onStderr),
    print(text: string) {
      if (!quiet) write(streams.stdout, text);
    },
    json(doc: unknown) {
      write(streams.stdout, JSON.stringify(doc, null, 2));
    },
    warn(p: Problem) {
      if (!quiet) write(streams.stderr, problem("warning", p));
    },
    error(p: Problem) {
      write(streams.stderr, problem("error", p));
    },
    info(text: string) {
      if (verbose) write(streams.stderr, onStderr.palette.dim(text));
    },
    progress(p: ProgressState | null) {
      if (p) progressLine.show(progressText(p, onStderr));
      else progressLine.clear();
    },
    writeRaw(bytes: Uint8Array) {
      progressLine.clear();
      streams.stdout.write(bytes);
    },
  };
}
