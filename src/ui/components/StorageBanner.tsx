// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Surfaces the result of opening a folder whose .safelight working dir couldn't
// live in the folder itself, or whose catalog couldn't be used as saved:
//   • openError   — a blocking, verbose message (e.g. a read-only folder with no
//                   writeable fallback, or a catalog another program holds).
//                   Replaces the old silent console.error. Preferences is offered
//                   only for a read-only folder, the one case it can fix.
//   • saveError   — the open project's catalog saves are failing. It can't be
//                   dismissed: it goes by itself once a save lands.
//   • storageNotice — a non-blocking heads-up that a read-only folder's catalog
//                   was redirected to a writeable location, so the user knows
//                   where their edits/ratings actually land, or that a catalog
//                   was restored from its backup or rebuilt.
// A slim dismissible bar at the bottom of the viewport, matching UpdateBanner.

import { useProjectStore } from "@/project/project-store";
import { openPreferences } from "./PreferencesDialog";

export function StorageBanner() {
  const openError = useProjectStore((s) => s.openError);
  const openErrorReadOnly = useProjectStore((s) => s.openErrorReadOnly);
  const storageNotice = useProjectStore((s) => s.storageNotice);
  const saveError = useProjectStore((s) => s.saveError);
  const dismissOpenError = useProjectStore((s) => s.dismissOpenError);
  const dismissStorageNotice = useProjectStore((s) => s.dismissStorageNotice);

  // Errors take precedence over the (lower-stakes) redirect notice.
  if (openError) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed bottom-0 left-0 right-0 z-[210] flex items-center justify-center gap-3 border-t border-red-500/40 bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg"
      >
        <span className="text-red-400" aria-hidden="true">
          ⚠
        </span>
        <span className="text-text-primary">{openError}</span>
        {openErrorReadOnly && (
          <button
            onClick={() => openPreferences("Previews")}
            className="shrink-0 rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
          >
            Preferences
          </button>
        )}
        <button
          onClick={dismissOpenError}
          aria-label="Dismiss"
          className="shrink-0 rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
        >
          ×
        </button>
      </div>
    );
  }

  if (saveError) {
    return (
      <div
        role="alert"
        aria-live="assertive"
        className="fixed bottom-0 left-0 right-0 z-[210] flex items-center justify-center gap-3 border-t border-red-500/40 bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg"
      >
        <span className="text-red-400" aria-hidden="true">
          ⚠
        </span>
        <span className="text-text-primary">{saveError}</span>
      </div>
    );
  }

  if (storageNotice) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-0 left-0 right-0 z-[210] flex items-center justify-center gap-3 border-t border-border bg-surface-2 px-4 py-2 text-[11px] text-text-secondary shadow-lg"
      >
        <span className="text-text-primary">{storageNotice}</span>
        <button
          onClick={dismissStorageNotice}
          aria-label="Dismiss"
          className="shrink-0 rounded px-1.5 py-1 text-text-muted hover:text-text-primary"
        >
          ×
        </button>
      </div>
    );
  }

  return null;
}
