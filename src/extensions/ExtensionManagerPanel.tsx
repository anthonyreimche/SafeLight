// Built-in extension manager, rendered inside the Extensions pop-up with a
// Preferences-style sidebar:
//   • Browse    — quick search of official extensions (GitHub repos tagged with
//                 the safelight-extension topic), showing only uninstalled ones,
//                 plus an importer for a custom repo.
//   • Installed — everything already present: installed extensions first, then
//                 the pre-installed built-ins.
// Install / uninstall / search need the Electron bridge; the plain browser
// build manages built-ins only.

import { useEffect, useRef, useState } from "react";
import type { ExtensionManifest, ExtensionSearchResult } from "./types";
import {
  installFromGitHub,
  setExtensionEnabled,
  uninstallPlugin,
  useDisabledExtensions,
} from "./loader";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { useRegistry } from "./registry";
import { useSettings } from "@/state/settings-store";
import { openPreferences } from "@/ui/components/PreferencesDialog";
import { closeExtensions } from "@/ui/components/ExtensionsDialog";

// Remember which repo each installed extension came from, so search results
// can tell which official extensions are already installed.
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
const forgetSource = (manifestId: string) => {
  try {
    const { [manifestId]: _, ...rest } = readSources();
    localStorage.setItem(SOURCES_KEY, JSON.stringify(rest));
  } catch {}
};
// Drop remembered sources whose extension is no longer installed (e.g. an
// uninstall that never cleaned up) so search results don't stay "Installed".
const pruneSources = (installed: ExtensionManifest[]) => {
  const src = readSources();
  const ids = new Set(installed.map((m) => m.id));
  const kept = Object.entries(src).filter(([id]) => ids.has(id));
  if (kept.length !== Object.keys(src).length) {
    try {
      localStorage.setItem(SOURCES_KEY, JSON.stringify(Object.fromEntries(kept)));
    } catch {}
  }
};

type Section = "Browse" | "Installed";

