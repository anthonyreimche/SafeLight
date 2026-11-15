// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `safelight` looks like. The look is the darkroom's: quiet text, faint for
// what's secondary, one amber for what changed or needs a glance, red for
// errors only. Builders are pure; the writers at the bottom are the only
// code that touches a stream.
//
// There are two looks. A stream that is a terminal gets the designed one:
// slider bars, cards, a live region, all from src/cli/output/surfaces. Any
// other stream (a pipe, a file, --json) gets the plain text, byte for byte
// what it always was.

import type { ValueInfo } from "../types";
import { probedSixel, probedTheme, resolveCapabilities } from "./capabilities";
import { barCells } from "./components/bar";
import { errorCard, notice } from "./components/error-card";
import { flowChunks, formatBytes, formatMegapixels, formatRange, formatValue, wrapText } from "./format";
import { help, verbHelp } from "./help";
import * as plainLibrary from "./library";
import { createLiveRegion } from "./live";
import { MARGIN, lookFor, lookOf, styleOf } from "./look";
import type { Look } from "./look";
import { LAMP_AFTER_MS, LAMP_TICK_MS, TWEEN_MS, TWEEN_TICK_MS, clock, easeOutCubic, tickFor } from "./motion";
import { createPalette, glyphsFor } from "./palette";
import type { Style } from "./palette";
import { createProgressWriter, progressText } from "./progress";
import { margin } from "./screens";
import { doctorLines } from "./surfaces/doctor";
import { ROWS_ALL_UP_TO, ROWS_KEPT, exportSummaryLines, progressFrame, workingFrame } from "./surfaces/export";
import { MOST_CARDS, extensionLines, searchCards } from "./surfaces/extensions";
import { helpLines, verbHelpLines } from "./surfaces/help";
import { historyLines } from "./surfaces/history";
import { importPlanLines, importProgressState, importSummaryLines, importedFileLine } from "./surfaces/import";
import { folderTreeLines, forgetMessage, keywordListLines, keywordTableLines, listingLines } from "./surfaces/library";
import { photoList } from "./surfaces/photos";
import { canTween, exportedLine, resultBlock, resultRow, summaryLine } from "./surfaces/result";
import { photoHeaderLines, toolLines } from "./surfaces/tools";
import { doctor, extensionTable, historyList, photoTable, searchTable, toolTable } from "./table";
import type {
  BatchSummary,
  DoctorItem,
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
import { indent } from "./width";
import { COMMAND } from "../types";

export type * from "./types";
export { formatPrompt, formatReplNote } from "./home";
export { formatConfirm, formatForgetCard, formatHome, formatInstallCard, formatPhotoGrid, gridPictureFromJpeg, gridPictureFromRgba, showHome } from "./screens";
export { probeTheme, rememberTheme, resolveCapabilities } from "./capabilities";
export type { Capabilities, ThemeProbe } from "./capabilities";
export { RESTORE_TERMINAL } from "./live";
export { renderPromptArea } from "./prompt-render";

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
    caps: resolveCapabilities({
      env,
      tty: { stdout: streams.stdout.isTTY === true, stderr: streams.stderr.isTTY === true },
      probed: probedTheme(),
      sixel: probedSixel(),
    }),
  };
}

const tweens = new Set<Promise<void>>();

/**
 * Resolves once every value tween on screen has reached its last frame, 180 ms
 * at most. Await it before exiting or drawing a prompt. Anything that writes
 * sooner makes the tween jump to that frame instead, so nothing is ever left
 * half-drawn.
 */
export async function settleOutput(): Promise<void> {
  await Promise.all([...tweens]);
}

