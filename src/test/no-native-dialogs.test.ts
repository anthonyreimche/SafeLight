// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Native window.confirm/alert/prompt suspend Electron's renderer and can
// desync window focus (keystrokes stop reaching inputs until refocus/restart —
// electron#31917), so nothing in the renderer may call them; callers go
// through confirmDialog()/alertDialog() (src/ui/components/ConfirmDialog.tsx)
// instead. This is a line scan of the non-test .ts/.tsx files under src/: it
// sees a direct call, bare or on window, globalThis or self, but not one made
// through an alias or split across lines. Directories named vendor are skipped
// (today only src/raw/vendor, third-party code that runs in a worker).

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set(["vendor"]);
const DIALOG = "(?:confirm|alert|prompt)";
const GLOBAL = "\\b(?:window|globalThis|self)\\s*";
const NATIVE_DIALOG = new RegExp(
  [
    `${GLOBAL}\\.\\s*${DIALOG}\\s*\\(`,
    `${GLOBAL}\\[\\s*(["'\`])${DIALOG}\\1\\s*\\]\\s*\\(`,
    // Bare: not a method (obj.confirm), a longer name (confirmDialog) or prose.
    `(?<![\\w$.#])${DIALOG}\\(`,
  ].join("|"),
);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) yield* sourceFiles(full);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("renderer dialog policy", () => {
  it.each([
    'window.confirm("Delete?")',
    'window . alert("Saved")',
    'globalThis.prompt("Name")',
    'self.confirm("Delete?")',
    'window["alert"]("Saved")',
    'if (confirm("Delete?")) remove();',
    "alert(message);",
  ])("flags %s", (line) => {
    expect(NATIVE_DIALOG.test(line)).toBe(true);
  });

  it.each([
    'await confirmDialog({ title: "Delete" });',
    'await alertDialog({ title: "Saved" });',
    'dialog.confirm("Delete?");',
    "reconfirm(choice);",
    '"Please confirm (twice)"',
  ])("lets %s through", (line) => {
    expect(NATIVE_DIALOG.test(line)).toBe(false);
  });

  it("no source file calls native confirm/alert/prompt", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC_DIR)) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        if (NATIVE_DIALOG.test(line))
          offenders.push(
            `${path.relative(SRC_DIR, file).replace(/\\/g, "/")}:${i + 1}`,
          );
      });
    }
    expect(offenders).toEqual([]);
  });
});
