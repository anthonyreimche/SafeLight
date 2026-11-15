// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// `safelight` runs in plain Node, so what main.ts reaches at run time may not pull in
// React, the stores, rendering or the DOM. ProjectStorage's own closure is the
// one exception (it reaches the settings store), so the walk stops there.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.dirname(SRC);
const ENTRY = path.join(SRC, "cli", "main.ts");
const PROJECT_STORAGE = path.join(SRC, "project", "project-storage.ts");

/** The runtime module specifiers a file names: imports and re-exports that are
 *  not type-only, dynamic imports, and require() calls. */
export function runtimeSpecifiers(code: string): string[] {
  const text = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  const found: string[] = [];
  const statement = /^\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm;
  for (const m of text.matchAll(statement)) {
    if (m[2]) continue;
    const names = /^\{([\s\S]*)\}$/.exec(m[3].trim());
    const allTypes = names !== null && names[1].split(",").map((n) => n.trim()).filter(Boolean).every((n) => n.startsWith("type "));
    if (!allTypes) found.push(m[4]);
  }
  for (const m of text.matchAll(/^\s*import\s+["']([^"']+)["']/gm)) found.push(m[1]);
  // `import("x").Name` is a type, not a load.
  for (const m of text.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)(?!\.[A-Z])/g)) found.push(m[1]);
  for (const m of text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)) found.push(m[1]);
  return found;
}

function resolveFile(from: string, spec: string): string | null {
  if (spec.startsWith("node:") || !/^(\.|@\/)/.test(spec)) return null;
  const base = spec.startsWith("@/") ? path.join(SRC, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  const tries = [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")];
  const file = tries.find((f) => existsSync(f) && !f.endsWith(path.sep) && /\.(ts|tsx|cjs|js|mjs|json)$/.test(f));
  if (!file) throw new Error(`${path.relative(ROOT, from)} imports ${spec}, which isn't there`);
  return file;
}

/** Every module `entry` reaches at run time, with the bare packages it names as
 *  "package (from file)". Files in `exempt` are listed but not walked into. */
function closure(entry: string, exempt: ReadonlySet<string> = new Set()): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    if (file.endsWith(".json") || exempt.has(file)) continue;
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      const next = resolveFile(file, spec);
      if (next) queue.push(next);
      else if (!spec.startsWith("node:")) packages.add(`${spec} (from ${path.relative(SRC, file).split(path.sep).join("/")})`);
    }
  }
  return { files, packages };
}

describe("the safelight import closure", () => {
  it("reads type-only imports as no import", () => {
    expect(runtimeSpecifiers('import type { A } from "./a";\nimport { type B } from "./b";\nimport { c, type D } from "./c";\nexport type { E } from "./e";')).toEqual(["./c"]);
    expect(runtimeSpecifiers('const x = await import("./x");\nconst y = require("../y.cjs");\nimport "./side";')).toEqual(["./side", "./x", "../y.cjs"]);
    expect(runtimeSpecifiers('let c: import("./space").ColorSpaceId;')).toEqual([]);
  });

  it("holds no React, stores, rendering, UI or DOM modules", () => {
    const { files, packages } = closure(ENTRY, closure(PROJECT_STORAGE).files);
    const rel = [...files].map((f) => path.relative(SRC, f).split(path.sep).join("/"));
    expect(rel).toContain("cli/commands/set.ts");
    expect(rel).toContain("project/project-storage.ts");

    const banned = rel.filter((f) =>
      f.endsWith(".tsx") ||
      /^(ui|hooks|rendering|modules|state)\//.test(f) && f !== "state/shared-settings.ts",
    );
    expect(banned).toEqual([]);
    expect([...packages].filter((p) => /^(react|react-dom|zustand|dockview)[/ ]/.test(p))).toEqual([]);
  });
});
