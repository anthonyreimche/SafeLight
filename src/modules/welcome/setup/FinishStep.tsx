// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Step 3 of the welcome setup. With nothing picked it just closes. With picks
// it shows what will install beside the third-party notice the Extensions
// store shows before a first install; the Install click is the
// acknowledgement. Once installs start there is no way out until every row
// has settled (the queue's timeouts bound the wait), because the app has no
// other surface that could report a failure afterwards.

import { EXTENSION_RISK_NOTICE } from "@/extensions/install-gate";
import { useTrust } from "@/extensions/trust";
import { useProjectStore } from "@/project/project-store";
import { needsRestart, type InstallRow } from "./install-queue";
import {
  closeSetup,
  retrySetupInstall,
  setSetupStep,
  setupPending,
  startSetupInstalls,
  useSetupStore,
} from "./setup-store";
import {
  primaryBtn,
  secondaryBtn,
  StepFooter,
  StepHeading,
  type StepProps,
} from "./SetupParts";

const STATUS: Record<InstallRow["status"], string> = {
  waiting: "Waiting",
  installing: "Installing…",
  installed: "Installed",
  skipped: "Skipped",
  failed: "Failed",
  "timed-out": "Timed out",
};

export function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function InstallProgress({
  headingId,
  rows,
  installing,
  leave,
}: {
  headingId: string;
  rows: InstallRow[];
  installing: boolean;
  leave: { label: string; onClick: () => void };
}) {
  const installed = rows.filter((r) => r.status === "installed").length;
  const settled = rows.filter(
    (r) => r.status !== "waiting" && r.status !== "installing",
  ).length;
  const summary = `Installed ${installed} of ${rows.length}.`;
  const restart = needsRestart(rows);
  const title = installing
    ? "Installing extensions"
    : installed === 0
      ? "Nothing was installed"
      : "Your darkroom is ready";
  return (
    <>
      <StepHeading
        id={headingId}
        title={title}
        subtitle={
          installing
            ? "This takes a moment. Each extension switches on as it finishes."
            : summary
        }
      />
      <p role="status" className="sr-only">
        {`${settled} of ${rows.length} done`}
      </p>
      <ul className="flex flex-col divide-y divide-border rounded border border-border bg-surface-1">
        {rows.map((r) => (
          <li key={r.repo} className="flex items-start justify-between gap-3 px-3 py-2">
            <div className="flex min-w-0 flex-col">
              <span className="text-sm text-text-primary">{r.name}</span>
              {r.detail && (
                <span className="text-xs text-text-secondary">{r.detail}</span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2 text-xs text-text-secondary">
              <span>{STATUS[r.status]}</span>
              {!installing &&
                (r.status === "failed" || r.status === "timed-out") && (
                  <button
                    type="button"
                    className={secondaryBtn}
                    aria-label={`Retry ${r.name}`}
                    onClick={() => void retrySetupInstall(r.repo)}
                  >
                    Retry
                  </button>
                )}
            </div>
          </li>
        ))}
      </ul>
      {!installing && restart.length > 0 && (
        <p className="mt-3 text-sm text-text-secondary">
          Restart Safelight so {joinNames(restart)} can reach the internet.
        </p>
      )}
      {!installing && (
        <StepFooter>
          <button type="button" className={primaryBtn} onClick={leave.onClick}>
            {leave.label}
          </button>
        </StepFooter>
      )}
    </>
  );
}

export function FinishStep({ headingId }: StepProps) {
  const mode = useSetupStore((s) => s.mode);
  const kits = useSetupStore((s) => s.kits);
  const selected = useSetupStore((s) => s.selected);
  const installed = useSetupStore((s) => s.installed);
  const installs = useSetupStore((s) => s.installs);
  const installing = useSetupStore((s) => s.installing);
  const trust = useTrust((s) => s.list);
  const pending = setupPending({ kits, selected, installed }, trust);

  const leave = {
    label: mode === "first-run" ? "Open Folder…" : "Done",
    onClick: () => {
      closeSetup("finished");
      if (mode === "first-run") void useProjectStore.getState().openProjectPicker();
    },
  };
  const back = (
    <button
      type="button"
      className={secondaryBtn}
      onClick={() => setSetupStep("extensions")}
    >
      Back
    </button>
  );

  if (installs)
    return (
      <InstallProgress
        headingId={headingId}
        rows={installs}
        installing={installing}
        leave={leave}
      />
    );

  if (pending.length === 0)
    return (
      <>
        <StepHeading
          id={headingId}
          title="Your darkroom is ready"
          subtitle="Add extensions any time from the Extensions store, and change your look and workspace in Preferences."
        />
        <StepFooter>
          {back}
          <button type="button" className={primaryBtn} onClick={leave.onClick}>
            {leave.label}
          </button>
        </StepFooter>
      </>
    );

  const install = `Install ${pending.length} extension${pending.length === 1 ? "" : "s"}`;
  return (
    <>
      <StepHeading
        id={headingId}
        title={install}
        subtitle="They download from GitHub and switch on as each one finishes."
      />
      <ul className="mb-4 flex flex-col gap-1 text-sm text-text-primary">
        {pending.map((e) => (
          <li key={e.repo}>{e.name}</li>
        ))}
      </ul>
      <p className="whitespace-pre-line rounded border border-border bg-surface-1 p-3 text-sm text-text-secondary">
        {EXTENSION_RISK_NOTICE}
      </p>
      <StepFooter>
        {back}
        <button
          type="button"
          className={primaryBtn}
          onClick={() => void startSetupInstalls()}
        >
          {install}
        </button>
      </StepFooter>
    </>
  );
}
