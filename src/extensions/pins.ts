// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Versions the user chose to stay on. Installing an extension version older
// than its latest full release keeps it there: auto-update skips it and the
// Updates badge leaves it out, while the Updates tab still lists the newer
// version. Choosing Latest, updating, or uninstalling clears it. Persisted per
// profile and followed across windows, like the disabled list.

import { create } from "zustand";

const PINS_KEY = "sl_ext_pins";

function parsePins(raw: string | null): Record<string, string> {
  try {
    const v: unknown = JSON.parse(raw ?? "{}");
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  } catch {
    return {};
  }
}

function loadPins(): Record<string, string> {
  try {
    return parsePins(localStorage.getItem(PINS_KEY));
  } catch {
    return {};
  }
}

export const usePins = create<{ pins: Record<string, string> }>(() => ({ pins: loadPins() }));

/** The version extension `id` is kept at, or null. */
export const keptVersion = (id: string): string | null => usePins.getState().pins[id] ?? null;

/** Keep `id` at `version`, or stop keeping it (null). */
export function setKept(id: string, version: string | null): void {
  const { [id]: _drop, ...rest } = usePins.getState().pins;
  const pins = version ? { ...rest, [id]: version } : rest;
  usePins.setState({ pins });
  try {
    localStorage.setItem(PINS_KEY, JSON.stringify(pins));
  } catch {}
}

/** Follow versions kept or released in other windows. Call once at boot. */
export function initPinSync(): void {
  window.addEventListener("storage", (e) => {
    if (e.key === PINS_KEY) usePins.setState({ pins: parsePins(e.newValue) });
  });
}
