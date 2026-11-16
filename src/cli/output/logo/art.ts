// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The home screen's logo: Anthony's own ASCII bulb, shrunk to a small size with
// its texture kept (`-` for the lit globe, `.` for its shade, the blank
// highlight), his `#` and `+` screw base, and "Safelight" in figlet's small
// slant letters where his script crossed the globe, with the caption under it.

export const LOGO_ART: readonly string[] = [
  "                 -..-..-",
  "             ---..........",
  "            --.....    ....",
  "           --....         ..",
  "           --...           .",
  "           -...",
  "   ____     ___    ___      __   __",
  "  / __/__ _/ _/__ / (_)__ _/ /  / /_",
  " _\\ \\/ _ `/ _/ -_) / / _ `/ _ \\/ __/",
  "/___/\\_,_/_/ \\__/_/_/\\_, /_//_/\\__/",
  "           .-...    /___/",
  "           ....... u n p l u g g e d",
  "         ## ###+..",
  "        ##+######",
  "        #++#####",
  "         ######",
];
export const LOGO_ART_WIDTH = Math.max(...LOGO_ART.map((line) => line.length));

/** Which part of the logo a character belongs to. */
export type LogoPart = "globe" | "shade" | "stroke" | "caption" | "space";

const GLOBE = /[-.]/;

/**
 * `-` is the lit globe and `.` its shade, except that a `-` beside a lettering
 * character belongs to the lettering (the e's bar). Lowercase words are the
 * caption; everything else, the lettering and the base, is a stroke.
 */
export function logoParts(line: string): LogoPart[] {
  return [...line].map((char, x) => {
    if (char === " ") return "space";
    if (/[a-z]/.test(char)) return "caption";
    if (char === ".") return "shade";
    if (char !== "-") return "stroke";
    const besideLettering = [line[x - 1] ?? " ", line[x + 1] ?? " "].some((next) => next !== " " && !GLOBE.test(next));
    return besideLettering ? "stroke" : "globe";
  });
}

/** One row of the logo, painted by part. Runs of a part share one paint call; spaces stay unpainted. */
export function paintLogoRow(line: string, paint: (part: Exclude<LogoPart, "space">, text: string) => string): string {
  const parts = logoParts(line);
  let out = "";
  let run = "";
  let runPart: LogoPart = "space";
  const flush = (): void => {
    if (run !== "") out += runPart === "space" ? run : paint(runPart, run);
    run = "";
  };
  [...line].forEach((char, x) => {
    if (parts[x] !== runPart) flush();
    runPart = parts[x];
    run += char;
  });
  flush();
  return out;
}
