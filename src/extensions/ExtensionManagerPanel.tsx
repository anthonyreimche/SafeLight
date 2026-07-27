// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Built-in extension manager, rendered inside the Extensions window as a
// Preferences-style master/detail "store":
//   • Updates   — installed extensions with a newer GitHub release, each with
//                 an Update button. First in the sidebar so pending updates are
//                 the first thing seen; a badge shows the count.
//   • Browse    — search official extensions (GitHub repos tagged with the
//                 safelight-extension topic), shown as preview cards with
//                 category chips + a sort control, plus a custom-repo importer.
//   • Installed — installed extensions first (with update badges), then the
//                 pre-installed built-ins.
// Clicking a card or row opens a detail page (README + metadata). Install /
// uninstall / search / update need the Electron bridge; the plain browser build
// manages built-ins only.

import { useEffect, useRef, useState } from "react";
import type {
  ExtensionManifest,
  ExtensionSearchResult,
  ExtensionThumbnail,
} from "./types";
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
  rememberSource,
  repoFor,
} from "./sources";
import {
  CATEGORY_ORDER,
  categoryFor,
  useExtStoreUI,
  type StoreSort,
} from "./store-ui";
import {
  loadTrustList,
  isVerified,
  reviewedFor,
  bannedReason,
  repoFromSpec,
  useTrust,
  useIsVerified,
  useVerificationStatus,
  useReviewedFor,
  useBannedReason,
} from "./trust";
import { isNewer } from "@/update/semver";
import { VerifiedBadge, FlaggedBadge } from "./TrustBadges";
import { ExtensionDetail, type DetailTarget } from "./ExtensionDetail";
import { DevExtensionsTab } from "./devtools/DevExtensionsTab";

type Section = "Updates" | "Browse" | "Installed" | "Dev";

// One-time acknowledgment shown before the user's first extension install (verified
// or not): extensions are third-party code Safelight neither controls nor guarantees.
// Persisted in localStorage — it's a safety gate, not a tunable preference.
const RISK_ACK_KEY = "sl_ext_risk_ack_v1";
function hasAckedExtensionRisk(): boolean {
  try {
    return localStorage.getItem(RISK_ACK_KEY) === "1";
  } catch {
    return false;
  }
}
function setAckedExtensionRisk(): void {
  try {
    localStorage.setItem(RISK_ACK_KEY, "1");
  } catch {}
}

const SORTS: { id: StoreSort; label: string }[] = [
  { id: "popular", label: "Popular" },
  { id: "updated", label: "Recent" },
  { id: "name", label: "Name" },
];

