// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The dev-folder chooser: read-only path field, Choose/Change, Clear, Rescan and
// its status/error text. Shared by the Extensions ▸ Dev tab and the Preferences ▸
// Developer Tools section so the two can't drift. The two differ only in density
// and layout: the tab is one compact row, the settings section splits Rescan and
// a loaded/failed count onto a second row.

import { useDevFolder, pickDevFolder, scanDevFolder, setDevFolder } from "./dev-folder";

type Variant = "tab" | "settings";

export function DevFolderControls({ variant }: { variant: Variant }) {
  const folder = useDevFolder((s) => s.folder);
  const items = useDevFolder((s) => s.items);
  const scanning = useDevFolder((s) => s.scanning);
  const error = useDevFolder((s) => s.error);

  if (variant === "tab") {
    const btn =
      "shrink-0 rounded bg-surface-3 px-2 py-1 text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40";
    return (
      <>
        <div className="flex items-center gap-1.5">
          <input
            value={folder ?? ""}
            readOnly
            placeholder="No folder selected"
            spellCheck={false}
            title={folder ?? undefined}
            className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted"
          />
          <button onClick={() => void pickDevFolder()} className={btn}>
            {folder ? "Change…" : "Choose folder…"}
          </button>
          {folder && (
            <button
              onClick={() => void scanDevFolder()}
              disabled={scanning}
              className={btn}
            >
              {scanning ? "…" : "↻ Rescan"}
            </button>
          )}
          {folder && (
            <button onClick={() => setDevFolder(null)} className={btn}>
              Clear
            </button>
          )}
        </div>

        {error && <div className="text-red-400">{error}</div>}
      </>
    );
  }

  const btn =
    "shrink-0 rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40";
  const loadedCount = items.filter((i) => i.status === "loaded").length;
  const errorCount = items.filter((i) => i.status === "error").length;
  return (
    <>
      <div className="flex items-center gap-1.5">
        <input
          value={folder ?? ""}
          readOnly
          placeholder="No folder selected"
          spellCheck={false}
          title={folder ?? undefined}
          className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted"
        />
        <button onClick={() => void pickDevFolder()} className={btn}>
          {folder ? "Change…" : "Choose folder…"}
        </button>
        {folder && (
          <button
            onClick={() => setDevFolder(null)}
            title="Stop scanning this folder and unload its extensions"
            className={btn}
          >
            Clear
          </button>
        )}
      </div>

      {folder && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => void scanDevFolder()}
            disabled={scanning}
            className={btn}
          >
            {scanning ? "Scanning…" : "Rescan"}
          </button>
          <span className="text-[10px] text-text-muted">
            {scanning
              ? "Scanning…"
              : `${loadedCount} loaded${errorCount ? `, ${errorCount} failed` : ""}`}
          </span>
        </div>
      )}

      {error && <p className="text-[10px] text-red-400">{error}</p>}
    </>
  );
}
