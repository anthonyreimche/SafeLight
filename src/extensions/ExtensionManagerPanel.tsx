// Built-in extension manager (View ▸ Extensions): lists installed plugins,
// installs from a GitHub repo, uninstalls. Install/uninstall need the Electron
// bridge; in the plain browser build it's read-only.

import { useEffect, useState } from "react";
import type { ExtensionManifest } from "./types";
import { installFromGitHub, uninstallPlugin } from "./loader";

export function ExtensionManagerPanel() {
  const native = window.safelightNative;
  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => {
    native?.plugins
      .list()
      .then(setList)
      .catch(() => setList([]));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!native) {
    return (
      <div className="p-3 text-[11px] text-text-muted">
        Installing extensions requires the desktop app.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 text-[11px]">
      <div className="flex gap-1.5">
        <input
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && spec.trim() && !busy)
              void run(() => installFromGitHub(spec.trim()), "Installed.");
          }}
          placeholder="github: owner/repo or owner/repo#branch"
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
        />
        <button
          disabled={busy || !spec.trim()}
          onClick={() => void run(() => installFromGitHub(spec.trim()), "Installed.")}
          className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          {busy ? "…" : "Install"}
        </button>
      </div>

      {msg && <div className="text-text-secondary">{msg}</div>}

      {list.length === 0 ? (
        <div className="text-text-muted">
          No extensions installed. Extensions are GitHub repos with a
          safelight.json manifest; panels they register appear in the View menu
          and sidebars.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {list.map((m) => (
            <div
              key={m.id}
              className="flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate text-text-primary">
                  {m.name}{" "}
                  <span className="text-text-muted">v{m.version}</span>
                </div>
                {m.description && (
                  <div className="truncate text-text-muted">{m.description}</div>
                )}
              </div>
              <button
                disabled={busy}
                onClick={() => void run(() => uninstallPlugin(m.id), "Removed.")}
                className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary"
              >
                Uninstall
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
