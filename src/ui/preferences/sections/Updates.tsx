// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useState } from "react";
import { updateSettings, useSettings } from "@/state/settings-store";
import type { UpdateSupport } from "@/extensions/types";
import {
  checkForUpdateNow,
  fetchAllReleases,
  dismissVersion,
  installVersion,
  openUrl,
  updateSupportFor,
  type CheckResult,
  type ReleaseEntry,
  type UpdateChannel,
} from "@/update/update-checker";
import { btnCls, Field, OptionRow, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

/** View release + Download where this copy can install the release, or one
 *  Open release page button where it can't. */
function ReleaseActions({
  release,
  className = "",
}: {
  release: Pick<ReleaseEntry, "tag" | "releasesUrl" | "assetNames">;
  className?: string;
}) {
  const [support, setSupport] = useState<UpdateSupport | null>(null);
  const [state, setState] = useState<"idle" | "downloading" | "opened" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  const assetKey = release.assetNames.join("\n");
  useEffect(() => {
    let alive = true;
    void updateSupportFor({ assetNames: assetKey ? assetKey.split("\n") : [] }).then((s) => {
      if (alive) setSupport(s);
    });
    return () => {
      alive = false;
    };
  }, [release.tag, assetKey]);

  if (support === "release-page") {
    return (
      <button
        onClick={() => openUrl(release.releasesUrl)}
        className={`${className} shrink-0 rounded bg-slider-fill px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90`}
      >
        Open release page
      </button>
    );
  }

  return (
    <div className={`${className} flex shrink-0 items-center gap-2`}>
      <button
        onClick={() => openUrl(release.releasesUrl)}
        className="shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-text-primary hover:bg-surface-3"
      >
        View release
      </button>
      {support === "install" &&
        (state === "downloading" ? (
          <span className="shrink-0 text-[10px] text-text-muted">Downloading…</span>
        ) : state === "opened" ? (
          <span className="shrink-0 text-[10px] text-text-muted">Opened in your software installer</span>
        ) : (
          <div className="flex shrink-0 flex-col items-end gap-0.5">
            <button
              onClick={() => {
                setState("downloading");
                setErrMsg("");
                // An installer quits the app; a Linux package resolves and Safelight stays open.
                installVersion(release.tag).then(
                  () => setState("opened"),
                  (e: unknown) => {
                    setState("error");
                    setErrMsg(e instanceof Error ? e.message : String(e));
                  },
                );
              }}
              className="rounded bg-slider-fill px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
            >
              Download
            </button>
            {state === "error" && (
              <span className="max-w-[180px] truncate text-[9px] text-danger" title={errMsg}>
                {errMsg}
              </span>
            )}
          </div>
        ))}
    </div>
  );
}

function CheckResultBadge({
  result,
  onDismiss,
}: {
  result: CheckResult;
  onDismiss: () => void;
}) {
  switch (result.kind) {
    case "network-error":
      return (
        <p className="text-[10px] text-danger">
          Could not reach GitHub. Check your internet connection. Reason: {result.detail}
        </p>
      );
    case "parse-error":
      return (
        <p className="text-[10px] text-danger">
          GitHub responded with unexpected data. The API may be down. Reason: {result.detail}
        </p>
      );
    case "no-releases":
      return (
        <p className="text-[10px] text-text-muted">
          No published releases found for this channel.
        </p>
      );
    case "current-version-unknown":
      return (
        <p className="text-[10px] text-danger">
          Could not read the running version (got: “{result.rawVersion}”). Try
          rebuilding the app.
        </p>
      );
    case "up-to-date":
      return (
        <p className="text-[10px] text-text-muted">
          v{result.currentVersion} is the latest release.
        </p>
      );
    case "update-available":
      return (
        <div className="flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-2 text-[11px]">
          <span className="font-medium text-text-primary">
            v{result.info.version} is available
            <span className="ml-1 font-normal text-text-muted">
              (you have v{result.currentVersion})
            </span>
          </span>
          <ReleaseActions release={result.info} />
          <button
            onClick={() => {
              dismissVersion(result.info.version);
              onDismiss();
            }}
            className="ml-auto text-text-muted hover:text-text-primary"
            title="Dismiss for this version"
          >
            ×
          </button>
        </div>
      );
  }
}

export function UpdatesSection() {
  const checkForUpdates = useSettings((s) => s.checkForUpdates);
  const channel = useSettings((s) => s.updateChannel);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [releases, setReleases] = useState<ReleaseEntry[] | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [releasesError, setReleasesError] = useState<string | null>(null);

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    const r = await checkForUpdateNow(__APP_VERSION__, channel);
    setResult(r);
    setChecking(false);
  };

  const loadReleases = async () => {
    setLoadingReleases(true);
    setReleasesError(null);
    try {
      setReleases(await fetchAllReleases());
    } catch (e) {
      setReleasesError(e instanceof Error ? e.message : String(e));
    }
    setLoadingReleases(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Check for updates on startup"
        hint="Silently checks the GitHub releases API on launch and every few hours while the app is open, and shows a banner if a newer version is available. No data is sent."
        checked={checkForUpdates}
        onChange={(v) => updateSettings({ checkForUpdates: v })}
      />

      <Field
        label="Update channel"
        hint="Stable only notifies on full releases. All releases also includes pre-releases (betas)."
      >
        <OptionRow<UpdateChannel>
          value={channel}
          options={[
            { value: "all", label: "All releases" },
            { value: "stable", label: "Stable only" },
          ]}
          onChange={(v) => updateSettings({ updateChannel: v })}
        />
      </Field>

      <div className="border-t border-border-subtle pt-3" />

      <Field label="Manual check">
        <button
          onClick={() => void checkNow()}
          disabled={checking}
          className={btnCls}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        {result && (
          <div className="mt-2">
            <CheckResultBadge result={result} onDismiss={() => setResult(null)} />
          </div>
        )}
      </Field>

      <div className="border-t border-border-subtle pt-3" />

      <Field label="Release history">
        {releases === null && !loadingReleases && (
          <button
            onClick={() => void loadReleases()}
            className={btnCls}
          >
            Load releases
          </button>
        )}
        {loadingReleases && (
          <span className="text-[10px] text-text-muted">Loading…</span>
        )}
        {releasesError && (
          <span className="text-[10px] text-danger">
            Could not load releases. Check your connection. Reason: {releasesError}
          </span>
        )}
        {releases && releases.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            {releases.map((r) => (
              <div
                key={r.version}
                className="flex items-center gap-2 rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-[11px]"
              >
                <span className="font-medium text-text-primary tabular-nums">
                  v{r.version}
                </span>
                {r.prerelease && (
                  <span className="shrink-0 rounded border border-border-subtle px-1.5 py-px text-[9px] uppercase tracking-wide text-text-muted">
                    Pre-release
                  </span>
                )}
                {r.body && (
                  <span className="flex-1 truncate text-text-muted" title={r.body}>
                    {r.body.split("\n")[0].replace(/^[#\s*-]+/, "").trim()}
                  </span>
                )}
                <ReleaseActions release={r} className="ml-auto" />
              </div>
            ))}
          </div>
        )}
      </Field>

      <p className="text-[10px] leading-relaxed text-text-muted">
        Uses the public GitHub Releases API. Safelight does not auto-download or
        auto-install updates.
      </p>
    </div>
  );
}

export const updatesSection: PrefSection = {
  id: "Updates",
  label: "Updates",
  group: "General",
  items: settings(
    "Check for updates on startup",
    "Update channel",
    "Manual check",
    "Release history",
  ),
  keywords: [],
  render: () => <UpdatesSection />,
};
