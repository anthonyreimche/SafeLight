// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Splits a typed line into words the way a shell does: quotes group words.
// Backslashes escape on macOS and Linux; on Windows they are path characters.

export interface Token {
  /** The word without its quotes or escapes. */
  text: string;
  /** Offsets of the raw word in the line. */
  start: number;
  end: number;
  /** The quote the word opened with, if any. */
  quote: '"' | "'" | null;
  /** The quote was never closed. */
  open: boolean;
}

export function tokenize(line: string, platform: NodeJS.Platform): Token[] {
  const escapes = platform !== "win32";
  const tokens: Token[] = [];
  let i = 0;
  while (i < line.length) {
    if (/\s/.test(line[i])) {
      i++;
      continue;
    }
    const start = i;
    let text = "";
    let quote: Token["quote"] = null;
    let inQuote: '"' | "'" | null = null;
    while (i < line.length && (inQuote !== null || !/\s/.test(line[i]))) {
      const ch = line[i];
      if (inQuote === null && (ch === '"' || ch === "'")) {
        inQuote = ch;
        quote ??= ch;
        i++;
      } else if (inQuote === ch) {
        inQuote = null;
        i++;
      } else if (escapes && ch === "\\" && inQuote !== "'" && i + 1 < line.length) {
        const next = line[i + 1];
        if (inQuote === null || next === '"' || next === "\\") {
          text += next;
          i += 2;
        } else {
          text += ch;
          i++;
        }
      } else {
        text += ch;
        i++;
      }
    }
    tokens.push({ text, start, end: i, quote, open: inQuote !== null });
  }
  return tokens;
}

export function splitLine(line: string, platform: NodeJS.Platform): string[] {
  return tokenize(line, platform).map((t) => t.text);
}
