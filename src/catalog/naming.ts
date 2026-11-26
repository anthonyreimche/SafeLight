// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// File naming from metadata: a template of {tokens} and literal text, filled
// from a file's name and EXIF. It names a file that isn't imported yet as well as
// a catalogued photo, so a rename, an ingest and a caption all read one set of
// tokens. Moved here from Advanced EXIF Tools 1.3.1, whose behaviour it keeps.

import type { ExifData } from "./types";

/** What a name is made from. A CatalogPhoto is one, given its folder's name. */
export interface NameSubject {
  /** The file's name with its extension: {name} and {ext}. */
  filename: string;
  /** Date tokens read dateTimeOriginal, {subsec} subSecTimeOriginal. */
  exif: ExifData;
  /** The capture time in ms when the EXIF has none. */
  dateCreated?: number;
  /** {folder}: the name of the folder the file is in. */
  folderName?: string;
}

export type NameCase = "asis" | "lower" | "upper";

export interface NameOptions {
  /** The subject's place in its batch, from 0: {seq} and {letter}. */
  index?: number;
  /** {seq} of the first subject. Default 1. */
  seqStart?: number;
  /** Added to {seq} per subject. Default 1. */
  seqStep?: number;
  /** Zero-padded width of {seq} without its own width. Default 3. */
  seqPad?: number;
  /** Case of the whole name. Default "asis". */
  caseMode?: NameCase;
}

export interface NameToken {
  /** The text to insert into a template. */
  insert: string;
  label: string;
  /** What it renders as for a typical photo. */
  sample: string;
}

/** Every token, grouped for a palette that inserts them into a template. */
export const NAME_TOKENS: readonly { group: string; tokens: readonly NameToken[] }[] = [
  {
    group: "Naming",
    tokens: [
      { insert: "{name}", label: "Original name", sample: "IMG_1234" },
      { insert: "{seq}", label: "Sequence number", sample: "001" },
      { insert: "{seq:4}", label: "Sequence (width 4)", sample: "0001" },
      { insert: "{letter}", label: "Sequence letter", sample: "a" },
      { insert: "{LETTER}", label: "Sequence letter (caps)", sample: "A" },
      { insert: "{folder}", label: "Folder name", sample: "Trip" },
      { insert: "{ext}", label: "Extension", sample: "nef" },
    ],
  },
  {
    group: "Capture date",
    tokens: [
      { insert: "{yyyy}", label: "Year (4)", sample: "2026" },
      { insert: "{yy}", label: "Year (2)", sample: "26" },
      { insert: "{mon}", label: "Month", sample: "06" },
      { insert: "{day}", label: "Day", sample: "30" },
      { insert: "{hour}", label: "Hour (24h)", sample: "14" },
      { insert: "{min}", label: "Minute", sample: "05" },
      { insert: "{sec}", label: "Second", sample: "42" },
      { insert: "{subsec}", label: "Subseconds (ms)", sample: "541" },
      { insert: "{date}", label: "Date (yyyymmdd)", sample: "20260630" },
      { insert: "{time}", label: "Time (hhmmss)", sample: "140542" },
    ],
  },
  {
    group: "Camera & EXIF",
    tokens: [
      { insert: "{make}", label: "Camera make", sample: "NIKON" },
      { insert: "{model}", label: "Camera model", sample: "Z8" },
      { insert: "{lens}", label: "Lens", sample: "24-70mm" },
      { insert: "{iso}", label: "ISO", sample: "400" },
      { insert: "{fnum}", label: "Aperture", sample: "f2.8" },
      { insert: "{shutter}", label: "Shutter", sample: "1_250" },
      { insert: "{focal}", label: "Focal length", sample: "35mm" },
    ],
  },
];

const KNOWN = new Set([
  "name", "seq", "letter", "folder", "ext",
  "yyyy", "yy", "mon", "day", "hour", "min", "sec", "subsec", "date", "time",
  "make", "model", "lens", "iso", "fnum", "shutter", "focal",
]);

const TOKEN = /\{([A-Za-z]+)(?::([^}]*))?\}/g;

