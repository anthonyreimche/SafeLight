// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The extensions that didn't start: their activate threw or didn't finish. Kept
// for the Extensions window to name on their rows; it forgets one when the
// extension starts, is stopped or is swept.

import { create } from "zustand";
import { ExtensionTimeoutError } from "./guard";

export interface StartFailure {
  reason: "threw" | "timed out";
  message: string;
}

/** The extensions that failed to start, by extension id. */
export const useStartFailures = create<Record<string, StartFailure>>(() => ({}));

export function recordStartFailure(extensionId: string, error: unknown): void {
  useStartFailures.setState({
    [extensionId]: {
      reason: error instanceof ExtensionTimeoutError ? "timed out" : "threw",
      message: error instanceof Error ? error.message : String(error),
    },
  });
}

export function forgetStartFailure(extensionId: string): void {
  if (!(extensionId in useStartFailures.getState())) return;
  const { [extensionId]: _gone, ...rest } = useStartFailures.getState();
  useStartFailures.setState(rest, true);
}
