// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A small glob matcher and expander. cmd and PowerShell don't expand globs, so
// slu does, the same way everywhere: `*` and `?` stay inside a folder, a `**`
// segment crosses folders, `{a,b}` picks one of its words. `[abc]` is not a
// pattern: brackets, and braces without a comma, match themselves.

import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

const WILDCARD = /[*?]|\{[^{}]*,[^{}]*\}/;

export function hasGlob(spec: string): boolean {
  return WILDCARD.test(spec);
}

/** Folds the platform's backslashes to "/" so one pattern syntax serves every shell. */
export function slashed(spec: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? spec.replace(/\\/g, "/") : spec;
}

function escapeRegex(ch: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(ch) ? `\\${ch}` : ch;
}

function segmentSource(segment: string): string {
  let out = "";
  let closeAt = -1;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else if (ch === "{" && closeAt < 0 && /^\{[^{}]*,[^{}]*\}/.test(segment.slice(i))) {
      closeAt = segment.indexOf("}", i);
      out += "(?:";
    } else if (ch === "," && closeAt >= 0) out += "|";
    else if (ch === "}" && i === closeAt) {
      closeAt = -1;
      out += ")";
    } else out += escapeRegex(ch);
  }
  return out;
}

/** A regex for a "/"-separated pattern, matched against a "/"-separated path. */
export function compileGlob(pattern: string, ignoreCase: boolean): RegExp {
  const segments = pattern.split("/");
  let source = "";
  segments.forEach((segment, i) => {
    const last = i === segments.length - 1;
    if (segment === "**") source += last ? ".*" : "(?:[^/]+/)*";
    else source += segmentSource(segment) + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`, ignoreCase ? "iu" : "u");
}

export interface GlobBase {
  /** The folder to start walking from: everything before the first wildcard segment. */
  base: string;
  /** The wildcard part, "/"-separated. */
  rest: string;
}

export function splitGlob(spec: string, platform: NodeJS.Platform): GlobBase {
  const segments = slashed(spec, platform).split("/");
  const at = segments.findIndex((s) => WILDCARD.test(s));
  const head = segments.slice(0, at);
  let base = head.join("/");
  if (base === "" && segments[0] === "") base = "/";
  else if (/^[A-Za-z]:$/.test(base)) base += "/";
  return { base: base || ".", rest: segments.slice(at).join("/") };
}

/** Every file under `spec`'s folder that the pattern matches, as absolute paths, in
 *  name order. Folders starting with "." (`.safelight`) are never entered. */
export async function expandGlob(spec: string, cwd: string, platform: NodeJS.Platform): Promise<string[]> {
  const ignoreCase = platform === "win32" || platform === "darwin";
  const { base, rest } = splitGlob(spec, platform);
  const root = resolve(cwd, base);
  const matcher = compileGlob(rest.normalize("NFC"), ignoreCase);
  const restSegments = rest.split("/");
  const maxDepth = restSegments.includes("**") ? Infinity : restSegments.length;
  const found: string[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = prefix + entry.name;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && depth < maxDepth) await walk(resolve(dir, entry.name), `${rel}/`, depth + 1);
      } else if (matcher.test(rel.normalize("NFC"))) {
        found.push(resolve(dir, entry.name));
      }
    }
  }

  await walk(root, "", 1);
  return found;
}
