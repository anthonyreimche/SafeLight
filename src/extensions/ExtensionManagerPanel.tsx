// Built-in extension manager, rendered inside the Extensions window as a
// Preferences-style master/detail "store":
//   • Browse    — search official extensions (GitHub repos tagged with the
//                 safelight-extension topic), shown as preview cards with
//                 category chips + a sort control, plus a custom-repo importer.
//   • Installed — installed extensions first (with update badges), then the
//                 pre-installed built-ins.
// Clicking a card or row opens a detail page (README + metadata). Install /
// uninstall / search / update need the Electron bridge; the plain browser build
// manages built-ins only.

import { useEffect, useRef, useState } from "react";
import type { ExtensionManifest, ExtensionSearchResult } from "./types";
import {
  checkExtensionUpdate,
  installFromGitHub,
  setExtensionEnabled,
  uninstallPlugin,
  updateExtension,
  useDisabledExtensions,
} from "./loader";
import { BUILTIN_EXTENSIONS } from "./builtin";
import { useRegistry } from "./registry";
import { useSettings } from "@/state/settings-store";
import { openPreferences } from "@/ui/components/PreferencesDialog";
import { closeExtensions } from "@/ui/components/ExtensionsDialog";
import {
  forgetSource,
  pruneSources,
  readSources,
  rememberSource,
  repoFor,
} from "./sources";
import {
  CATEGORY_ORDER,
  categoryFor,
  useExtStoreUI,
  type StoreSort,
} from "./store-ui";
import { ExtensionDetail, type DetailTarget } from "./ExtensionDetail";
import { DevExtensionsTab } from "./devtools/DevExtensionsTab";

type Section = "Browse" | "Installed" | "Dev";

const SORTS: { id: StoreSort; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "updated", label: "Recent" },
  { id: "name", label: "Name" },
];

