// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How many cells text takes, and the padding and joining built on it. Styling
// (escape codes, links, and the test theme's ‹tags›) takes none.

const MARKUP = /\x1b\[[0-9;:]*m|\x1b\]8;[^\x1b\x07]*(?:\x1b\\|\x07)|‹\/?[a-zA-Z.]*›/g;

export function stripMarkup(text: string): string {
  return text.replace(MARKUP, "");
}

// East Asian Wide and Fullwidth, plus the emoji blocks; each pair is inclusive.
const WIDE: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

const ZERO = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/** Cells one code point takes: 0 for combining marks and joiners, 2 for wide characters. */
export function charCells(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code < 0x300) return code < 0x20 || (code >= 0x7f && code < 0xa0) ? 0 : 1;
  if (ZERO.test(char)) return 0;
  for (const [from, to] of WIDE) {
    if (code < from) return 1;
    if (code <= to) return 2;
  }
  return 1;
}

/** Cells a string takes once its styling is removed. */
export function cells(text: string): number {
  let width = 0;
  for (const char of stripMarkup(text)) width += charCells(char);
  return width;
}

export function padEnd(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cells(text)));
}

export function padStart(text: string, width: number): string {
  return " ".repeat(Math.max(0, width - cells(text))) + text;
}

/** Cuts unstyled text to `width` cells, ending in `ellipsis` when something was lost. */
export function clip(text: string, width: number, ellipsis: string): string {
  if (cells(text) <= width) return text;
  const room = Math.max(0, width - cells(ellipsis));
  let used = 0;
  let kept = "";
  for (const char of text) {
    const size = charCells(char);
    if (used + size > room) break;
    used += size;
    kept += char;
  }
  return kept.trimEnd() + ellipsis;
}

/** Keeps the end, which is where a path's file name is. */
export function clipStart(text: string, width: number, ellipsis: string): string {
  if (cells(text) <= width) return text;
  const room = Math.max(0, width - cells(ellipsis));
  const chars = [...text];
  let used = 0;
  let from = chars.length;
  while (from > 0 && used + charCells(chars[from - 1]) <= room) used += charCells(chars[--from]);
  return ellipsis + chars.slice(from).join("").trimStart();
}

/** Sets blocks side by side, top-aligned, each padded to its own widest line. */
export function joinHorizontal(blocks: readonly (readonly string[])[], gap: number): string[] {
  const widths = blocks.map((block) => Math.max(0, ...block.map(cells)));
  const height = Math.max(0, ...blocks.map((block) => block.length));
  return Array.from({ length: height }, (_, row) =>
    blocks.map((block, i) => padEnd(block[row] ?? "", widths[i])).join(" ".repeat(gap)).trimEnd());
}

export function indent(lines: readonly string[], by: number): string[] {
  const pad = " ".repeat(by);
  return lines.map((line) => (line === "" ? "" : pad + line));
}
