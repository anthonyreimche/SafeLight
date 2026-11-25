// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether the What's new window opens on this launch. It remembers the last
// version whose notes were shown; a brand-new install gets the welcome setup
// instead and starts counting from there.

import { compareSemver, isSemver } from "@/update/semver";

export const WHATS_NEW_KEY = "sl_whats_new_v1";

export function readSeenVersion(store: Pick<Storage, "getItem">): string | null {
  try {
    const value = store.getItem(WHATS_NEW_KEY);
    return value && isSemver(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeSeenVersion(store: Pick<Storage, "setItem">, version: string): void {
  try {
    store.setItem(WHATS_NEW_KEY, version);
  } catch {}
}

export function decideWhatsNew(input: {
  seen: string | null;
  current: string;
  newInstall: boolean;
}): "show" | "skip" {
  if (input.newInstall) return "skip";
  if (input.seen && compareSemver(input.seen, input.current) >= 0) return "skip";
  return "show";
}
