// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { RAW_EXTENSIONS } from "@/modules/library/raw-preview";

// Best-effort scrubbing of text bound for a public issue: the folders of any
// absolute path (the project's become <folder>, a home folder ~, the rest …),
// the catalog's own relative folders, and photo file names. The user still
// sees and can edit everything, so this only has to catch the usual shapes,
// and running it twice must change nothing.

export interface RedactOptions {
  /** Absolute project folders, in any slash style. */
  roots?: readonly string[];
  /** The catalog's folders relative to the project, e.g. "2024/trip". */
  folders?: readonly string[];
}

const MAX_FOLDERS = 2000;

// A folder is bounded by separators, so it may hold single spaces between
// words; a word never starts with "~", so a folder can't run on into the next
// path ("notes.txt near ~\AppData"). The last part of a path has no separator
// after it and ends at whitespace instead.
const CH = String.raw`[^\\/\s"'<>|:*?,;=→]`;
const WORD = String.raw`[^\\/\s"'<>|:*?,;=→~]${CH}*`;
const DIR = `${WORD}(?: ${WORD})*`;
const NAME = `${CH}+`;
const AFTER_PATH = String.raw`(?=[\\/\s"'\x60)\]>,;:]|$)`;

const ACCOUNT = String.raw`(?:${DIR}(?=[\\/])|${NAME})`;
const WINDOWS_HOME = new RegExp(
  String.raw`[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+` + ACCOUNT,
  "gi",
);
const UNIX_HOME = new RegExp(String.raw`(?:\/var)?\/home\/[^/\s"'<>]+|\/Users\/` + ACCOUNT, "g");

const ANCHOR = [
  "<folder>",
  "~",
  String.raw`(?<![\w+.-])[A-Za-z]:(?=[\\/])`,
  String.raw`\\\\[^\\/\s"'<>|]+`,
  String.raw`\/(?:Volumes|mnt|media|run\/media|tmp|private)(?=\/)`,
].join("|");
const PATH = new RegExp(
  `(${ANCHOR})((?:[\\\\/]+${DIR}(?=[\\\\/]))*)(?:[\\\\/]+(${NAME}))?`,
  "g",
);

const IMAGE_EXTENSIONS = [
  ...[...RAW_EXTENSIONS].map((e) => e.slice(1)),
  "jpe?g",
  "png",
  "tiff?",
  "webp",
  "heic",
  "heif",
  "avif",
  "gif",
  "bmp",
  "xmp",
];
const PHOTO_NAME = new RegExp(
  String.raw`(?<![\w.-])[^\s\\/:"'<>|*?]+(\.(?:` + IMAGE_EXTENSIONS.join("|") + String.raw`))(?![\w-])`,
  "gi",
);

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const partsOf = (path: string): string[] => path.split(/[\\/]+/).filter(Boolean);

function rootPattern(root: string): RegExp | null {
  const parts = partsOf(root);
  if (parts.length === 0) return null;
  const plain = parts.map(escapeRegExp).join(String.raw`[\\/]+`);
  const encoded = parts.map((p) => escapeRegExp(encodeURI(p))).join("/");
  const lead = /^[\\/]/.test(root) ? String.raw`[\\/]+` : "";
  return new RegExp(`${lead}(?:${plain}|${encoded})${AFTER_PATH}`, "gi");
}

function folderPattern(folder: string): RegExp | null {
  const parts = partsOf(folder);
  if (parts.length === 0) return null;
  return new RegExp(
    String.raw`(?<![^\s"'(\[=>])` + parts.map(escapeRegExp).join(String.raw`[\\/]+`) + String.raw`(?=[\\/])`,
    "gi",
  );
}

function collapsePath(_match: string, anchor: string, dirs: string, name: string | undefined): string {
  if (anchor !== "<folder>" && anchor !== "~") return name ? `…/${name}` : "…";
  const inner = dirs ? `${anchor}/…` : anchor;
  return name ? `${inner}/${name}` : inner;
}

const longestFirst = (list: readonly string[]): string[] => [...list].sort((a, b) => b.length - a.length);

export function makeRedactor(opts: RedactOptions = {}): (text: string) => string {
  const roots = longestFirst(opts.roots ?? [])
    .map(rootPattern)
    .filter((r): r is RegExp => r !== null);
  const folders = longestFirst(opts.folders ?? [])
    .slice(0, MAX_FOLDERS)
    .map(folderPattern)
    .filter((r): r is RegExp => r !== null);
  return (text) => {
    let out = text;
    for (const root of roots) out = out.replace(root, "<folder>");
    out = out.replace(WINDOWS_HOME, "~").replace(UNIX_HOME, "~");
    out = out.replace(PATH, collapsePath);
    for (const folder of folders) out = out.replace(folder, "…");
    return out.replace(PHOTO_NAME, "<photo>$1");
  };
}
