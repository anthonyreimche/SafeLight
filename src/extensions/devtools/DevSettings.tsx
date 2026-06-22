// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Developer Tools section. Contributed by the Developer Tools
// extension via api.registerSettings({ component }), so it only exists while the
// extension is enabled and disappears the moment it's disabled. Lets the user
// point Safelight at a local folder of built extensions to load them live.

import { useDevFolder, pickDevFolder, scanDevFolder, setDevFolder } from "./dev-folder";

const btn =
  "shrink-0 rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40";

export function DevSettings() {
  const folder = useDevFolder((s) => s.folder);
  const items = useDevFolder((s) => s.items);
  const scanning = useDevFolder((s) => s.scanning);
  const error = useDevFolder((s) => s.error);
  const native = window.safelightNative;
  const loadedCount = items.filter((i) => i.status === "loaded").length;
  const errorCount = items.filter((i) => i.status === "error").length;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[10px] uppercase tracking-widest text-text-muted">
          Development extensions folder
        </div>
        <p className="mt-1.5 text-[10px] leading-relaxed text-text-muted">
          Point Safelight at a local folder of built extensions to load them
          live, without installing through GitHub. Each immediate subfolder is
          one extension — a <code>safelight.json</code> manifest plus its built
          bundle, the same layout an installed extension uses. Loaded extensions
          appear under Extensions ▸ Dev.
        </p>
      </div>

      {!native ? (
        <p className="text-[11px] text-text-muted">
          Loading extensions from a folder requires the desktop app.
        </p>
      ) : (
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
      )}
    </div>
  );
}
