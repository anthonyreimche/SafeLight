// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A starter kit's page in the store: what it holds, what's installed, and
// Install all. Install all runs the welcome setup's queue with its review
// gate, so banned, unverified and stale-reviewed members are skipped with a
// reason rather than installed past their review.

import type { StarterKit } from "@/modules/welcome/setup/kits";
import { needsRestart, type InstallDeps, type InstallRow } from "@/modules/welcome/setup/install-queue";
import { joinNames } from "@/modules/welcome/setup/FinishStep";
import { confirmExtensionRisk } from "./install-gate";
import { useExtStoreUI } from "./store-ui";
import { kitPending, runKitInstall } from "./store-kits";

const STATUS: Record<InstallRow["status"], string> = {
  waiting: "Waiting",
  installing: "Installing…",
  installed: "Installed",
  skipped: "Skipped",
  failed: "Failed",
  "timed-out": "Timed out",
};

export function KitPage({
  kit,
  installed,
  busy,
  onBusy,
  onOpen,
  onDone,
  deps,
}: {
  kit: StarterKit;
  /** Installed repos, lowercase. */
  installed: ReadonlySet<string>;
  busy: string | null;
  onBusy: (busy: string | null) => void;
  onOpen: (repo: string) => void;
  /** The run has settled: the panel re-reads what's installed. */
  onDone: () => void;
  deps?: InstallDeps;
}) {
  const rows = useExtStoreUI((s) => s.kitRuns[kit.id]);
  const runningHere = useExtStoreUI((s) => s.kitRunning === kit.id);
  const pending = kitPending(kit, installed);
  const running = runningHere || busy === `kit:${kit.id}`;
  const restart = rows && !running ? needsRestart(rows) : [];

  const installAll = async () => {
    if (!(await confirmExtensionRisk())) return;
    onBusy(`kit:${kit.id}`);
    try {
      await runKitInstall(kit, installed, deps);
    } finally {
      onBusy(null);
      onDone();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={() => useExtStoreUI.getState().goHome()}
        className="self-start text-text-secondary hover:text-text-primary"
      >
        ← Browse
      </button>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold text-text-primary">{kit.name}</h2>
          {kit.description && <p className="mt-0.5 text-text-secondary">{kit.description}</p>}
        </div>
        {pending.length > 0 && (
          <button
            disabled={busy !== null || running}
            onClick={() => void installAll()}
            className="shrink-0 rounded bg-slider-fill px-3 py-1 font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {running ? "Installing…" : `Install all (${pending.length})`}
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1.5">
        {kit.extensions.map((e) => {
          const found = rows?.find((r) => r.repo === e.repo);
          // A settled row gives way to the real install state: a member skipped
          // here and installed from its page since must not still read "Skipped".
          const settled = !!found && found.status !== "waiting" && found.status !== "installing";
          const row = settled && installed.has(e.repo) ? undefined : found;
          const status = row ? STATUS[row.status] : installed.has(e.repo) ? "Installed" : "";
          return (
            <li key={e.repo}>
              <button
                onClick={() => onOpen(e.repo)}
                className="flex w-full items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5 text-left hover:bg-surface-3"
              >
                <span className="min-w-0">
                  <span className="block truncate text-text-primary">{e.name}</span>
                  <span className="block text-text-muted">{row?.detail || e.summary}</span>
                </span>
                {status && <span className="shrink-0 text-text-muted">{status}</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {restart.length > 0 && (
        <div className="text-text-secondary">
          Restart Safelight so {joinNames(restart)} can reach the internet.
        </div>
      )}
    </div>
  );
}
