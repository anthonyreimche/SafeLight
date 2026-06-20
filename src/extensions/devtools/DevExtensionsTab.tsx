// The "Dev" tab inside the Extensions window. Lists the extensions discovered
// in the configured dev folder with their load status, and lets the developer
// rescan or reload one after rebuilding it. Rendered by ExtensionManagerPanel
// only while the Developer Tools extension is enabled, so the whole tab — and
// everything behind it — vanishes when that extension is disabled.

import { useState } from "react";
import {
  reloadDevExtension,
  pickDevFolder,
  scanDevFolder,
  setDevFolder,
  useDevFolder,
  type DevExtItem,
} from "./dev-folder";

const btn =
  "shrink-0 rounded bg-surface-3 px-2 py-1 text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40";

export function DevExtensionsTab() {
  const folder = useDevFolder((s) => s.folder);
  const items = useDevFolder((s) => s.items);
  const scanning = useDevFolder((s) => s.scanning);
  const error = useDevFolder((s) => s.error);

  if (!window.safelightNative) {
    return (
      <div className="text-text-muted">
        Loading extensions from a folder requires the desktop app.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-text-muted">
        Load locally-built extensions straight from a folder on disk — no GitHub
        install needed. Each subfolder is one extension (a safelight.json
        manifest plus its built bundle). Also configurable in Preferences ▸
        Developer Tools.
      </p>

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

      {!folder ? (
        <div className="text-text-muted">
          Choose a folder to scan for development extensions.
        </div>
      ) : items.length === 0 ? (
        <div className="text-text-muted">
          {scanning
            ? "Scanning…"
            : "No extensions found. Each one is a subfolder with a safelight.json manifest and its built bundle."}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          {items.map((it) => (
            <DevRow key={it.dir} item={it} />
          ))}
        </div>
      )}
    </div>
  );
}

function DevRow({ item }: { item: DevExtItem }) {
  const [busy, setBusy] = useState(false);
  const reload = () => {
    setBusy(true);
    void reloadDevExtension(item.dir).finally(() => setBusy(false));
  };
  const loaded = item.status === "loaded";
  return (
    <div className="flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5">
      <div className="min-w-0 flex-1">
        <div className="truncate text-text-primary">
          {item.name}
          {item.version && (
            <span className="text-text-muted"> v{item.version}</span>
          )}
          <span
            className={`ml-1.5 rounded px-1 py-px text-[9px] uppercase tracking-wider ${
              loaded
                ? "bg-emerald-500/20 text-emerald-400"
                : "bg-red-500/20 text-red-400"
            }`}
          >
            {loaded ? "Loaded" : "Error"}
          </span>
        </div>
        <div className="truncate text-text-muted" title={item.dir}>
          {item.dir}
        </div>
        {item.error && <div className="mt-0.5 text-red-400">{item.error}</div>}
      </div>
      <button
        onClick={reload}
        disabled={busy}
        title="Reload this extension from disk"
        className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary disabled:opacity-40"
      >
        {busy ? "…" : "↻ Reload"}
      </button>
    </div>
  );
}
