// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension that replaces others lists their ids in its manifest's
// `supersedes`. The first time it runs, each listed one that is installed and
// on is turned off (the loader does that; files and settings stay), and a
// notice says so. Each successor/id pair is handled once, whether or not the
// listed one was installed then, so one the person turns back on, or installs
// later, stays on: that is their choice.

import { create } from "zustand";
import type { ExtensionManifest } from "./types";
import { builtinExtension } from "./instance";
import { isReservedExtensionId } from "./core-extension";
import { isOfficialManifest, isOfficialOnlyId } from "./official-extensions";

export const MAX_SUPERSEDES = 16;

/** The ids `successor` may turn off: never its own, Safelight's built-ins or
 *  ids under `core`, and ids under `safelight` only for an official extension. */
export function supersededIds(successor: ExtensionManifest): string[] {
  if (!Array.isArray(successor.supersedes)) return [];
  const official = isOfficialManifest(successor);
  const ids: string[] = [];
  for (const raw of successor.supersedes as unknown[]) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || id === successor.id || ids.includes(id)) continue;
    if (isReservedExtensionId(id) || builtinExtension(id)) continue;
    if (isOfficialOnlyId(id) && !official) continue;
    ids.push(id);
  }
  return ids.slice(0, MAX_SUPERSEDES);
}

// ─── Pairs already handled ──────────────────────────────────────────────────

const HANDLED_KEY = "sl_ext_superseded";

function readHandled(): Record<string, string[]> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(HANDLED_KEY) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(
      Object.entries(stored).map(([id, ids]) => [
        id,
        Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [],
      ]),
    );
  } catch {
    return {};
  }
}

/** The installed extensions `successor` turns off now: the ones it lists that
 *  it hasn't handled before and that are on. Every listed id it hasn't handled
 *  is recorded as handled. */
export function takeSuperseded(
  successor: ExtensionManifest,
  installed: readonly ExtensionManifest[],
  isDisabled: (id: string) => boolean,
): ExtensionManifest[] {
  const ids = supersededIds(successor);
  if (ids.length === 0) return [];
  const handled = readHandled();
  const done = handled[successor.id] ?? [];
  const fresh = ids.filter((id) => !done.includes(id));
  if (fresh.length === 0) return [];
  try {
    localStorage.setItem(HANDLED_KEY, JSON.stringify({ ...handled, [successor.id]: [...done, ...fresh] }));
  } catch {}
  return fresh.flatMap((id) => {
    const m = installed.find((x) => x.id === id);
    return m && !isDisabled(id) ? [m] : [];
  });
}

// ─── Notices ────────────────────────────────────────────────────────────────
// Kept in localStorage until dismissed, so the main window's top bar shows one
// made by any window, and the next launch still does if nobody saw it.

const NOTES_KEY = "sl_ext_superseded_notes";

export interface SupersededNote {
  /** The extension turned off. */
  id: string;
  name: string;
  /** The name of the extension that replaces it. */
  by: string;
}

function parseNotes(raw: string | null): SupersededNote[] {
  try {
    const stored: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(stored)) return [];
    return stored.filter(
      (n): n is SupersededNote =>
        !!n &&
        typeof n === "object" &&
        typeof n.id === "string" &&
        typeof n.name === "string" &&
        typeof n.by === "string",
    );
  } catch {
    return [];
  }
}

export const useSupersededNotes = create<{ notes: SupersededNote[] }>(() => ({
  notes: parseNotes(localStorage.getItem(NOTES_KEY)),
}));

function saveNotes(notes: SupersededNote[]): void {
  useSupersededNotes.setState({ notes });
  try {
    localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  } catch {}
}

export function noteSuperseded(added: readonly SupersededNote[]): void {
  const notes = useSupersededNotes.getState().notes;
  const fresh = added.filter((n) => !notes.some((x) => x.id === n.id && x.by === n.by));
  if (fresh.length > 0) saveNotes([...notes, ...fresh]);
}

export function dismissSupersededNotes(): void {
  saveNotes([]);
}

/** Follow notices added or dismissed in other windows. Call once at boot. */
export function followSupersededNotes(): void {
  window.addEventListener("storage", (e) => {
    if (e.key === NOTES_KEY) useSupersededNotes.setState({ notes: parseNotes(e.newValue) });
  });
}
