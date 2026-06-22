// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Non-intrusive update notification banner. Mounts once on startup (or when
// the detached-window check runs), checks the GitHub releases API, and shows
// a slim bar at the bottom of the viewport if a newer version is available.
// The user can dismiss it; it won't reappear for the same version.

import { useEffect, useState } from "react";
import { useSettings } from "@/state/settings-store";
import {
  checkForUpdate,
  dismissVersion,
  installVersion,
  openUrl,
  type UpdateInfo,
} from "./update-checker";


export function UpdateBanner() {
  const checkEnabled = useSettings((s) => s.checkForUpdates);
  const channel = useSettings((s) => s.updateChannel);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);

  useEffect(() => {
    if (!checkEnabled) return;
    let alive = true;
    void checkForUpdate(__APP_VERSION__, channel).then((info) => {
      if (alive) setUpdate(info);
    });
    return () => {
      alive = false;
    };
  }, [checkEnabled, channel]);

  if (!update) return null;

  const dismiss = (skip: boolean) => {
    if (skip) dismissVersion(update.version);
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
  const [dlState, setDlState] = useState<"idle" | "downloading" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  const handleDownload = () => {
    setDlState("downloading");
    setErrMsg("");
    installVersion(update.tag).catch((e: unknown) => {
      setDlState("error");
      setErrMsg(e instanceof Error ? e.message : String(e));
    });
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-0 left-0 right-0 z-[200] flex items-center justify-center gap-3 border-t border-border bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg"
    >
      <span className="text-text-primary font-medium">
        Safelight v{update.version} is available.
      </span>
      {dlState === "error" && (
        <span className="text-red-400" title={errMsg}>{errMsg}</span>
      )}
      <button
        onClick={() => openUrl(update.releasesUrl)}
        className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
      >
        View release
      </button>
      {dlState === "downloading" ? (
        <span className="text-[11px] text-text-muted">Downloading…</span>
      ) : (
        <button
          onClick={handleDownload}
          className="rounded bg-slider-fill px-2.5 py-1 text-[11px] font-medium text-white hover:opacity-90"
        >
          Download
        </button>
      )}
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
