// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Starter kits in the Extensions store: the kits.json the welcome setup
// offers, as a Browse shelf whose Install all runs setup's install queue and
// review gate. Progress lives in store-ui, so a kit page shows it again after
// the person looks elsewhere.

import { installFromGitHub } from "./loader";
import { checkReview } from "./install-gate";
import { rememberSource } from "./sources";
import { bannedReason, isVerified } from "./trust";
import type { TrustList } from "./types";
import { useExtStoreUI } from "./store-ui";
import { parseKits, type KitExtension, type StarterKit } from "@/modules/welcome/setup/kits";
import {
  runSetupInstalls,
  SETUP_INSTALL_TIMEOUT_MS,
  waitingRow,
  type InstallDeps,
  type InstallRow,
} from "@/modules/welcome/setup/install-queue";
import { visibleKits } from "@/modules/welcome/setup/selection";

/** Fetch kits.json through the bridge; unavailable or malformed is null. */
export async function loadStoreKits(): Promise<void> {
  const fetchKits = window.safelightNative?.plugins?.kits;
  if (!fetchKits) return;
  const raw = await fetchKits().catch(() => null);
  const kits = parseKits(raw, __APP_VERSION__);
  useExtStoreUI.setState({ kits: kits && kits.length > 0 ? kits : null });
}

export const kitPending = (kit: StarterKit, installed: ReadonlySet<string>): KitExtension[] =>
  kit.extensions.filter((e) => !installed.has(e.repo));

/** Kits as the trust list allows them, without those with nothing left to install. */
export function shelfKits(
  kits: readonly StarterKit[],
  trust: TrustList,
  installed: ReadonlySet<string>,
): StarterKit[] {
  return visibleKits(kits, trust).filter((k) => kitPending(k, installed).length > 0);
}

export const storeInstallDeps = (): InstallDeps => ({
  bannedReason,
  isVerified,
  checkReview,
  install: installFromGitHub,
  rememberSource,
  timeoutMs: SETUP_INSTALL_TIMEOUT_MS,
  where: "its page",
});

export const isKitRunning = (id: string): boolean => useExtStoreUI.getState().kitRunning === id;

/** Install a kit's missing members one at a time, recording every row. While
 *  that kit is already running, answers its rows so far without a second run. */
export async function runKitInstall(
  kit: StarterKit,
  installed: ReadonlySet<string>,
  deps: InstallDeps = storeInstallDeps(),
): Promise<InstallRow[]> {
  if (isKitRunning(kit.id)) return useExtStoreUI.getState().kitRuns[kit.id] ?? [];
  useExtStoreUI.setState({ kitRunning: kit.id });
  try {
    const rows = kitPending(kit, installed).map(waitingRow);
    const put = (next: InstallRow[]) =>
      useExtStoreUI.setState((s) => ({ kitRuns: { ...s.kitRuns, [kit.id]: next } }));
    put(rows);
    return await runSetupInstalls(rows, deps, (row) =>
      put((useExtStoreUI.getState().kitRuns[kit.id] ?? rows).map((r) => (r.repo === row.repo ? row : r))),
    );
  } finally {
    useExtStoreUI.setState((s) => (s.kitRunning === kit.id ? { kitRunning: null } : {}));
  }
}
