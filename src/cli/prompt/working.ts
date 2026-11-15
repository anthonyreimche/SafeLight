// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The photos `open` holds at the prompt, as plain values: the set, its cursor
// and how it changes. The prompt owns one; each command gets it as
// CommandContext.working, so a command naming no photo acts on the current one.

import path from "node:path";
import type { WorkingSet } from "../types";

const pathsFor = (platform: NodeJS.Platform): path.PlatformPath => (platform === "win32" ? path.win32 : path.posix);

export function openSet(paths: readonly string[], root: string): WorkingSet | null {
  return paths.length === 0 ? null : { paths: [...paths], index: 0, root };
}

export const currentPath = (set: WorkingSet): string => set.paths[set.index] ?? set.paths[0];

/** The set `by` photos on, stopping at either end; `moved` is how far it went. */
export function stepSet(set: WorkingSet, by: number): { set: WorkingSet; moved: number } {
  const index = Math.min(Math.max(set.index + by, 0), set.paths.length - 1);
  return { set: { ...set, index }, moved: index - set.index };
}

/** The set without the photos `gone` names; the cursor stays on its photo, or moves to the next one left. */
export function withoutPhotos(set: WorkingSet, gone: (abs: string) => boolean): WorkingSet | null {
  const paths = set.paths.filter((abs) => !gone(abs));
  if (paths.length === 0) return null;
  const before = set.paths.slice(0, set.index).filter((abs) => !gone(abs)).length;
  return { ...set, paths, index: Math.min(before, paths.length - 1) };
}

/** Whether `dir` is the set's project folder or inside it. */
export function holdsFolder(set: WorkingSet, dir: string, platform: NodeJS.Platform): boolean {
  const p = pathsFor(platform);
  const rel = p.relative(set.root, dir);
  return rel === "" || (!rel.startsWith("..") && !p.isAbsolute(rel));
}

/** The set as the prompt's context reads it: each photo from `cwd`, "/"-separated, and the current one. */
export interface WorkingInfo { rels: readonly string[]; at: number }

export function workingInfo(set: WorkingSet, cwd: string, platform: NodeJS.Platform): WorkingInfo {
  const p = pathsFor(platform);
  const rels = set.paths.map((abs) => {
    const rel = p.relative(cwd, abs);
    return platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  });
  return { rels, at: set.index };
}