export function ExtensionManagerPanel() {
  const native = window.safelightNative;
  const topic = useSettings((s) => s.extensionTopic);
  const checkUpdates = useSettings((s) => s.checkExtensionUpdates);
  const onlyVerified = useSettings((s) => s.onlyVerifiedExtensions);
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
  // Subscribed (not getState) so the Featured shelf recomputes once the trust
  // list arrives asynchronously — already lowercased by the main process.
  const verified = useTrust((s) => s.list.verified);

  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[] | null>(null);
  // Best thumbnail per repo, resolved in one batched main-process call when the
  // results change (manifest icon → custom social preview → avatar). Search
  // results already carry a warm-cache thumbnail for instant first paint; this
  // upgrades any that were resolved cold. Keyed by "owner/repo".
  const [thumbs, setThumbs] = useState<Record<string, ExtensionThumbnail>>({});
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
  // Tracks which reloadNonce the last search ran for, so an explicit reload
  // force-bypasses the main-process search cache while keystrokes keep using it.
  const lastSearchNonce = useRef(0);
  // Same idea for thumbnails: an explicit ↻ re-resolves icons/previews (bypassing
  // the icon/og caches) so a recently changed thumbnail isn't served stale.
  const lastThumbNonce = useRef(0);

  // Always open to the list, not a stale detail page from a previous session.
  useEffect(() => back(), [back]);

  // Pull the verified/banned lists so badges and install gating work even if the
  // window is opened before the boot-time load sweep. Non-forced: loadTrustList
  // fetches once per session (in-memory loadedAt), and the main process serves
  // that from its 6h disk cache, so opening the store costs no network when the
  // registry is fresh. A registry edit still appears on the next launch (or via
  // the panel's explicit refresh), without a round-trip on every open.
  useEffect(() => void loadTrustList(), []);

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
        useExtStoreUI.getState().pruneUpdates(l.map((m) => m.id));
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

  // Opening the Updates tab is an explicit ask, so check even when the automatic
  // update-check setting is off. Still TTL-guarded, so it's a no-op when fresh.
  useEffect(() => {
    if (section !== "Updates") return;
    for (const m of list) void checkExtensionUpdate(m);
  }, [section, list]);

  const reload = () => {
    setMsg(null);
    void loadTrustList(true); // explicit refresh = "show me the latest registry"
    setReloadNonce((n) => n + 1);
  };

  // Official-extension search: runs on open and (debounced) as you type.
  useEffect(() => {
    if (!native?.plugins.search) return;
    const seq = ++searchSeq.current;
    const force = lastSearchNonce.current !== reloadNonce;
    lastSearchNonce.current = reloadNonce;
    setSearching(true);
    const t = setTimeout(() => {
      native.plugins
        .search(query.trim(), topic, force)
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

  // Upgrade browse-card thumbnails via one batched main-process call (parallel,
  // per-fetch timeouts) rather than a round-trip per card. Cards paint instantly
  // from the avatar / warm-cache thumbnail carried in the search result; the main
  // process then pushes each real icon/preview as it resolves (onThumbnail), so a
  // slow repo never blocks the rest. The returned map is merged too, as a backstop
  // for anything an event missed.
  useEffect(() => {
    const gh = native?.github;
    if (!gh?.thumbnails || !results || results.length === 0) return;
    // Force a fresh resolution only when an explicit ↻ advanced the nonce; a new
    // results array from typing keeps using the caches.
    const force = lastThumbNonce.current !== reloadNonce;
    lastThumbNonce.current = reloadNonce;
    let alive = true;
    const merge = (map: Record<string, ExtensionThumbnail>) => {
      if (alive && map) setThumbs((prev) => ({ ...prev, ...map }));
    };
    const off = gh.onThumbnail?.(({ repo, thumb }) => merge({ [repo]: thumb }));
    gh.thumbnails(
      results.map((r) => ({ repo: r.fullName, avatar: r.avatarUrl ?? null })),
      force,
    )
      .then(merge)
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [results, native, reloadNonce]);

  const install = async (installSpec: string, fromSearch?: ExtensionSearchResult) => {
    const repo = fromSearch?.fullName.toLowerCase() ?? repoFromSpec(installSpec);
    // Banned: hard stop. The main process refuses it too — this is the faster,
    // clearer path so the user never watches a doomed download spin.
    const banned = repo ? bannedReason(repo) : null;
    if (banned) {
      setMsg(`Blocked — this extension is flagged as unsafe: ${banned}.`);
      return;
    }
    const verified = !!repo && isVerified(repo);
    // A pinned "verified" entry only covers the version that was reviewed. If the
    // repo has since moved to a newer version, the code we'd install is past the
    // review point — drop the green-light and treat it as an unverified install.
    const reviewedVersion =
      verified && repo ? reviewedFor(repo)?.version ?? null : null;
    let reviewedStale = false;
    if (reviewedVersion && repo) {
      try {
        const latest = await window.safelightNative?.plugins?.latestVersion?.(repo);
        if (latest && isNewer(reviewedVersion, latest)) reviewedStale = true;
      } catch {
        // Best-effort: don't block an install on a version-check network blip.
      }
    }
    const trusted = verified && !reviewedStale;
    // Strict mode: only reviewed extensions may be installed.
    if (onlyVerified && !trusted) {
      setMsg(
        reviewedStale
          ? `Blocked — “Only verified extensions” is on, and the current version is newer than the reviewed version${
              reviewedVersion ? ` (${reviewedVersion})` : ""
            }, so it isn't covered by verification.`
          : "Blocked — “Only verified extensions” is on and this one isn't on the verified allowlist (Preferences ▸ Extensions).",
      );
      return;
    }
    // First install ever (verified or not): a one-time acknowledgment that
    // extensions are third-party code Safelight neither controls nor guarantees,
    // and that "verified" is a point-in-time review, not a safety warranty.
    if (!hasAckedExtensionRisk()) {
      const ok = window.confirm(
        "Safelight extensions are third-party software — not made, controlled, or " +
          "guaranteed by Safelight. They install from GitHub and run with full access " +
          "to your photos, metadata, edits and files.\n\n" +
          "A “Verified” badge means a maintainer reviewed the code at a point in time. " +
          "It is not a guarantee of safety, and later updates may not be reviewed.\n\n" +
          "Install extensions at your own risk. Continue?",
      );
      if (!ok) return;
      setAckedExtensionRisk();
    }
    // Unreviewed (never verified, or verified but past the reviewed version): it
    // runs with full access, so make the user opt in explicitly. Code that matches
    // a verified review installs without this prompt.
    if (!trusted) {
      const ok = window.confirm(
        reviewedStale
          ? `${repo ?? installSpec} is verified only up to version ${reviewedVersion}. ` +
              "The current version is newer and has NOT been reviewed. It runs with full " +
              "access to your photos, metadata and files.\n\nInstall the unreviewed version anyway?"
          : `${repo ?? installSpec} hasn't been reviewed by Safelight.\n\n` +
              "Installed extensions run with full access to your photos, metadata and " +
              "edits. Only install extensions you trust.\n\nInstall anyway?",
      );
      if (!ok) return;
    }
    setBusy(installSpec);
    setMsg(null);
    try {
      const manifest = await installFromGitHub(installSpec);
      // Remember the source so update checks and installed-detection work for
      // custom imports too, not just search installs. A #branch pin tracks that
      // ref, not releases, so don't record it as a release-trackable source.
      if (repo && !installSpec.includes("#")) rememberSource(manifest.id, repo);
      if (!fromSearch) setSpec("");
      const net = manifest.permissions?.network;
      setMsg(
        net && net.length
          ? `Installed ${manifest.name}. It requests network access to ${net.join(", ")} — restart Safelight to allow it.`
          : `Installed ${manifest.name}.`,
      );
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

  // Repos already installed, resolved through repoFor so a manifest that
  // self-declares `repository` counts even without a remembered source
  // (repoFor returns it unnormalised, so lowercase here).
  const installedRepos = new Set(
    list.map((m) => repoFor(m)?.toLowerCase()).filter((r): r is string => !!r),
  );
  const isInstalled = (r: ExtensionSearchResult) =>
    installedRepos.has(r.fullName.toLowerCase());
  const enabled = (id: string) => !disabledIds.includes(id);

  // Installed extensions with a newer release available — drives the Updates tab
  // and its sidebar badge. Needs a known repo to update from (built-ins / custom
  // imports without a source can't be updated).
  const updatable = list.filter((m) => {
    const upd = updates[m.id];
    return !!upd?.hasUpdate && !!upd.latestTag && !!repoFor(m);
  });

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

<<<<<<< Updated upstream
=======
  // Discrete "shelves" (App-Store style) for the unfiltered browse: a horizontal
  // row each for Featured (verified), New, Popular and Recently updated. Only used
  // with no search query and the "All" category — a narrowed browse falls back to
  // the flat sorted grid above. ISO date strings sort lexically, so localeCompare
  // gives a correct newest-first order. Empty rows (e.g. no verified extensions)
  // are dropped so the user never sees a labelled blank shelf.
  const shelfView = !query.trim() && category === "All";
  const SHELF_LIMIT = 12;
  const shelves = (() => {
    if (!shelfView || !filtered || filtered.length === 0) return null;
    const byStars = (a: ExtensionSearchResult, b: ExtensionSearchResult) =>
      b.stars - a.stars;
    const featured = filtered
      .filter((r) => verified.includes(r.fullName.trim().toLowerCase()))
      .sort(byStars)
      .slice(0, SHELF_LIMIT);
    const newest = [...filtered]
      .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
      .slice(0, SHELF_LIMIT);
    const popular = [...filtered].sort(byStars).slice(0, SHELF_LIMIT);
    const recent = [...filtered]
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, SHELF_LIMIT);
    return [
      { id: "featured", title: "Featured", items: featured },
      { id: "new", title: "New", items: newest },
      { id: "popular", title: "Popular", items: popular },
      { id: "updated", title: "Recently updated", items: recent },
    ].filter((s) => s.items.length > 0);
  })();

>>>>>>> Stashed changes
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
        id: manifest?.id,
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
        id: builtin.id,
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
        id: manifest.id,
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
          ...(native ? (["Updates"] as Section[]) : []),
          "Browse",
          "Installed",
          ...(devtoolsEnabled ? (["Dev"] as Section[]) : []),
        ] as Section[]).map((s) => (
          <button
            key={s}
            onClick={() => setSection(s)}
            className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-[11px] tracking-wider ${
              section === s
                ? "bg-surface-3 text-text-primary"
                : "text-text-secondary hover:text-text-primary"
            }`}
          >
            <span>{s}</span>
            {s === "Updates" && updatable.length > 0 && (
              <span className="rounded-full bg-slider-fill px-1.5 text-[9px] font-medium leading-[14px] text-white">
                {updatable.length}
              </span>
            )}
          </button>
        ))}
      </div>

      <div className="min-w-0 flex-1 overflow-y-auto p-3 text-[11px]">
        {section === "Dev" && devtoolsEnabled ? (
          <DevExtensionsTab />
        ) : section === "Updates" ? (
          // ── Updates: installed extensions with a newer release ──
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>
                {updatable.length > 0
                  ? `${updatable.length} update${updatable.length > 1 ? "s" : ""} available`
                  : "Updates"}
              </SectionLabel>
              <button
                onClick={() => {
                  setMsg(null);
                  for (const m of list) void checkExtensionUpdate(m, true);
                }}
                disabled={busy !== null}
                title="Check all installed extensions for new releases"
                className="rounded px-1.5 text-[12px] leading-none text-text-muted hover:text-text-primary disabled:opacity-40"
              >
                ↻
              </button>
            </div>

            {updatable.length === 0 ? (
              <div className="text-text-muted">
                All installed extensions are up to date. Updating downloads the
                latest release and reinstalls the extension in place; your
                settings are kept.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {updatable.map((m) => {
                  const upd = updates[m.id]!;
                  const repo = repoFor(m)!;
                  return (
                    <ExtensionRow
                      key={m.id}
                      name={m.name}
                      version={m.version}
                      repo={repo}
                      description={`New version ${upd.latestTag} available`}
                      enabled={enabled(m.id)}
                      busy={busy !== null}
                      hasSettings={!!extSettings[m.id]}
                      onOpen={() => openDetail(repo)}
                      onUpdate={() => void update(m.id, repo, upd.latestTag!)}
                      onSettings={() => openSettings(m.id)}
                      onToggle={() => toggle(m.id, !enabled(m.id))}
                      onUninstall={() => void remove(m.id)}
                    />
                  );
                })}
              </div>
            )}

            {msg && <div className="text-text-secondary">{msg}</div>}
          </div>
        ) : section === "Browse" ? (
          native ? (
            <div className="flex flex-col gap-3">
              {/* Search + sort */}
              <div className="flex items-center gap-1.5">
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search official extensions…"
                  aria-label="Search official extensions"
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
                    aria-pressed={category === c}
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
                      thumb={thumbs[r.fullName] ?? r.thumbnail ?? null}
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
                    aria-label="Install extension from GitHub (owner/repo, branch, or URL)"
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
                  aria-label="Filter installed extensions"
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
                              repo={repo}
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
  thumb,
  installing,
  disabled,
  onOpen,
  onInstall,
}: {
  index: number;
  result: ExtensionSearchResult;
  /** Resolved thumbnail (icon / social preview / avatar). Null until the parent's
   *  batched resolution lands — we then fall back to the owner avatar. */
  thumb: ExtensionThumbnail | null;
  installing: boolean;
  disabled: boolean;
  onOpen: () => void;
  onInstall: () => void;
}) {
  const cat = categoryFor(result.topics);
  const short = result.fullName.split("/")[1] ?? result.fullName;
  const verified = useIsVerified(result.fullName);
  const banned = useBannedReason(result.fullName);
  const cardRef = useRef<HTMLDivElement>(null);
  const owner = result.fullName.split("/")[0];
  const avatar = result.avatarUrl ?? `https://github.com/${owner}.png?size=120`;
  // Thumbnails are resolved once, batched, in the main process (manifest icon →
  // custom social preview → avatar) and cached, so the per-card iconUrl waterfall
  // that used to gate the grid is gone. Until that resolution lands we paint the
  // avatar (or whatever warm-cache thumbnail the search result carried). `custom`
  // is false only for the avatar fallback, so it sits contained/centred while a
  // deliberate icon/preview (sized for the card) fills the frame.
  const resolved: ExtensionThumbnail = thumb ?? { url: avatar, custom: false };

  // The card paints the owner avatar instantly as an always-present base layer,
  // then overlays the resolved custom icon/preview ONLY once it has actually
  // loaded. This guarantees the card is never blank: a slow, hung, or failed
  // preview simply leaves the avatar showing instead of a grey frame (the bug
  // where re-opening the store showed empty cards, and the 17s "nothing then
  // everything" on first open). `showCustom` is the resolved thumbnail being a
  // real icon/preview (not the avatar fallback); it's cleared if that image
  // errors, so we fall back to the avatar.
  const [showCustom, setShowCustom] = useState(resolved.custom);
  const [customLoaded, setCustomLoaded] = useState(false);
  useEffect(() => {
    setShowCustom(resolved.custom);
    setCustomLoaded(false);
  }, [resolved.url, resolved.custom]);

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
        <div className="relative aspect-[2/1] w-full overflow-hidden bg-surface-3">
          {/* Always-present base: the owner avatar, contained + padded. Paints
              instantly so the card is never blank while a preview resolves. */}
          <img
            src={avatar}
            alt=""
            aria-hidden
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full"
            style={{ objectFit: "contain", padding: "0.75rem" }}
            onError={(e) => (e.currentTarget.style.visibility = "hidden")}
          />
          {/* Upgrade overlay: a custom icon/social preview, faded in only once it
              has actually loaded (so it never replaces the avatar with a blank
              frame). On error we drop it and the avatar shows through. */}
          {showCustom && (
            <img
              src={resolved.url}
              alt=""
              referrerPolicy="no-referrer"
              className="absolute inset-0 h-full w-full"
              style={{
                objectFit: "cover",
                opacity: customLoaded ? 1 : 0,
                transition: "opacity 200ms ease-out",
              }}
              onLoad={() => setCustomLoaded(true)}
              onError={() => setShowCustom(false)}
            />
          )}
        </div>
        <div className="p-2">
          <div className="flex items-center gap-1.5">
            <span className="min-w-0 truncate font-medium text-text-primary">
              {short}
            </span>
            {verified && <VerifiedBadge iconOnly />}
            <div className="flex-1" />
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
      <div className="mt-auto flex items-center justify-between gap-2 px-2 pb-2">
        {cat !== "Other" ? (
          <span className="rounded-full bg-surface-3 px-1.5 py-0.5 text-[9px] text-text-muted">
            {cat}
          </span>
        ) : (
          <span />
        )}
        {banned ? (
          <FlaggedBadge reason={banned} />
        ) : (
          <button
            disabled={disabled}
            onClick={onInstall}
            className="shrink-0 rounded bg-slider-fill px-2 py-0.5 font-medium text-white hover:opacity-80 disabled:opacity-40"
          >
            {installing ? "…" : "Install"}
          </button>
        )}
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
  repo,
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
  /** Source "owner/repo" for the verified/flagged badge; null for built-ins. */
  repo?: string | null;
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
  const vstatus = useVerificationStatus(repo, version);
  const reviewed = useReviewedFor(repo);
  const banned = useBannedReason(repo);
  return (
    <div
      className={`flex items-start justify-between gap-2 rounded bg-surface-2 px-2 py-1.5 ${
        enabled ? "" : "opacity-55"
      }`}
    >
      <button onClick={onOpen} className="min-w-0 flex-1 text-left">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-text-primary">
            {name} <span className="text-text-muted">v{version}</span>
          </span>
          {locked && (
            <span className="shrink-0 rounded bg-surface-3 px-1 py-px text-[9px] uppercase tracking-wider text-text-muted">
              Core
            </span>
          )}
          {banned ? (
            <FlaggedBadge reason={banned} />
          ) : (
            vstatus !== "unverified" && (
              <VerifiedBadge
                reviewedVersion={reviewed?.version}
                stale={vstatus === "stale"}
              />
            )
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
            role="switch"
            aria-checked={enabled}
            aria-label={`Enable ${name}`}
            disabled={busy}
            onClick={onToggle}
            title={enabled ? "Disable (keeps files and settings)" : "Enable"}
            className={`relative h-4 w-7 rounded-full transition-colors ${
              enabled ? "bg-slider-fill" : "bg-surface-3"
            }`}
          >
            <span
              aria-hidden="true"
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
