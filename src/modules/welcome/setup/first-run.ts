// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether this launch opens the welcome setup by itself. It does only on a
// fresh profile, and the outcome is recorded so the question is asked once.
// "in-progress" is written when first-run setup opens: a person who quits
// halfway has usually saved a theme in step 1 already, which would otherwise
// make the next launch mistake them for an existing user.

export const SETUP_RECORD_KEY = "sl_setup_v1";

export type SetupOutcome = "in-progress" | "finished" | "skipped" | "not-needed";

const OUTCOMES: readonly SetupOutcome[] = [
  "in-progress",
  "finished",
  "skipped",
  "not-needed",
];

export interface SetupRecord {
  outcome: SetupOutcome;
  at: number;
  appVersion: string;
}

export function readSetupRecord(
  store: Pick<Storage, "getItem">,
): SetupRecord | null {
  try {
    const raw: unknown = JSON.parse(store.getItem(SETUP_RECORD_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const { outcome, at, appVersion } = raw as Record<string, unknown>;
    const known = OUTCOMES.find((o) => o === outcome);
    if (!known) return null;
    return {
      outcome: known,
      at: typeof at === "number" ? at : 0,
      appVersion: typeof appVersion === "string" ? appVersion : "",
    };
  } catch {
    return null;
  }
}

export function writeSetupRecord(
  store: Pick<Storage, "setItem">,
  outcome: SetupOutcome,
  appVersion: string,
  at = Date.now(),
): void {
  try {
    store.setItem(SETUP_RECORD_KEY, JSON.stringify({ outcome, at, appVersion }));
  } catch {}
}

export interface ProfileSignals {
  recentProjects: number;
  installedExtensions: number;
  /** A saved theme or settings. Only a person's own choices write these:
   *  applyTheme and updateSettings have no boot-time writers of new values
   *  (applySavedTheme re-applies the saved theme at boot without changing
   *  it), unlike keys such as sl_ext_disabled that every first boot seeds. */
  savedPreferences: boolean;
}

export interface SignalSources {
  countRecentProjects(): Promise<number>;
  countInstalledExtensions(): Promise<number>;
  hasSavedPreferences(): boolean;
}

const countOrZero = (read: () => Promise<number>): Promise<number> =>
  Promise.resolve()
    .then(read)
    .catch(() => 0);

export async function gatherProfileSignals(
  sources: SignalSources,
): Promise<ProfileSignals> {
  const [recentProjects, installedExtensions] = await Promise.all([
    countOrZero(() => sources.countRecentProjects()),
    countOrZero(() => sources.countInstalledExtensions()),
  ]);
  let savedPreferences = false;
  try {
    savedPreferences = sources.hasSavedPreferences();
  } catch {}
  return { recentProjects, installedExtensions, savedPreferences };
}

export type FirstRunDecision = "open" | "existing-profile" | "closed";

/** `signals` is null when the profile couldn't be read in time: setup stays
 *  closed for this launch and nothing is recorded, so it is asked again. */
export function decideFirstRun(
  record: SetupRecord | null,
  signals: ProfileSignals | null,
): FirstRunDecision {
  if (record) return record.outcome === "in-progress" ? "open" : "closed";
  if (!signals) return "closed";
  const used =
    signals.recentProjects > 0 ||
    signals.installedExtensions > 0 ||
    signals.savedPreferences;
  return used ? "existing-profile" : "open";
}
