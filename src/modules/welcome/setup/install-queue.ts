// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Installs the extensions picked in the welcome setup, one at a time, after
// the checks the Extensions store makes. Setup never installs code past its
// review: banned, unverified and stale-reviewed repos, and pinned repos whose
// review couldn't be confirmed, are skipped with a reason instead of
// prompting. Each item is raced against a timeout because the main process's
// download has none; two timeouts in a row skip the rest, since a connection
// that hangs once hangs for every item.

import type { ExtensionManifest } from "@/extensions/types";
import type { ReviewCheck } from "@/extensions/install-gate";
import type { KitExtension } from "./kits";

export type InstallStatus =
  | "waiting"
  | "installing"
  | "installed"
  | "skipped"
  | "failed"
  | "timed-out";

export interface InstallRow {
  repo: string;
  name: string;
  status: InstallStatus;
  /** Why a row was skipped, failed or timed out; empty otherwise. */
  detail: string;
  /** Network origins an installed extension declared; they apply after a
   *  restart, when the content-security policy is rebuilt. */
  network: string[];
}

export interface InstallDeps {
  bannedReason(repo: string): string | null;
  isVerified(repo: string): boolean;
  checkReview(repo: string): Promise<ReviewCheck>;
  install(repo: string): Promise<ExtensionManifest>;
  rememberSource(id: string, repo: string): void;
  timeoutMs: number;
}

export const SETUP_INSTALL_TIMEOUT_MS = 120_000;

const TIMED_OUT = Symbol("timed out");

export const waitingRow = (e: KitExtension): InstallRow => ({
  repo: e.repo,
  name: e.name,
  status: "waiting",
  detail: "",
  network: [],
});

/** Install one extension. Never throws. One deadline covers the review check
 *  and the download together: the check is a GitHub call that can hang too. */
export async function installOne(
  row: InstallRow,
  deps: InstallDeps,
): Promise<InstallRow> {
  const { repo } = row;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), deps.timeoutMs);
  });
  try {
    const banned = deps.bannedReason(repo);
    if (banned)
      return { ...row, status: "skipped", detail: `Blocked: ${banned}.` };
    if (!deps.isVerified(repo))
      return {
        ...row,
        status: "skipped",
        detail: "Not on the verified list any more.",
      };
    const review = await Promise.race([deps.checkReview(repo), deadline]);
    if (review === TIMED_OUT)
      return {
        ...row,
        status: "timed-out",
        detail:
          "Couldn't confirm the reviewed version in time, so nothing was downloaded.",
      };
    if (!review.confirmed)
      return {
        ...row,
        status: "skipped",
        detail:
          "Couldn't confirm the reviewed version right now. You can install it from Extensions.",
      };
    if (review.stale)
      return {
        ...row,
        status: "skipped",
        detail: `The newest version hasn't been reviewed yet (reviewed up to ${review.reviewedVersion}). You can install it from Extensions.`,
      };
    const work = deps.install(repo);
    // Recorded however late the download lands, so a timed-out install that
    // finishes in the background still shows as installed in the store.
    work.then(
      (m) => deps.rememberSource(m.id, repo),
      () => {},
    );
    const result = await Promise.race([work, deadline]);
    if (result === TIMED_OUT)
      return {
        ...row,
        status: "timed-out",
        detail:
          "Still downloading. It may finish in the background; check Extensions later.",
      };
    return {
      ...row,
      status: "installed",
      detail: "",
      network: result.permissions?.network ?? [],
    };
  } catch (e) {
    return {
      ...row,
      status: "failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Install `rows` in order, reporting every change through `onRow`. Resolves
 *  once every row has settled. A download that answered (installed or failed)
 *  resets the timeout count; a skip makes no download and leaves it alone. */
export async function runSetupInstalls(
  rows: readonly InstallRow[],
  deps: InstallDeps,
  onRow: (row: InstallRow) => void,
): Promise<InstallRow[]> {
  const done: InstallRow[] = [];
  let timeouts = 0;
  for (const row of rows) {
    let result: InstallRow;
    if (timeouts >= 2) {
      result = {
        ...row,
        status: "skipped",
        detail: "GitHub isn't responding. Try again from Extensions.",
      };
    } else {
      onRow({ ...row, status: "installing" });
      result = await installOne(row, deps);
      if (result.status === "timed-out") timeouts += 1;
      else if (result.status !== "skipped") timeouts = 0;
    }
    onRow(result);
    done.push(result);
  }
  return done;
}

export const needsRestart = (rows: readonly InstallRow[]): string[] =>
  rows
    .filter((r) => r.status === "installed" && r.network.length > 0)
    .map((r) => r.name);