export function ExtensionManagerPanel() {
  const native = window.safelightNative;
  const topic = useSettings((s) => s.extensionTopic);
  const disabledIds = useDisabledExtensions((s) => s.ids);
  const extSettings = useRegistry((s) => s.settings);
  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [spec, setSpec] = useState("");
  const [busy, setBusy] = useState<string | null>(null); // spec being installed
  const [msg, setMsg] = useState<string | null>(null);
  // The ⚙ button deep-links into Preferences ▸ Extensions (this extension's
  // section), replacing the old standalone per-extension dialog.
  const openSettings = (id: string) => {
    closeExtensions();
    openPreferences(id);
  };
  // Browse needs the bridge; default browser builds to the Installed view.
  const [section, setSection] = useState<Section>(native ? "Browse" : "Installed");
  const searchSeq = useRef(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  const refresh = () => {
    native?.plugins
      .list()
      .then((l) => {
        setList(l);
        pruneSources(l);
      })
      .catch(() => setList([]));
  };
  useEffect(refresh, [reloadNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fetch the installed list and re-run the search.
  const reload = () => {
    setMsg(null);
    setReloadNonce((n) => n + 1);
  };

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
  }, [query, topic, native, reloadNonce]);

  const install = async (installSpec: string, fromSearch?: ExtensionSearchResult) => {
    setBusy(installSpec);
    setMsg(null);
    try {
      const manifest = await installFromGitHub(installSpec);
      if (fromSearch) rememberSource(manifest.id, fromSearch.fullName);
      else setSpec(""); // clear the custom-import field on success
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
      await uninstallPlugin(id); // unloads, sweeps settings, deletes its files
      forgetSource(id); // search results show "Install" again
      setMsg("Removed (files deleted).");
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const toggle = (id: string, enable: boolean) => {
    setMsg(null);
    void setExtensionEnabled(id, enable).catch((e) =>
      setMsg(e instanceof Error ? e.message : String(e)),
    );
  };

  // An official result counts as installed when its repo is remembered AND the
  // extension is actually in the installed list — a stale source alone doesn't.
  const installedIds = new Set(list.map((m) => m.id));
  const installedRepos = new Set(
    Object.entries(readSources())
      .filter(([id]) => installedIds.has(id))
      .map(([, fullName]) => fullName),
  );
  const isInstalled = (r: ExtensionSearchResult) =>
    installedRepos.has(r.fullName.toLowerCase());
  const enabled = (id: string) => !disabledIds.includes(id);

  // Browse shows only what isn't installed yet.
  const browsable = results?.filter((r) => !isInstalled(r)) ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="w-28 shrink-0 border-r border-border bg-surface-0/40 py-2">
        {(["Browse", "Installed"] as Section[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`block w-full px-3 py-1.5 text-left text-[11px] tracking-wider ${
              section === s
                ? "bg-surface-3 text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-3 text-[11px]">
        {section === "Browse" ? (
          native ? (
            <div className="flex flex-col gap-3">
              {/* Quick search */}
              <div>
                <div className="flex items-center gap-1.5">
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search official extensions…"
                    spellCheck={false}
                    className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
                  />
                  <button
                    onClick={reload}
                    disabled={searching}
                    title="Reload the extension list and search results"
                    className="rounded px-1.5 text-[12px] leading-none text-text-muted hover:text-text-primary disabled:opacity-40"
                  >
                    ↻
                  </button>
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  {searching && browsable === null && (
                    <div className="text-text-muted">Searching…</div>
                  )}
                  {browsable?.length === 0 && !searching && (
                    <div className="text-text-muted">
                      No new extensions found{query ? ` for “${query}”` : ""}{" "}
                      (topic: {topic}).
                    </div>
                  )}
                  {browsable?.map((r) => (
                    <div
                      key={r.fullName}
                      className="flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-text-primary">
                          {r.fullName}
                          {r.stars > 0 && (
                            <span className="ml-1.5 text-text-muted">
                              ★ {r.stars}
                            </span>
                          )}
                        </div>
                        {r.description && (
                          <div className="truncate text-text-muted">
                            {r.description}
                          </div>
                        )}
                      </div>
                      <button
                        disabled={busy !== null}
                        onClick={() => void install(r.fullName, r)}
                        className="shrink-0 rounded bg-slider-fill px-2 py-0.5 font-medium text-white hover:opacity-80 disabled:opacity-40"
                      >
                        {busy === r.fullName ? "…" : "Install"}
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              {msg && <div className="text-text-secondary">{msg}</div>}

              {/* Import custom extension */}
              <div className="border-t border-border-subtle pt-3">
                <SectionLabel>Import custom extension</SectionLabel>
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
                    {busy === spec.trim() ? "…" : "Import"}
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="text-text-muted">
              Installing extensions requires the desktop app. Built-in extensions
              can still be managed under Installed.
            </div>
          )
        ) : (
          // ── Installed: external installs first, then the built-ins ──
          <div className="flex flex-col gap-3">
            {native && (
              <div>
                <SectionLabel>Installed</SectionLabel>
                {list.length === 0 ? (
                  <div className="mt-1 text-text-muted">
                    No extensions installed. Extensions register panels, themes
                    and layouts that appear in the View menu and Preferences.
                  </div>
                ) : (
                  <div className="mt-1 flex flex-col gap-1.5">
                    {list.map((m) => (
                      <ExtensionRow
                        key={m.id}
                        name={m.name}
                        version={m.version}
                        description={m.description}
                        enabled={enabled(m.id)}
                        busy={busy !== null}
                        hasSettings={!!extSettings[m.id]}
                        onSettings={() => openSettings(m.id)}
                        onToggle={() => toggle(m.id, !enabled(m.id))}
                        onUninstall={() => void remove(m.id)}
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            <div>
              <SectionLabel>Built-in</SectionLabel>
              <div className="mt-1 flex flex-col gap-1.5">
                {BUILTIN_EXTENSIONS.map((b) => (
                  <ExtensionRow
                    key={b.id}
                    name={b.name}
                    version={b.version}
                    description={b.description}
                    enabled={b.locked || enabled(b.id)}
                    locked={b.locked}
                    busy={busy !== null}
                    hasSettings={!!extSettings[b.id]}
                    onSettings={() => openSettings(b.id)}
                    onToggle={() => toggle(b.id, !enabled(b.id))}
                  />
                ))}
              </div>
            </div>

            {msg && <div className="text-text-secondary">{msg}</div>}
          </div>
        )}
      </div>

    </div>
  );
}

// One installed/built-in extension: name, version, description, then the
// settings ⚙ (always available while enabled — extensions without a registered
// dialog get the generic editor), an enable toggle (hidden for locked core),
// and Uninstall (external only).
function ExtensionRow({
  name,
  version,
  description,
  enabled,
  locked,
  busy,
  hasSettings,
  onSettings,
  onToggle,
  onUninstall,
}: {
  name: string;
  version: string;
  description?: string;
  enabled: boolean;
  locked?: boolean;
  busy: boolean;
  hasSettings: boolean;
  onSettings: () => void;
  onToggle: () => void;
  onUninstall?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className={`flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5 ${
        enabled ? "" : "opacity-55"
      }`}
    >
      <div className="min-w-0">
        <div className="truncate text-text-primary">
          {name} <span className="text-text-muted">v{version}</span>
          {locked && (
            <span className="ml-1.5 rounded bg-surface-3 px-1 py-px text-[9px] uppercase tracking-wider text-text-muted">
              Core
            </span>
          )}
        </div>
        {description && (
          <div
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? "Click to collapse" : "Click to show full description"}
            className={`cursor-pointer text-text-muted ${expanded ? "" : "truncate"}`}
          >
            {description}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {hasSettings && enabled && (
          <button
            onClick={onSettings}
            title={`${name} settings`}
            className="rounded px-1 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary"
          >
            ⚙
          </button>
        )}
        {!locked && (
          <button
            disabled={busy}
            onClick={onToggle}
            title={enabled ? "Disable (keeps files and settings)" : "Enable"}
            className={`relative h-4 w-7 rounded-full transition-colors ${
              enabled ? "bg-slider-fill" : "bg-surface-3"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                enabled ? "left-3.5" : "left-0.5"
              }`}
            />
          </button>
        )}
        {onUninstall && (
          <button
            disabled={busy}
            onClick={onUninstall}
            title="Remove the extension and delete its files"
            className="rounded px-1.5 py-0.5 text-text-muted hover:bg-surface-4 hover:text-text-primary"
          >
            Uninstall
          </button>
        )}
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
