// Built-in extension manager (View ▸ Extensions): browses official extensions
// (GitHub repos tagged with the safelight-extension topic) with live search,
// lists installed plugins, and still accepts a custom repo spec. Install /
// uninstall / search need the Electron bridge; the plain browser build is
// read-only.

import { useEffect, useRef, useState } from "react";
import type { ExtensionManifest, ExtensionSearchResult } from "./types";
import { installFromGitHub, uninstallPlugin } from "./loader";
import { useSettings } from "@/state/settings-store";

// Remember which repo each installed extension came from, so search results
// can show an "Installed" state across sessions.
const SOURCES_KEY = "sl_ext_sources";
const readSources = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SOURCES_KEY) ?? "{}");
  } catch {
    return {};
  }
};
const rememberSource = (manifestId: string, fullName: string) => {
  try {
    localStorage.setItem(
      SOURCES_KEY,
      JSON.stringify({ ...readSources(), [manifestId]: fullName.toLowerCase() }),
    );
  } catch {}
};

export function ExtensionManagerPanel() {
  const native = window.safelightNative;
  const topic = useSettings((s) => s.extensionTopic);
  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // spec being installed
  const [msg, setMsg] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const refresh = () => {
    native?.plugins
      .list()
      .then(setList)
      .catch(() => setList([]));
  };
  useEffect(refresh, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Official-extension search: runs on open and (debounced) as you type.
  // Older native builds lack plugins.search — fail soft to the manual input.
  useEffect(() => {
    if (!native?.plugins.search) return;
    const seq = ++searchSeq.current;
    setSearching(true);
    const t = setTimeout(() => {
      native.plugins
        .search(query.trim(), topic)
        .then((r) => {
          if (searchSeq.current !== seq) return;
          setResults(r);
          setMsg(null);
        })
        .catch((e) => {
          if (searchSeq.current !== seq) return;
          setResults([]);
          setMsg(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (searchSeq.current === seq) setSearching(false);
        });
    }, query ? 350 : 0);
    return () => clearTimeout(t);
  }, [query, topic, native]);

  const install = async (installSpec: string, fromSearch?: ExtensionSearchResult) => {
    setBusy(installSpec);
    setMsg(null);
    try {
      const manifest = await installFromGitHub(installSpec);
      if (fromSearch) rememberSource(manifest.id, fromSearch.fullName);
      setMsg(`Installed ${manifest.name}.`);
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setMsg(null);
    try {
      await uninstallPlugin(id);
      setMsg("Removed.");
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  if (!native) {
    return (
      <div className="p-3 text-[11px] text-text-muted">
        Installing extensions requires the desktop app.
      </div>
    );
  }

  const sources = readSources();
  const installedRepos = new Set(Object.values(sources));
  const isInstalled = (r: ExtensionSearchResult) =>
    installedRepos.has(r.fullName.toLowerCase());

  return (
    <div className="flex flex-col gap-3 p-3 text-[11px]">
      {/* ── Browse official extensions ── */}
      <div>
        <SectionLabel>Browse official extensions</SectionLabel>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search official extensions…"
          spellCheck={false}
          className="mt-1 w-full rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
        />
        <div className="mt-2 flex flex-col gap-1.5">
          {searching && results === null && (
            <div className="text-text-muted">Searching…</div>
          )}
          {results?.length === 0 && !searching && (
            <div className="text-text-muted">
              No extensions found{query ? ` for “${query}”` : ""} (topic:{" "}
              {topic}).
            </div>
          )}
          {results?.map((r) => {
            const installed = isInstalled(r);
            return (
              <div
                key={r.fullName}
                className="flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-text-primary">
                    {r.fullName}
                    {r.stars > 0 && (
                      <span className="ml-1.5 text-text-muted">★ {r.stars}</span>
                    )}
                  </div>
                  {r.description && (
                    <div className="truncate text-text-muted">
                      {r.description}
                    </div>
                  )}
                </div>
                <button
                  disabled={busy !== null || installed}
                  onClick={() => void install(r.fullName, r)}
                  className={`shrink-0 rounded px-2 py-0.5 font-medium ${
                    installed
                      ? "text-text-muted"
                      : "bg-accent text-white hover:bg-accent-hover disabled:opacity-40"
                  }`}
                >
                  {installed
                    ? "Installed"
                    : busy === r.fullName
                      ? "…"
                      : "Install"}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {msg && <div className="text-text-secondary">{msg}</div>}

      {/* ── Installed ── */}
      <div>
        <SectionLabel>Installed</SectionLabel>
        {list.length === 0 ? (
          <div className="mt-1 text-text-muted">
            No extensions installed. Extensions register panels, themes and
            layouts that appear in the View menu and Preferences.
          </div>
        ) : (
          <div className="mt-1 flex flex-col gap-1.5">
            {list.map((m) => (
              <div
                key={m.id}
                className="flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-text-primary">
                    {m.name} <span className="text-text-muted">v{m.version}</span>
                  </div>
                  {m.description && (
                    <div className="truncate text-text-muted">
                      {m.description}
                    </div>
                  )}
                </div>
                <button
                  disabled={busy !== null}
                  onClick={() => void remove(m.id)}
                  className="shrink-0 rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary"
                >
                  Uninstall
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Manual install ── */}
      <div>
        <SectionLabel>Install from URL</SectionLabel>
        <div className="mt-1 flex gap-1.5">
          <input
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && spec.trim() && busy === null)
                void install(spec.trim());
            }}
            placeholder="owner/repo, owner/repo#branch, or GitHub URL"
            spellCheck={false}
            className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
          />
          <button
            disabled={busy !== null || !spec.trim()}
            onClick={() => void install(spec.trim())}
            className="rounded bg-surface-3 px-2.5 py-1 font-medium text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40"
          >
            {busy === spec.trim() ? "…" : "Install"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[9px] uppercase tracking-widest text-text-muted">
      {children}
    </div>
  );
}
