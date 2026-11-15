// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whole screens and pieces the prompt asks for by themselves, outside an
// Output: home and its warm-up, the contact sheet, and the install question's
// card. Each takes the options and gives the plain text where the stream
// isn't a terminal.

import type { InstallRisk } from "../types";
import { blockPicture, itermPicture } from "./components/picture";
import type { Pixels } from "./components/picture";
import { formatHome as plainHome } from "./home";
import { MARGIN, lookFor } from "./look";
import { WARM_UP_FRAMES, WARM_UP_MS } from "./motion";
import { confirmLine, installCard } from "./surfaces/extensions";
import { bulbRows, homeLayout } from "./surfaces/home";
import { forgetCard } from "./surfaces/library";
import { GRID_CELL, GRID_ROWS, photoGridLines } from "./surfaces/photos";
import type { ForgetRisk, GridCell, GridPicture, HomeStatus, OutputOptions, OutputStreams } from "./types";

/** Sets lines in from the prompt; blank lines stay empty. */
export function margin(lines: readonly string[]): string {
  return lines.map((line) => (line === "" ? "" : " ".repeat(MARGIN) + line)).join("\n");
}

/** The banner, status and a few starter commands, ending with a newline. */
export function formatHome(status: HomeStatus, opts: OutputOptions): string {
  const look = lookFor(opts, "stdout");
  if (!look) return plainHome(status, opts);
  return `${homeLayout(status, look).lines.join("\n")}\n`;
}

// Not the shared clock: the prompt is waiting on this, so the timer has to
// hold the process open even before the keyboard is being read.
const pause = (ms: number, skip?: AbortSignal): Promise<void> => new Promise((resolve) => {
  const done = (): void => {
    clearTimeout(timer);
    skip?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  skip?.addEventListener("abort", done, { once: true });
});

/**
 * Writes home. With `warm`, on a terminal that allows motion, the bulb starts
 * as an ember and comes up to lit in under a third of a second; aborting
 * `skip` (any key) jumps to lit. What is left on screen is exactly formatHome.
 */
export async function showHome(
  status: HomeStatus,
  streams: OutputStreams,
  opts: OutputOptions,
  warm: boolean,
  skip?: AbortSignal,
): Promise<void> {
  const { stdout } = streams;
  const look = lookFor(opts, "stdout");
  const lit = look ? homeLayout(status, look) : null;
  // The repaint climbs back up to the bulb, which only works while all of home is still on screen.
  const fits = lit !== null && stdout.rows > lit.lines.length + 1;
  if (!look || !lit?.bulb || !warm || !fits || look.caps.motion !== "full" || skip?.aborted) {
    stdout.write(formatHome(status, opts));
    return;
  }

  const { bulb } = lit;
  const [syncOn, syncOff] = look.caps.sync ? ["\x1b[?2026h", "\x1b[?2026l"] : ["", ""];
  const up = lit.lines.length - bulb.top;
  const down = up - bulb.rows + 1;
  const repaint = (warmth: number): string => {
    const rows = bulbRows(look, warmth).map((row) => `\r\x1b[${bulb.left}C${row}`).join("\x1b[1B");
    return `${syncOn}\x1b[?25l\x1b[${up}A${rows}\x1b[${down}B\r\x1b[?25h${syncOff}`;
  };
  const frameMs = (WARM_UP_MS / WARM_UP_FRAMES) * look.caps.clockScale;

  stdout.write(`${homeLayout(status, look, 0).lines.join("\n")}\n`);
  for (let frame = 1; frame < WARM_UP_FRAMES && !skip?.aborted; frame++) {
    await pause(frameMs, skip);
    if (!skip?.aborted) stdout.write(repaint(frame / WARM_UP_FRAMES));
  }
  if (!skip?.aborted) await pause(frameMs, skip);
  stdout.write(repaint(1));
}

/** The contact sheet for `photos --grid`, or null where stdout gets the plain list. */
export function formatPhotoGrid(photos: readonly GridCell[], opts: OutputOptions): string | null {
  const look = lookFor(opts, "stdout");
  return look ? photoGridLines(photos, look).join("\n") : null;
}

/**
 * A contact-sheet cell's picture from pixels, as half blocks; null where
 * stdout can't show them (not a terminal, or fewer than 256 colours).
 */
export function gridPictureFromRgba(image: Pixels, opts: OutputOptions): GridPicture | null {
  const look = lookFor(opts, "stdout");
  return look ? blockPicture(image, GRID_CELL, GRID_ROWS, look) : null;
}

/**
 * A contact-sheet cell's picture from the stored preview, for iTerm2 and the
 * terminals that take its inline images: the JPEG goes as it is, with no
 * engine. `size` is the photo's width and height as it is shown.
 */
export function gridPictureFromJpeg(jpeg: Uint8Array, size?: { width: number; height: number }): GridPicture {
  return itermPicture(jpeg, GRID_CELL, GRID_ROWS, size);
}

/** The card a "Forget them?" question sits under, on the stream it is asked on; empty off a terminal. */
export function formatForgetCard(risk: ForgetRisk, opts: OutputOptions, stream: "stdout" | "stderr" = "stderr"): string {
  const look = lookFor(opts, stream);
  return look ? `${margin(forgetCard(risk, look))}\n` : "";
}

/** The card an install question sits under, on the stream it is asked on; empty off a terminal. */
export function formatInstallCard(risk: InstallRisk, opts: OutputOptions, stream: "stdout" | "stderr" = "stderr"): string {
  const look = lookFor(opts, stream);
  return look ? `${margin(installCard(risk, look))}\n` : "";
}

/** "Install it?   ‹ No ›   Yes" with its keys, for a prompt that reads keypresses; null off a terminal. */
export function formatConfirm(question: string, yes: boolean, opts: OutputOptions, stream: "stdout" | "stderr" = "stderr"): string | null {
  const look = lookFor(opts, stream);
  return look ? margin([confirmLine(question, yes, look)]) : null;
}