export function createOutput(streams: OutputStreams, options: OutputOptions): Output {
  const looks = { stdout: lookFor(options, "stdout"), stderr: lookFor(options, "stderr") };
  const plain = { glyphs: glyphsFor(options.unicode), width: Math.max(MIN_WIDTH, options.width) };
  const styleFor = (look: Look | null, colour: boolean): Style => (look ? styleOf(look) : { palette: createPalette(colour), ...plain });
  const onStdout = styleFor(looks.stdout, options.colour.stdout);
  const onStderr = styleFor(looks.stderr, options.colour.stderr);
  const { palette, glyphs, width } = onStdout;
  const dot = palette.dim(glyphs.dot);
  const quiet = options.verbosity === "quiet";
  const verbose = options.verbosity === "verbose" || options.verbosity === "debug";
  const progressLine = createProgressWriter(streams.stderr);

  const problem = (kind: "error" | "warning", p: Problem): string => {
    if (looks.stderr) return margin(kind === "error" ? errorCard(p, looks.stderr) : notice("warn", p, looks.stderr));
    const tone = kind === "error" ? onStderr.palette.error : onStderr.palette.accent;
    const hang = " ".repeat(PREFIX.length);
    const room = plain.width - PREFIX.length;
    const message = wrapText(plain.glyphs.fold(p.message), room).map((line, i) => (i === 0 ? `${tone(`${COMMAND}:`)} ${line}` : hang + line));
    const hint = p.hint ? wrapText(plain.glyphs.fold(p.hint), room).map((line) => hang + onStderr.palette.dim(line)) : [];
    return [...message, ...hint].join("\n");
  };

  // ---- the live region on stderr: progress, and the lamp for a wait -------

  const live = looks.stderr && !quiet ? createLiveRegion(streams.stderr, { sync: looks.stderr.caps.sync }) : null;
  const waits: { label: string; since: number }[] = [];
  let progressNow: ProgressState | null = null;
  let progressSince = 0;
  // Finished rows of a long job, shown above the lamp instead of filling the scrollback.
  let kept: string[] = [];
  let drawnAt = -Infinity;
  let stopBeat: (() => void) | null = null;

  const draw = (): void => {
    if (!live || !looks.stderr) return;
    const now = clock.now();
    // Measured each frame, so the region follows a window that is being resized.
    const look = lookOf(looks.stderr.caps, streams.stderr.columns > 0 ? streams.stderr.columns : options.width);
    const wait = waits[waits.length - 1];
    if (progressNow) live.show(indent(progressFrame(progressNow, now, progressSince, look, progressNow.items ? kept : []), MARGIN));
    else if (wait) live.show(indent(workingFrame(wait.label, now - wait.since, look), MARGIN));
    drawnAt = now;
  };
  const beat = (): void => {
    if (!live || !looks.stderr) return;
    const busy = progressNow !== null || waits.length > 0;
    if (busy && !stopBeat) stopBeat = clock.every(tickFor(LAMP_TICK_MS, looks.stderr.caps), draw);
    if (!busy && stopBeat) {
      stopBeat();
      stopBeat = null;
      drawnAt = -Infinity;
      live.clear();
    }
  };

  // ---- the value tween on stdout ------------------------------------------

  let settleTween: (() => void) | null = null;

  const tween = (r: ResultLine, look: Look): void => {
    const block = (t: number): string[] => indent(resultBlock(r, look, t), MARGIN);
    const scale = look.caps.clockScale;
    const started = clock.now();
    let finished = (): void => {};
    const done = new Promise<void>((resolve) => { finished = resolve; });
    const settle = (): void => {
      if (settleTween !== settle) return;
      settleTween = null;
      stop();
      region.clear(block(1));
      tweens.delete(done);
      finished();
    };
    const region = createLiveRegion(streams.stdout, { sync: look.caps.sync, onIntrusion: settle });
    // Held, so a caller awaiting settleOutput isn't cut short by the process running out of work.
    const stop = clock.every(TWEEN_TICK_MS * scale, (now) => {
      const t = (now - started) / (TWEEN_MS * scale);
      if (t >= 1) settle();
      else region.show(block(easeOutCubic(t)));
    }, true);
    settleTween = settle;
    tweens.add(done);
    region.show(block(0));
  };

  // Whatever is live gets out of the way first, so nothing is written onto it.
  const write = (to: "stdout" | "stderr", text: string): void => {
    settleTween?.();
    progressLine.clear();
    const stream = streams[to];
    const body = text.endsWith("\n") ? text : `${text}\n`;
    if (to === "stdout" && live?.showing && stream.isTTY === true) live.around(() => stream.write(body));
    else stream.write(body);
  };

  const output: Output = {
    options,
    formatValue: (info: ValueInfo, value: unknown) => formatValue(info, value, glyphs),
    formatRange: (info: ValueInfo) => formatRange(info, glyphs),
    photoHeader(h: PhotoHeader) {
      if (looks.stdout) return photoHeaderLines(h, looks.stdout).join("\n");
      const facts: string[] = [];
      if (h.camera) facts.push(h.camera);
      if (h.megapixels !== undefined) facts.push(formatMegapixels(h.megapixels));
      facts.push(h.edited ? "edited" : "not edited", `process version ${h.processVersion}`);
      return flowChunks([h.name, ...facts], glyphs.dot, width)
        .map((line, i) => line.map((part, at) => (i === 0 && at === 0 ? palette.heading(part) : part)).join(dot))
        .join("\n");
    },
    toolTable: (rows, view) => (looks.stdout ? toolLines(rows, view ?? {}, looks.stdout).join("\n") : toolTable(rows, onStdout)),
    photoTable: (rows) => (looks.stdout ? photoList(rows, looks.stdout).join("\n") : photoTable(rows, onStdout)),
    extensionTable: (rows) => (looks.stdout && rows.length > 0 ? extensionLines(rows, looks.stdout).join("\n") : extensionTable(rows, onStdout)),
    searchTable: (rows) =>
      (looks.stdout && rows.length > 0 && rows.length <= MOST_CARDS ? searchCards(rows, looks.stdout).join("\n") : searchTable(rows, onStdout)),
    historyList: (rows, photo) => (looks.stdout ? historyLines(rows, photo, clock.now(), looks.stdout).join("\n") : historyList(rows, onStdout)),
    resultLine(r: ResultLine) {
      if (looks.stdout) return resultRow(r, looks.stdout);
      const changes = r.changes.map((c) => glyphs.fold(c.value ? `${c.label} ${c.value}` : c.label));
      const note = r.note ? `  ${palette.dim(glyphs.fold(r.note))}` : "";
      const step = r.step !== undefined ? `   ${palette.dim(`(step ${r.step})`)}` : "";
      if (changes.length === 0) return r.photo + note + step;
      // Changes that don't fit continue under the first one, or near the margin when the name is long.
      const under = [...r.photo].length + 2;
      const hang = width - under >= 30 ? under : 4;
      const lines = flowChunks(changes, glyphs.dot, width - hang).map((line) => line.join(dot));
      return `${r.photo}  ${lines.join(`\n${" ".repeat(hang)}`)}${note}${step}`;
    },
    summary(s: BatchSummary) {
      if (looks.stdout) return summaryLine(s, looks.stdout);
      const parts = [`${s.photos} ${s.photos === 1 ? "photo" : "photos"}`];
      if (s.stepEach) parts.push("1 step each");
      if (s.failed > 0) parts.push(palette.error(`${s.failed} failed`));
      if (s.skipped > 0) parts.push(`${s.skipped} skipped`);
      return parts.join(dot);
    },
    exported(e: ExportedLine) {
      if (looks.stdout) return exportedLine(e, looks.stdout);
      const facts = [`${e.width}${glyphs.times}${e.height}`, e.colourSpace, formatBytes(e.bytes)];
      return `${e.path}  ${palette.dim(facts.join(glyphs.dot))}`;
    },
    help: (s) => (looks.stdout ? helpLines(s, looks.stdout).join("\n") : help(s, onStdout)),
    verbHelp: (v) => (looks.stdout ? verbHelpLines(v, looks.stdout).join("\n") : verbHelp(v, onStdout)),
    doctor: (items) => (looks.stdout ? doctorLines(items, looks.stdout).join("\n") : doctor(items, onStdout)),
    listing: (l) => (looks.stdout ? listingLines(l, looks.stdout).join("\n") : plainLibrary.listing(l)),
    folderTree: (root, summary, depth) =>
      (looks.stdout ? folderTreeLines(root, summary, looks.stdout, depth).join("\n") : plainLibrary.folderTree(root, depth)),
    keywordTable: (rows) => (looks.stdout ? keywordTableLines(rows, looks.stdout).join("\n") : plainLibrary.keywordTable(rows)),
    keywordList: (rows) => (looks.stdout ? keywordListLines(rows, looks.stdout).join("\n") : plainLibrary.keywordList(rows)),
    exportSummary: (s) => (looks.stdout ? exportSummaryLines(s, looks.stdout).join("\n") : plainLibrary.exportSummary(s, onStdout)),
    importPlan: (p) => (looks.stdout ? importPlanLines(p, looks.stdout).join("\n") : plainLibrary.importPlan(p, onStdout)),
    importedFile: (f) => (looks.stdout ? importedFileLine(f, looks.stdout) : plainLibrary.importedFile(f)),
    importSummary: (s) => (looks.stdout ? importSummaryLines(s, looks.stdout).join("\n") : plainLibrary.importSummary(s, onStdout)),
    forgetProblem: (risk) => ({ ...forgetMessage(risk), ...(risk.command !== undefined && { fix: risk.command }) }),
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
      if (quiet) return;
      // On a terminal everything a person reads sits in from the prompt.
      write("stdout", looks.stdout ? `${margin(text.split("\n"))}\n` : text);
    },
    json(doc: unknown) {
      write("stdout", JSON.stringify(doc, null, 2));
    },
    warn(p: Problem) {
      if (!quiet) write("stderr", problem("warning", p));
    },
    error(p: Problem) {
      write("stderr", problem("error", p));
    },
    info(text: string) {
      if (!verbose) return;
      write("stderr", looks.stderr ? margin(text.split("\n").map(onStderr.palette.dim)) : onStderr.palette.dim(text));
    },
    progress(p: ProgressState | null) {
      if (!looks.stderr) {
        if (p) progressLine.show(progressText(p, onStderr));
        else progressLine.clear();
        return;
      }
      if (!live) return;
      if (p && !progressNow) progressSince = clock.now();
      if (!p) kept = [];
      progressNow = p;
      beat();
      if (p ? clock.now() - drawnAt >= tickFor(TWEEN_TICK_MS, looks.stderr.caps) : waits.length > 0) draw();
    },
    writeRaw(bytes: Uint8Array) {
      settleTween?.();
      progressLine.clear();
      if (live?.showing && streams.stdout.isTTY === true) live.around(() => streams.stdout.write(bytes));
      else streams.stdout.write(bytes);
    },
    finished(row: string) {
      if (quiet) return;
      const long = progressNow !== null && progressNow.total > ROWS_ALL_UP_TO;
      if (!long || verbose || !live || !looks.stdout) {
        output.print(row);
        return;
      }
      kept = [...kept, ...row.split("\n")].slice(-ROWS_KEPT);
      if (looks.stderr && clock.now() - drawnAt >= tickFor(TWEEN_TICK_MS, looks.stderr.caps)) draw();
    },
    importProgress: (p) => output.progress(p ? importProgressState(p) : null),
    async checklist(checks) {
      const items: DoctorItem[] = [];
      const look = looks.stdout;
      if (!look || quiet) {
        for (const check of checks) items.push(...[await check.run()].flat());
        output.print(output.doctor(items));
        return items;
      }
      settleTween?.();
      const region = createLiveRegion(streams.stdout, { sync: look.caps.sync });
      const started = clock.now();
      let settled = 0;
      const rows = (): string[] => indent(doctorLines(items, look, checks.slice(settled).map((check) => check.label), clock.now() - started), MARGIN);
      const stop = clock.every(tickFor(LAMP_TICK_MS, look.caps), () => region.show(rows()));
      try {
        for (const check of checks) {
          region.show(rows());
          items.push(...[await check.run()].flat());
          settled++;
        }
      } finally {
        stop();
        region.clear(settled === checks.length ? indent(doctorLines(items, look), MARGIN) : []);
      }
      return items;
    },
    result(r: ResultLine) {
      if (quiet) return;
      const look = looks.stdout;
      if (!look) {
        write("stdout", output.resultLine(r));
        return;
      }
      settleTween?.();
      const still = look.caps.motion !== "full" || live?.showing || !canTween(r) || barCells(look.columns) === 0;
      if (still) write("stdout", margin(resultBlock(r, look)));
      else tween(r, look);
    },
    async working<T>(label: string, task: Promise<T>): Promise<T> {
      if (!live) return task;
      const wait = { label, since: clock.now() };
      const timer = setTimeout(() => {
        waits.push(wait);
        beat();
        if (!progressNow) draw();
      }, LAMP_AFTER_MS);
      timer.unref?.();
      try {
        return await task;
      } finally {
        clearTimeout(timer);
        const at = waits.indexOf(wait);
        if (at >= 0) {
          waits.splice(at, 1);
          beat();
          if (!progressNow && waits.length > 0) draw();
        }
      }
    },
  };
  return output;
}
