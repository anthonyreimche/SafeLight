// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Non-intrusive update notification banner. Mounts once on startup (or when
// the detached-window check runs), checks the GitHub releases API, and shows
// a slim bar in the bottom stack (BottomBanners) if a newer version is available.
// The user can dismiss it; it won't reappear for the same version.

import { useEffect, useRef, useState } from "react";
import { useSettings } from "@/state/settings-store";
import {
  checkForUpdate,
  dismissVersion,
  installVersion,
  openUrl,
  updateSupportFor,
  type UpdateInfo,
} from "./update-checker";
import type { UpdateSupport } from "@/extensions/types";


// Re-check cadence while the app stays open. Matches the extension poll.
const APP_UPDATE_POLL_MS = 3 * 60 * 60 * 1000; // 3h

export function UpdateBanner() {
  const checkEnabled = useSettings((s) => s.checkForUpdates);
  const channel = useSettings((s) => s.updateChannel);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Versions closed (not skipped) this session: suppressed by the poll but not
  // persisted, so they surface again next launch.
  const closedThisSession = useRef(new Set<string>());

  useEffect(() => {
    // Turning the preference off has to retire a banner that is already up —
    // nothing else clears `update`, so it would otherwise outlive the setting.
    if (!checkEnabled) {
      setUpdate(null);
      return;
    }
    let alive = true;
    const run = () =>
      void checkForUpdate(channel)
        .then((info) => {
          if (!alive) return;
          if (info && closedThisSession.current.has(info.version)) return;
          setUpdate(info);
        })
        .catch((e) => console.warn("[update] check failed:", e));
    run(); // immediately on mount…
    // …then re-check periodically so a release published while the app is left
    // open surfaces without a restart (the old behaviour only checked on launch).
    const id = setInterval(run, APP_UPDATE_POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [checkEnabled, channel]);

  if (!update) return null;

  const dismiss = (skip: boolean) => {
    if (skip) dismissVersion(update.version);
    else closedThisSession.current.add(update.version);
    setUpdate(null);
  };

  return (
    <BannerInstall update={update} onDismiss={dismiss} />
  );
}

function BannerInstall({
  update,
  onDismiss,
}: {
  update: UpdateInfo;
  onDismiss: (skip: boolean) => void;
}) {
  const [dlState, setDlState] = useState<"idle" | "downloading" | "opened" | "error">("idle");
  const [support, setSupport] = useState<UpdateSupport | null>(null);

  useEffect(() => {
    let alive = true;
    setSupport(null);
    void updateSupportFor(update).then((s) => {
      if (alive) setSupport(s);
    });
    return () => {
      alive = false;
    };
  }, [update]);

  const handleDownload = () => {
    setDlState("downloading");
    // An installer quits the app; a Linux package resolves and Safelight stays open.
    installVersion(update.tag).then(
      () => setDlState("opened"),
      (e: unknown) => {
        console.error("[update] couldn't install the update:", e);
        setDlState("error");
      },
    );
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-3 border-t border-border bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg"
    >
      <span className="text-text-primary font-medium">
        Safelight v{update.version} is available.
      </span>
      {dlState === "error" && (
        <span role="alert" className="text-danger">
          Couldn't download the update. Try again, or use View release.
        </span>
      )}
      {support === "release-page" ? (
        <button
          onClick={() => openUrl(update.releasesUrl)}
          className="rounded bg-slider-fill px-2.5 py-1 text-[11px] font-medium text-on-accent hover:opacity-90"
        >
          Open release page
        </button>
      ) : (
        <button
          onClick={() => openUrl(update.releasesUrl)}
          className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
        >
          View release
        </button>
      )}
      {support === "install" &&
        (dlState === "downloading" ? (
          <span className="text-[11px] text-text-muted">Downloading…</span>
        ) : dlState === "opened" ? (
          <span className="text-[11px] text-text-muted">Opened in your software installer</span>
        ) : (
          <button
            onClick={handleDownload}
            className="rounded bg-slider-fill px-2.5 py-1 text-[11px] font-medium text-on-accent hover:opacity-90"
          >
            Download
          </button>
        ))}
      <button
        onClick={() => onDismiss(false)}
        title="Close — will remind you again next launch"
        className="rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
        aria-label="Close update notification"
      >
        ×
      </button>
      <button
        onClick={() => onDismiss(true)}
        className="text-[10px] text-text-muted hover:text-text-primary"
        title="Won't notify about this version automatically again (manual check still shows it)"
      >
        Skip this release
      </button>
    </div>
  );
}