// Characters no mainstream file system accepts. Spaces, dashes and dots are
// kept, so a template's own separators survive.
const ILLEGAL = /[<>:"/\\|?*]/g;

function filenameSafe(value: string): string {
  return value.replace(ILLEGAL, "_").trim();
}

function splitExt(filename: string): { base: string; ext: string } {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? { base: filename.slice(0, dot), ext: filename.slice(dot + 1) } : { base: filename, ext: "" };
}

function pad(n: number, width: number): string {
  const digits = Math.trunc(Math.abs(n)).toString();
  return (n < 0 ? "-" : "") + digits.padStart(width, "0");
}

/** 0 → a, 25 → z, 26 → aa, 27 → ab … */
function letterOf(index: number): string {
  let n = Math.max(0, Math.trunc(index));
  let out = "";
  do {
    out = String.fromCharCode(97 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

function captureDate(subject: NameSubject): Date | null {
  const m = subject.exif.dateTimeOriginal?.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(+y, +mo - 1, +d, +h, +mi, +s);
    if (!Number.isNaN(date.getTime())) return date;
  }
  if (subject.dateCreated !== undefined) {
    const date = new Date(subject.dateCreated);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

function widthArg(arg: string | undefined): number | undefined {
  return arg !== undefined && /^\d+$/.test(arg) ? +arg : undefined;
}

/** A token's value, unsanitised; null for a token this engine doesn't know. */
function tokenValue(name: string, arg: string | undefined, subject: NameSubject, options: NameOptions): string | null {
  const { exif } = subject;
  const date = captureDate(subject);
  const two = (n: number) => pad(n, 2);
  const index = options.index ?? 0;
  switch (name) {
    case "name":
      return splitExt(subject.filename).base;
    case "ext":
      return splitExt(subject.filename).ext;
    case "folder":
      return subject.folderName ?? "";
    case "seq":
      return pad((options.seqStart ?? 1) + index * (options.seqStep ?? 1), widthArg(arg) ?? options.seqPad ?? 3);
    case "letter":
      return letterOf(index);
    case "LETTER":
      return letterOf(index).toUpperCase();
    case "yyyy":
      return date ? String(date.getFullYear()) : "";
    case "yy":
      return date ? two(date.getFullYear() % 100) : "";
    case "mon":
      return date ? two(date.getMonth() + 1) : "";
    case "day":
      return date ? two(date.getDate()) : "";
    case "hour":
      return date ? two(date.getHours()) : "";
    case "min":
      return date ? two(date.getMinutes()) : "";
    case "sec":
      return date ? two(date.getSeconds()) : "";
    case "subsec": {
      // SubSecTime is the fraction's digits ("5" is half a second), so a width
      // pads on the right: 3, the default, is milliseconds.
      const digits = (exif.subSecTimeOriginal ?? "").replace(/\D/g, "");
      if (!digits) return "";
      const width = Math.max(1, widthArg(arg) ?? 3);
      return digits.slice(0, width).padEnd(width, "0");
    }
    case "date":
      return date ? `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` : "";
    case "time":
      return date ? `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}` : "";
    case "make":
      return exif.cameraMake ?? "";
    case "model":
      return exif.cameraModel ?? "";
    case "lens":
      return exif.lens ?? "";
    case "iso":
      return exif.iso != null ? String(exif.iso) : "";
    case "fnum":
      return exif.aperture != null ? `f${exif.aperture}` : "";
    case "shutter":
      return exif.shutterSpeed ?? "";
    case "focal":
      return exif.focalLength != null ? `${exif.focalLength}mm` : "";
    default:
      return null;
  }
}

/** {letter} and {LETTER} differ by case; every other token name is matched in
 *  any case. */
function tokenName(raw: string): string {
  return raw === "LETTER" || raw === "letter" ? raw : raw.toLowerCase();
}

/** A file's base name (no extension) from `template`: tokens filled, unknown
 *  ones dropped, every character no file system takes replaced by "_", doubled
 *  separators an empty token leaves collapsed, and no separator or dot at
 *  either end. Empty when nothing is left. */
export function renderName(template: string, subject: NameSubject, options: NameOptions = {}): string {
  const filled = template.replace(TOKEN, (_all, raw: string, arg?: string) => {
    const value = tokenValue(tokenName(raw), arg, subject, options);
    return value == null ? "" : filenameSafe(value);
  });
  const base = filenameSafe(filled)
    .replace(/[ _-]{2,}/g, (run) => run[0])
    .replace(/^[-_. ]+|[-_. ]+$/g, "");
  if (options.caseMode === "lower") return base.toLowerCase();
  if (options.caseMode === "upper") return base.toUpperCase();
  return base;
}

/** A folder path from `template`, "/" or "\" between its folders: each folder
 *  rendered as renderName renders a name, the empty ones left out, joined by
 *  "/". "" when nothing is left. No folder can be "." or "..". */
export function renderFolder(template: string, subject: NameSubject, options: NameOptions = {}): string {
  return template
    .split(/[\\/]/)
    .map((segment) => renderName(segment, subject, options))
    .filter(Boolean)
    .join("/");
}

/** `text` with its tokens filled, for a caption or a headline: values are kept
 *  as they are (a shutter of 1/250 stays 1/250) and a {word} that is no token
 *  stays as written. */
export function expandName(text: string, subject: NameSubject, options: NameOptions = {}): string {
  return text.replace(TOKEN, (all: string, raw: string, arg?: string) => tokenValue(tokenName(raw), arg, subject, options) ?? all);
}

/** The {tokens} of `template` that aren't tokens, as written, each once. */
export function unknownTokens(template: string): string[] {
  const unknown = new Set<string>();
  for (const m of template.matchAll(TOKEN)) if (!KNOWN.has(m[1].toLowerCase())) unknown.add(m[1]);
  return [...unknown];
}