export function ExtensionManagerPanel() {
  const native = window.safelightNative;
  const topic = useSettings((s) => s.extensionTopic);
  const checkUpdates = useSettings((s) => s.checkExtensionUpdates);
  const disabledIds = useDisabledExtensions((s) => s.ids);
  // The Dev tab rides along with the Developer Tools extension: it only exists
  // while that extension is enabled, mirroring its top-bar bug button.
  const devtoolsEnabled = !disabledIds.includes("core.devtools");
  const extSettings = useRegistry((s) => s.settings);
  const view = useExtStoreUI((s) => s.view);
  const selected = useExtStoreUI((s) => s.selected);
  const category = useExtStoreUI((s) => s.category);
  const sort = useExtStoreUI((s) => s.sort);
  const updates = useExtStoreUI((s) => s.updates);
  const openDetail = useExtStoreUI((s) => s.openDetail);
  const back = useExtStoreUI((s) => s.back);

  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[] | null>(null);
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [spec, setSpec] = useState("");
  const [installedQuery, setInstalledQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // The settings button deep-links into Preferences ▸ Extensions.
  const openSettings = (id: string) => {
    closeExtensions();
    openPreferences(id);
  };
  const [section, setSection] = useState<Section>(native ? "Browse" : "Installed");
  const searchSeq = useRef(0);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Always open to the list, not a stale detail page from a previous session.
  useEffect(() => back(), [back]);

  // If Developer Tools is disabled while the Dev tab is open, fall back.
  useEffect(() => {
    if (section === "Dev" && !devtoolsEnabled)
      setSection(native ? "Browse" : "Installed");
  }, [section, devtoolsEnabled, native]);

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

  // Refresh update badges for installed extensions (TTL-guarded, so cheap if the
  // launch check already ran). Catches the case where the dialog is opened
  // before/without the boot check. Respects the user's update-check setting.
  useEffect(() => {
    if (!checkUpdates) return;
    for (const m of list) void checkExtensionUpdate(m);
  }, [list, checkUpdates]);

  const reload = () => {
    setMsg(null);
    setReloadNonce((n) => n + 1);
  };

  // Official-extension search: runs on open and (debounced) as you type.
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
      else setSpec("");
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
      forgetSource(id);
      setMsg("Removed (files deleted).");
      if (view === "detail") back(); // leave the now-removed extension's page
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const update = async (id: string, repo: string, tag: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const manifest = await updateExtension(id, repo, tag);
      setMsg(`Updated ${manifest.name} to ${tag}.`);
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

  const installedIds = new Set(list.map((m) => m.id));
  const installedRepos = new Set(
    Object.entries(readSources())
      .filter(([id]) => installedIds.has(id))
      .map(([, fullName]) => fullName),
  );
  const isInstalled = (r: ExtensionSearchResult) =>
    installedRepos.has(r.fullName.toLowerCase());
  const enabled = (id: string) => !disabledIds.includes(id);

  // Browse shows only what isn't installed, filtered by category and sorted.
  const browsable = (() => {
    let rs = results?.filter((r) => !isInstalled(r)) ?? null;
    if (!rs) return null;
    if (category !== "All")
      rs = rs.filter((r) => categoryFor(r.topics) === category);
    const sorted = [...rs];
    if (sort === "name")
      sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    else if (sort === "updated")
      sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    else sorted.sort((a, b) => b.stars - a.stars);
    return sorted;
  })();

  // ── Detail target resolution ───────────────────────────────────────────────
  // `selected` is "owner/repo" for repo-backed extensions, or an id for built-ins
  // and installed extensions without a known repo.
  const buildTarget = (sel: string): DetailTarget | null => {
    if (sel.includes("/")) {
      const lower = sel.toLowerCase();
      const manifest = list.find((m) => repoFor(m)?.toLowerCase() === lower);
      const search = results?.find((r) => r.fullName.toLowerCase() === lower);
      const name = manifest?.name ?? sel.split("/")[1] ?? sel;
      return {
        repo: sel, // sel is the "owner/repo" we opened the detail with
        name,
        description: manifest?.description ?? search?.description ?? undefined,
        author: manifest?.author,
        installed: !!manifest,
        manifest,
        enabled: manifest ? enabled(manifest.id) : false,
        locked: false,
        hasSettings: manifest ? !!extSettings[manifest.id] : false,
        search,
      };
    }
    const builtin = BUILTIN_EXTENSIONS.find((b) => b.id === sel);
    if (builtin) {
      return {
        repo: null,
        name: builtin.name,
        description: builtin.description,
        installed: true,
        enabled: builtin.locked || enabled(builtin.id),
        locked: !!builtin.locked,
        hasSettings: !!extSettings[builtin.id],
      };
    }
    const manifest = list.find((m) => m.id === sel);
    if (manifest) {
      const repo = repoFor(manifest);
      return {
        repo,
        name: manifest.name,
        description: manifest.description,
        author: manifest.author,
        installed: true,
        manifest,
        enabled: enabled(manifest.id),
        locked: false,
        hasSettings: !!extSettings[manifest.id],
      };
    }
    return null;
  };

  const target = view === "detail" && selected ? buildTarget(selected) : null;

  // ── Detail view ────────────────────────────────────────────────────────────
  if (target) {
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <button
          onClick={back}
          className="flex h-7 shrink-0 items-center gap-1 border-b border-border-subtle px-3 text-[11px] text-text-secondary hover:text-text-primary"
        >
          ← Back
        </button>
        <ExtensionDetail
          target={target}
          busy={busy}
          onInstall={(s) => void install(s, target.search)}
          onUpdate={(id, repo, tag) => void update(id, repo, tag)}
          onUninstall={(id) => void remove(id)}
          onToggle={toggle}
          onSettings={openSettings}
        />
        {msg && (
          <div className="shrink-0 border-t border-border-subtle px-3 py-1.5 text-[11px] text-text-secondary">
            {msg}
          </div>
        )}
      </div>
    );
  }

  // ── List view ──────────────────────────────────────────────────────────────
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="w-28 shrink-0 border-r border-border bg-surface-0/40 py-2">
        {([
          "Browse",
          "Installed",
          ...(devtoolsEnabled ? (["Dev"] as Section[]) : []),
        ] as Section[]).map((s) => (
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
        {section === "Dev" && devtoolsEnabled ? (
          <DevExtensionsTab />
        ) : section === "Browse" ? (
          native ? (
            <div className="flex flex-col gap-3">
              {/* Search + sort */}
              <div className="flex items-center gap-1.5">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search official extensions…"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
                />
                <select
                  value={sort}
                  onChange={(e) =>
                    useExtStoreUI.getState().setSort(e.target.value as StoreSort)
                  }
                  title="Sort"
                  className="rounded bg-surface-2 px-1.5 py-1 text-text-secondary outline-none focus:bg-surface-3"
                >
                  {SORTS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={reload}
                  disabled={searching}
                  title="Reload the extension list and search results"
                  className="rounded px-1.5 text-[12px] leading-none text-text-muted hover:text-text-primary disabled:opacity-40"
                >
                  ↻
                </button>
              </div>

              {/* Category chips */}
              <div className="flex flex-wrap gap-1">
                {CATEGORY_ORDER.map((c) => (
                  <button
                    key={c}
                    onClick={() => useExtStoreUI.getState().setCategory(c)}
                    className={`rounded-full px-2 py-0.5 text-[10px] ${
                      category === c
                        ? "bg-slider-fill text-white"
                        : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>

              {/* Result cards */}
              {searching && browsable === null ? (
                <div className="text-text-muted">Searching…</div>
              ) : browsable && browsable.length === 0 ? (
                <div className="text-text-muted">
                  No new extensions found
                  {query ? ` for “${query}”` : ""}
                  {category !== "All" ? ` in ${category}` : ""} (topic: {topic}).
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {browsable?.map((r, i) => (
                    <ExtensionCard
                      key={r.fullName}
                      index={i}
                      result={r}
                      installing={busy === r.fullName}
                      disabled={busy !== null}
                      onOpen={() => openDetail(r.fullName)}
                      onInstall={() => void install(r.fullName, r)}
                    />
                  ))}
                </div>
              )}

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
          (() => {
            const iq = installedQuery.trim().toLowerCase();
            const match = (name: string, desc?: string) =>
              !iq ||
              name.toLowerCase().includes(iq) ||
              (desc ?? "").toLowerCase().includes(iq);
            const installed = list.filter((m) => match(m.name, m.description));
            const builtins = BUILTIN_EXTENSIONS.filter((b) =>
              match(b.name, b.description),
            );
            return (
              <div className="flex flex-col gap-3">
                <input
                  value={installedQuery}
                  onChange={(e) => setInstalledQuery(e.target.value)}
                  placeholder="Filter installed extensions…"
                  spellCheck={false}
                  className="rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
                />

                {native && (
                  <div>
                    <SectionLabel>Installed</SectionLabel>
                    {list.length === 0 ? (
                      <div className="mt-1 text-text-muted">
                        No extensions installed. Extensions register panels,
                        themes and layouts that appear in the View menu and
                        Preferences.
                      </div>
                    ) : installed.length === 0 ? (
                      <div className="mt-1 text-text-muted">No matches.</div>
                    ) : (
                      <div className="mt-1 flex flex-col gap-1.5">
                        {installed.map((m) => {
                          const upd = updates[m.id];
                          const repo = repoFor(m);
                          const canUpdate =
                            !!upd?.hasUpdate && !!upd.latestTag && !!repo;
                          return (
                            <ExtensionRow
                              key={m.id}
                              name={m.name}
                              version={m.version}
                              description={m.description}
                              enabled={enabled(m.id)}
                              busy={busy !== null}
                              hasSettings={!!extSettings[m.id]}
                              onOpen={() => openDetail(repo ?? m.id)}
                              onUpdate={
                                canUpdate
                                  ? () => void update(m.id, repo!, upd!.latestTag!)
                                  : undefined
                              }
                              onSettings={() => openSettings(m.id)}
                              onToggle={() => toggle(m.id, !enabled(m.id))}
                              onUninstall={() => void remove(m.id)}
                            />
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}

                <div>
                  <SectionLabel>Built-in</SectionLabel>
                  {builtins.length === 0 ? (
                    <div className="mt-1 text-text-muted">No matches.</div>
                  ) : (
                    <div className="mt-1 flex flex-col gap-1.5">
                      {builtins.map((b) => (
                        <ExtensionRow
                          key={b.id}
                          name={b.name}
                          version={b.version}
                          description={b.description}
                          enabled={b.locked || enabled(b.id)}
                          locked={b.locked}
                          busy={busy !== null}
                          hasSettings={!!extSettings[b.id]}
                          onOpen={() => openDetail(b.id)}
                          onSettings={() => openSettings(b.id)}
                          onToggle={() => toggle(b.id, !enabled(b.id))}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {msg && <div className="text-text-secondary">{msg}</div>}
              </div>
            );
          })()
        )}
      </div>
    </div>
  );
}

// A browse-result preview card: repo thumbnail, name, description, stars, and a
// category tag. Clicking the body opens the detail page; Install stays inline.
function ExtensionCard({
  index,
  result,
  installing,
  disabled,
  onOpen,
  onInstall,
}: {
  index: number;
  result: ExtensionSearchResult;
  installing: boolean;
  disabled: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const cat = categoryFor(result.topics);
  const short = result.fullName.split("/")[1] ?? result.fullName;
  const cardRef = useRef<HTMLDivElement>(null);
  const [imgLoaded, setImgLoaded] = useState(false);
  // Start on GitHub's auto card (instant, no round-trip), then resolve the repo's
  // real og:image. We only swap when it's an actual custom social preview (served
  // off repository-images.githubusercontent.com); a repo with no preview resolves
  // back to an opengraph.githubassets.com card identical to what we already show,
  // so we skip the redundant reload.
  const [thumb, setThumb] = useState(
    `https://opengraph.githubassets.com/1/${result.fullName}`,
  );
  useEffect(() => {
    const gh = window.safelightNative?.github;
    if (!gh?.ogImage) return;
    let alive = true;
    gh.ogImage(result.fullName)
      .then((url) => {
        if (alive && url && !url.startsWith("https://opengraph.githubassets.com/"))
          setThumb(url);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [result.fullName]);

  // Cascade the cards in instead of popping the whole grid at once: each card
  // fades/rises in, staggered by its position (capped so a full page of 25 still
  // finishes quickly). `fill: backwards` holds it hidden until its turn. Honour
  // reduced-motion by leaving the card at its natural (visible) style.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      return;
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: 240,
        delay: Math.min(index * 35, 420),
        easing: "ease-out",
        fill: "backwards",
      },
    );
    return () => anim.cancel();
    // Mount-only: index is the position at first paint; re-filtering remounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      ref={cardRef}
      className="flex flex-col overflow-hidden rounded border border-border-subtle bg-surface-2"
    >
      <button onClick={onOpen} className="block text-left">
        <div className="aspect-[2/1] w-full overflow-hidden bg-surface-3">
          <img
            src={thumb}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            // Fade each thumbnail up from the grey placeholder as it arrives,
            // so they appear progressively rather than all snapping in at once.
            style={{
              opacity: imgLoaded ? 1 : 0,
              transition: "opacity 200ms ease-out",
            }}
            onLoad={() => setImgLoaded(true)}
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
        </div>
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-text-primary">
              {short}
            </span>
            {result.stars > 0 && (
              <span className="shrink-0 text-text-muted">★ {result.stars}</span>
            )}
          </div>
          {result.description && (
            <div className="mt-0.5 line-clamp-2 text-text-muted">
              {result.description}
            </div>
          )}
        </div>
      </button>
      <div className="flex items-center justify-between gap-2 px-2 pb-2">
        {cat !== "Other" ? (
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted">
            {cat}
          </span>
        ) : (
          <span />
        )}
        <button
          disabled={disabled}
          onClick={onInstall}
          className="shrink-0 rounded bg-slider-fill px-2 py-0.5 font-medium text-white hover:opacity-80 disabled:opacity-40"
        >
          {installing ? "…" : "Install"}
        </button>
      </div>
    </div>
  );
}

// One installed/built-in extension row: name, version, the description, then an
// Update button (when a newer release exists), settings, an enable toggle
// (hidden for locked core), and Uninstall (external only). Clicking the
// name/description opens the detail page.
function ExtensionRow({
  name,
  version,
  description,
  enabled,
  locked,
  busy,
  hasSettings,
  onOpen,
  onUpdate,
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
  onOpen: () => void;
  onUpdate?: () => void;
  onSettings: () => void;
  onToggle: () => void;
  onUninstall?: () => void;
}) {
  return (
    <div
      className={`flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5 ${
        enabled ? "" : "opacity-55"
      }`}
    >
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="truncate text-text-primary">
          {name} <span className="text-text-muted">v{version}</span>
          {locked && (
            <span className="ml-1.5 rounded bg-surface-3 px-1 py-px text-[9px] uppercase tracking-wider text-text-muted">
              Core
            </span>
          )}
        </div>
        {description && (
          <div className="truncate text-text-muted">{description}</div>
        )}
      </button>
      <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
        {onUpdate && (
          <button
            disabled={busy}
            onClick={onUpdate}
            title="A newer version is available — update now"
            className="rounded px-1.5 py-0.5 text-[10px] font-medium text-black hover:opacity-90 disabled:opacity-40"
            style={{ background: "var(--color-rating)" }}
          >
            Update
          </button>
        )}
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
