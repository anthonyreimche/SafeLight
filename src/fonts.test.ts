// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The interface font ships with the app (Afacad, SIL OFL), stays behind
// --font-mono for extensions, and code views use --font-code instead.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const css = readFileSync(path.join(ROOT, "src", "index.css"), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("interface font", () => {
  it("bundles Afacad with its licence and declares the face", () => {
    const dir = path.join(ROOT, "public", "fonts", "afacad");
    expect(existsSync(path.join(dir, "Afacad[wght].ttf"))).toBe(true);
    expect(readFileSync(path.join(dir, "OFL.txt"), "utf8")).toMatch(/SIL OPEN FONT LICENSE/i);
    expect(css).toMatch(/@font-face\s*{[^}]*font-family:\s*"Afacad"[^}]*url\("\/fonts\/afacad\/Afacad\[wght\]\.ttf"\)/);
    expect(css).toMatch(/@font-face\s*{[^}]*size-adjust:\s*120%/);
  });

  it("puts Afacad first in --font-mono and keeps the mono stack as --font-code", () => {
    expect(css).toMatch(/--font-mono:\s*"Afacad",/);
    expect(css).toMatch(/--font-code:\s*"JetBrains Mono",/);
  });

  it("gives numbers fixed widths everywhere", () => {
    expect(css).toMatch(/#root\s*{[^}]*font-variant-numeric:\s*tabular-nums/);
  });

  it("uses the font-code utility, not font-mono, for code in the app", () => {
    const offenders = sourceFiles(path.join(ROOT, "src")).filter((f) =>
      /(?<![-\w])font-mono(?![-\w])/.test(readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.relative(ROOT, f))).toEqual([]);
  });
});
