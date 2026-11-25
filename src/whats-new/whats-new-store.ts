// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The What's new window's state. The changelog is bundled into the app, so the
// notes show offline and always match the build that is running.

import { create } from "zustand";
import bundledChangelog from "../../docs/user/changelog.md?raw";
import { notesToShow, parseChangelog, type ChangelogRelease } from "./changelog";
import { decideWhatsNew, readSeenVersion, writeSeenVersion } from "./decide";

export const CHANGELOG_URL = "https://github.com/anthonyreimche/SafeLight/blob/main/docs/user/changelog.md";

interface WhatsNewState {
  /** The releases on show, newest first; null while the window is closed. */
  releases: ChangelogRelease[] | null;
}

export const useWhatsNew = create<WhatsNewState>(() => ({ releases: null }));

interface LaunchInput {
  store: Pick<Storage, "getItem" | "setItem">;
  current: string;
  /** The welcome setup is opening for a first run. */
  newInstall: boolean;
  source?: string;
}

/** Decides once per launch, in the main window, whether the window opens. The
 *  running version is remembered either way, so the notes show only once. */
export function initWhatsNew({ store, current, newInstall, source = bundledChangelog }: LaunchInput): void {
  const seen = readSeenVersion(store);
  const decision = decideWhatsNew({ seen, current, newInstall });
  writeSeenVersion(store, current);
  if (decision === "skip") return;
  const releases = notesToShow(parseChangelog(source), seen, current);
  if (releases.length) useWhatsNew.setState({ releases });
}

/** Opens the running version's notes, or the newest release's when this
 *  version has none of its own. */
export function openWhatsNew({ current = __APP_VERSION__, source = bundledChangelog } = {}): void {
  const all = parseChangelog(source);
  const own = notesToShow(all, null, current);
  const newest = all.find((r) => r.version !== "Unreleased" && r.groups.length > 0);
  const releases = own.length ? own : newest ? [newest] : [];
  useWhatsNew.setState({ releases });
}

export function closeWhatsNew(): void {
  useWhatsNew.setState({ releases: null });
}
