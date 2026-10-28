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
//                 safelight-extension topic), shown as shelves on its home
//                 page and as category pages picked from the rail, plus a
//                 custom-repo importer.
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
import { Select } from "@/ui/components/Select";
import { Switch } from "@/ui/components/Switch";
import { openPreferences } from "@/ui/components/PreferencesDialog";
import { closeExtensions } from "@/ui/components/ExtensionsDialog";
import { visibleKits } from "@/modules/welcome/setup/selection";
import { confirmDialog } from "@/ui/components/ConfirmDialog";
import {
  forgetSource,
  pruneSources,
  readSources,
  rememberSource,
  repoFor,
} from "./sources";
import {
  loadStoreVocabulary,
  updateNote,
  useExtStoreUI,
  type StoreSort,
} from "./store-ui";
import { categoryInfo, inCategory, OTHER } from "./store-categories";
import { StoreRail, type StoreSection } from "./StoreRail";
import {
  loadTrustList,
  useTrust,
  isVerifiedIn,
  bannedReason,
  repoFromSpec,
  useVerificationStatus,
  useReviewedFor,
  useBannedReason,
} from "./trust";
import { checkReview, confirmExtensionRisk } from "./install-gate";
import { setKept, usePins } from "./pins";
import { keepAfterInstall } from "./release-picks";
import { UpdateNotes } from "./ReleaseNotes";
import { VerifiedBadge, FlaggedBadge } from "./TrustBadges";
import { ExtensionDetail, type DetailTarget } from "./ExtensionDetail";
import { ExtensionCard, SectionLabel, SHELF_LIMIT, Shelf } from "./StoreCards";
import { loadStoreKits, shelfKits } from "./store-kits";
import { KitShelf } from "./KitShelf";
import { KitPage } from "./KitPage";
import { DevExtensionsTab } from "./devtools/DevExtensionsTab";

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
  const browse = useExtStoreUI((s) => s.browse);
  const vocabulary = useExtStoreUI((s) => s.vocabulary);
  const kits = useExtStoreUI((s) => s.kits);
  const kitId = useExtStoreUI((s) => s.kit);
  const sort = useExtStoreUI((s) => s.sort);
  const updates = useExtStoreUI((s) => s.updates);
  const openDetail = useExtStoreUI((s) => s.openDetail);
  const back = useExtStoreUI((s) => s.back);
  const pins = usePins((s) => s.pins);

  const [list, setList] = useState<ExtensionManifest[]>([]);
  const [results, setResults] = useState<ExtensionSearchResult[] | null>(null);
  // What an empty query returns, whatever Browse's query is now: the detail
  // page's chips, Works with and More shelves draw on it. `catalogFor` is the
  // topic and reload it was last asked for.
  const [catalog, setCatalog] = useState<ExtensionSearchResult[] | null>(null);
  const catalogFor = useRef<string | null>(null);
  // Best thumbnail per repo, resolved in one batched main-process call when the
  // results change (manifest icon → custom social preview → avatar). Search
  // results already carry a warm-cache thumbnail for instant first paint; this
  // upgrades any that were resolved cold. Keyed by "owner/repo".
  const [thumbs, setThumbs] = useState<Record<string, ExtensionThumbnail>>({});
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [spec, setSpec] = useState("");
  const [installedQuery, setInstalledQuery] = useState("");
  const [localBusy, setBusy] = useState<string | null>(null);
  // A kit's Install all outlives the window, so a reopened store stays busy
  // until that run ends.
  const kitRunning = useExtStoreUI((s) => s.kitRunning);
  const busy = localBusy ?? (kitRunning ? `kit:${kitRunning}` : null);
  const [msg, setMsg] = useState<string | null>(null);
  // The settings button deep-links into Preferences ▸ Extensions.
  const openSettings = (id: string) => {
    closeExtensions();
    openPreferences(id);
  };
  const [section, setSection] = useState<StoreSection>(native ? "Browse" : "Installed");
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

  // The registry's categories for the rail and category pages; ↻ asks again.
  useEffect(() => void loadStoreVocabulary(), [reloadNonce]);

  useEffect(() => {
    if (native) void loadStoreKits();
  }, [native, reloadNonce]);

  // A category the vocabulary no longer has shows the home page; point the
  // store there too, so the rail marks Browse rather than nothing.
  useEffect(() => {
    if (browse !== "home" && !categoryInfo(browse, vocabulary))
      useExtStoreUI.setState({ browse: "home" });
  }, [browse, vocabulary]);

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
  // A kit run ending re-reads the list too, also one this window didn't start.
  useEffect(refresh, [reloadNonce, kitRunning]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Official-extension search: runs on open and (debounced) as you type. An
  // empty query's answer is also the catalog, kept even once a keystroke has
  // superseded it. A query searched after ↻ asks for the catalog again once its
  // own forced search has refreshed the main process's cache.
  useEffect(() => {
    if (!native?.plugins.search) return;
    const seq = ++searchSeq.current;
    const force = lastSearchNonce.current !== reloadNonce;
    lastSearchNonce.current = reloadNonce;
    const q = query.trim();
    const catalogKey = `${topic}\n${reloadNonce}`;
    const keepCatalog = (r: ExtensionSearchResult[]) => {
      if (catalogFor.current === catalogKey) setCatalog(r);
    };
    setSearching(true);
    const t = setTimeout(() => {
      if (!q) catalogFor.current = catalogKey;
      native.plugins
        .search(q, topic, force)
        .then((r) => {
          if (!q) keepCatalog(r);
          if (searchSeq.current !== seq) return;
          setResults(r);
          setMsg(null);
          if (q && catalogFor.current !== catalogKey) {
            catalogFor.current = catalogKey;
            native.plugins.search("", topic, false).then(keepCatalog, () => {});
          }
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
    // Registry-backed results already carry a thumbnail baked by the index build,
    // so re-resolving them at runtime would add round-trips and nothing else —
    // only the live-search fallback path needs icon/og resolution here.
    const needs = results.filter((r) => r.source !== "registry");
    if (needs.length === 0) return;
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
      needs.map((r) => ({ repo: r.fullName, avatar: r.avatarUrl ?? null })),
      force,
    )
      .then(merge)
      .catch(() => {});
    return () => {
      alive = false;
      off?.();
    };
  }, [results, native, reloadNonce]);

  const install = async (
    installSpec: string,
    fromSearch?: ExtensionSearchResult,
    version?: string,
  ) => {
    const repo = fromSearch?.fullName.toLowerCase() ?? repoFromSpec(installSpec);
    // Banned: hard stop. The main process refuses it too — this is the faster,
    // clearer path so the user never watches a doomed download spin.
    const banned = repo ? bannedReason(repo) : null;
    if (banned) {
      setMsg(`Blocked — this extension is flagged as unsafe: ${banned}.`);
      return;
    }
    // A pinned "verified" entry only covers the version that was reviewed. If the
    // repo has since moved to a newer version, the code we'd install is past the
    // review point — drop the green-light and treat it as an unverified install.
    const {
      verified,
      reviewedVersion,
      stale: reviewedStale,
    } = await checkReview(repo, version);
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
    if (!(await confirmExtensionRisk())) return;
    // Unreviewed (never verified, or verified but past the reviewed version): it
    // runs with full access, so make the user opt in explicitly. Code that matches
    // a verified review installs without this prompt.
    if (!trusted) {
      const ok = await confirmDialog({
        title: "Unreviewed extension",
        message: reviewedStale
          ? `${repo ?? installSpec} is verified only up to version ${reviewedVersion}. ` +
            (version
              ? `Version ${version} is newer and has NOT been reviewed. `
              : "The current version is newer and has NOT been reviewed. ") +
            "It runs with full access to your photos, metadata and files."
          : `${repo ?? installSpec} hasn't been reviewed by Safelight.\n\n` +
            "Installed extensions run with full access to your photos, metadata and " +
            "edits. Only install extensions you trust.",
        confirmLabel: "Install anyway",
      });
      if (!ok) return;
    }
    setBusy(installSpec);
    setMsg(null);
    try {
      // A repo that's already installed is reinstalled in place, so its settings
      // and enabled/disabled state survive a version switch; only a fresh install
      // starts enabled.
      const installedHere =
        !!repo && list.some((m) => repoFor(m)?.toLowerCase() === repo.toLowerCase());
      const manifest = installedHere
        ? await updateExtension(installSpec, version)
        : await installFromGitHub(installSpec, version);
      if (fromSearch) rememberSource(manifest.id, fromSearch.fullName);
      else setSpec("");
      // An older version chosen on the detail page keeps the extension on it;
      // any other install follows new releases again.
      const known = useExtStoreUI.getState().releases[installSpec];
      const keep = keepAfterInstall(version, known?.status === "ready" ? known.data : null);
      setKept(manifest.id, keep ? manifest.version : null);
      if (version) void checkExtensionUpdate(manifest, true);
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

  const update = async (id: string, repo: string) => {
    setBusy(id);
    setMsg(null);
    try {
      const manifest = await updateExtension(repo, updates[id]?.latestTag ?? undefined);
      setMsg(`Updated ${manifest.name} to ${manifest.version}.`);
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

  // Installed extensions with a newer version — drives the Updates tab. Needs a
  // known repo to update from (built-ins / custom imports without a source can't
  // be updated). One this build can't run, or one kept at an older version, is
  // listed so the user knows, but not counted in the badge; auto-update skips
  // both too (loader.ts).
  const pending = list.filter((m) => {
    const upd = updates[m.id];
    return !!upd?.hasUpdate && !!upd.latestTag && !!repoFor(m);
  });
  const installable = pending.filter((m) => !updates[m.id]?.requiresApp && !pins[m.id]);

  // Verified lookups for the grid subscribe to the trust store: on a first
  // launch the registry can land after the search results, and the filters
  // below must follow it rather than keep a one-off answer.
  const trust = useTrust((s) => s.list);
  // Kit repos are lowercase; legacy remembered sources may be mixed-case, so
  // compare lowercased.
  const installedLower = new Set([...installedRepos].map((r) => r.toLowerCase()));
  const homeKits = kits ? shelfKits(kits, trust, installedLower) : [];
  const openKit = kitId && kits ? (visibleKits(kits, trust).find((k) => k.id === kitId) ?? null) : null;
  const allowlisted = (r: ExtensionSearchResult) =>
    isVerifiedIn(trust, r.fullName);

  // Browse shows only what isn't installed, narrowed to the open category (a
  // category the vocabulary no longer has falls back to the home page). With
  // "Only verified extensions" on it also hides what the install gate would
  // refuse, so the store only ever offers what can actually be installed.
  const openInfo = browse === "home" ? null : categoryInfo(browse, vocabulary);
  const browseKey = openInfo ? openInfo.slug : "home";
  const notInstalled = results?.filter((r) => !isInstalled(r)) ?? null;
  const inView =
    notInstalled && openInfo ? inCategory(notInstalled, browseKey, vocabulary) : notInstalled;
  const filtered = onlyVerified ? (inView?.filter(allowlisted) ?? null) : inView;
  const hiddenUnverified = inView && filtered ? inView.length - filtered.length : 0;
  const showOther = !!notInstalled && inCategory(notInstalled, OTHER.slug, vocabulary).length > 0;
  const categoryMembers = results && openInfo ? inCategory(results, browseKey, vocabulary) : [];
  const everyInstalled = categoryMembers.length > 0 && categoryMembers.every(isInstalled);

  // Flat, sorted list — shown when a search query or an open category narrows
  // the browse, where ranked shelves would be redundant.
  const browsable = (() => {
    if (!filtered) return null;
    const sorted = [...filtered];
    if (sort === "name")
      sorted.sort((a, b) => a.fullName.localeCompare(b.fullName));
    else if (sort === "updated")
      sorted.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    else sorted.sort((a, b) => b.stars - a.stars);
    return sorted;
  })();

  // Discrete "shelves" (App-Store style) for the unfiltered browse: a horizontal
  // row each for Featured (verified), New, Popular and Recently updated. Only used
  // on the home page with no search query — a narrowed browse falls back to
  // the flat sorted grid above. ISO date strings sort lexically, so localeCompare
  // gives a correct newest-first order. Empty rows (e.g. no verified extensions)
  // are dropped so the user never sees a labelled blank shelf.
  const shelfView = !query.trim() && !openInfo;
  const shelves = (() => {
    if (!shelfView || !filtered || filtered.length === 0) return null;
    const byStars = (a: ExtensionSearchResult, b: ExtensionSearchResult) =>
      b.stars - a.stars;
    // Under "Only verified extensions" every row is verified, so Featured would
    // only repeat Popular; leaving it empty drops it below.
    const featured = onlyVerified
      ? []
      : filtered.filter(allowlisted).sort(byStars).slice(0, SHELF_LIMIT);
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

  // ── Detail target resolution ───────────────────────────────────────────────
  // `selected` is "owner/repo" for repo-backed extensions, or an id for built-ins
  // and installed extensions without a known repo.
  const buildTarget = (sel: string): DetailTarget | null => {
    if (sel.includes("/")) {
      const lower = sel.toLowerCase();
      const manifest = list.find((m) => repoFor(m)?.toLowerCase() === lower);
      // A live search can match a repo past the catalog's first page.
      const matches = (r: ExtensionSearchResult) => r.fullName.toLowerCase() === lower;
      const search = catalog?.find(matches) ?? results?.find(matches);
      const name = manifest?.name ?? search?.name ?? sel.split("/")[1] ?? sel;
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
          key={selected}
          target={target}
          busy={busy}
          onInstall={(s, version) => void install(s, target.search, version)}
          onUpdate={(id, repo) => void update(id, repo)}
          onUninstall={(id) => void remove(id)}
          onToggle={toggle}
          onSettings={openSettings}
          related={{
            results: catalog ?? results ?? [],
            isInstalled,
            onOpen: openDetail,
            onInstall: (repo, r) => void install(repo, r),
            onCategory: (slug) => {
              setSection("Browse");
              useExtStoreUI.getState().openCategory(slug);
            },
          }}
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
      <StoreRail
        sections={[
          ...(native ? (["Updates"] as StoreSection[]) : []),
          "Browse",
          "Installed",
          ...(devtoolsEnabled ? (["Dev"] as StoreSection[]) : []),
        ]}
        section={section}
        onSection={setSection}
        badges={{ Updates: installable.length }}
        categories={!!native}
        showOther={showOther || browse === OTHER.slug}
      />

      <div className="min-w-0 flex-1 overflow-y-auto p-3 text-[11px]">
        {section === "Dev" && devtoolsEnabled ? (
          <DevExtensionsTab />
        ) : section === "Updates" ? (
          // ── Updates: installed extensions with a newer release ──
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <SectionLabel>
                {installable.length > 0
                  ? `${installable.length} update${installable.length > 1 ? "s" : ""} available`
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

            {pending.length === 0 ? (
              <div className="text-text-muted">
                All installed extensions are up to date. Updating downloads the
                latest release and reinstalls the extension in place; your
                settings are kept.
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {pending.map((m) => {
                  const upd = updates[m.id]!;
                  const repo = repoFor(m)!;
                  const keptHere = !!pins[m.id] && !upd.requiresApp && !upd.failed;
                  return (
                    <div key={m.id} className="flex flex-col gap-0.5">
                      <ExtensionRow
                        name={m.name}
                        version={m.version}
                        repo={repo}
                        description={
                          keptHere
                            ? `Kept at ${m.version} · ${upd.latestTag} is available`
                            : updateNote(m.version, upd)
                        }
                        enabled={enabled(m.id)}
                        busy={busy !== null}
                        hasSettings={!!extSettings[m.id]}
                        onOpen={() => openDetail(repo)}
                        onUpdate={upd.requiresApp ? undefined : () => void update(m.id, repo)}
                        onSettings={() => openSettings(m.id)}
                        onToggle={() => toggle(m.id, !enabled(m.id))}
                        onUninstall={() => void remove(m.id)}
                      />
                      {upd.latestTag && <UpdateNotes repo={repo} version={upd.latestTag} />}
                    </div>
                  );
                })}
              </div>
            )}

            {msg && <div className="text-text-secondary">{msg}</div>}
          </div>
        ) : section === "Browse" ? (
          native && openKit ? (
            <KitPage
              kit={openKit}
              installed={installedLower}
              busy={busy}
              onBusy={setBusy}
              onOpen={openDetail}
              onDone={refresh}
            />
          ) : native ? (
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
                {/* Sort only applies to a flat grid: search results here, or the
                    category page's header. */}
                {!shelfView && !openInfo && (
                  <Select
                    value={sort}
                    onChange={(v) =>
                      useExtStoreUI.getState().setSort(v as StoreSort)
                    }
                    options={SORTS.map((s) => ({ value: s.id, label: s.label }))}
                    title="Sort"
                  />
                )}
                <button
                  onClick={reload}
                  disabled={searching}
                  title="Reload the extension list and search results"
                  className="rounded px-1.5 text-[12px] leading-none text-text-muted hover:text-text-primary disabled:opacity-40"
                >
                  ↻
                </button>
              </div>

              {openInfo && (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h2 className="text-[13px] font-semibold text-text-primary">{openInfo.label}</h2>
                    {openInfo.description && (
                      <p className="mt-0.5 text-text-secondary">{openInfo.description}</p>
                    )}
                  </div>
                  <Select
                    value={sort}
                    onChange={(v) => useExtStoreUI.getState().setSort(v as StoreSort)}
                    options={SORTS.map((s) => ({ value: s.id, label: s.label }))}
                    title="Sort"
                  />
                </div>
              )}

              {/* Result cards: ranked shelves for the unfiltered browse, a flat
                  sorted grid once a search query or category narrows it. */}
              {searching && browsable === null ? (
                <div className="text-text-muted">Searching…</div>
              ) : browsable && browsable.length === 0 ? (
                <div className="text-text-muted">
                  {query.trim() || !openInfo
                    ? `No new extensions found${query ? ` for “${query}”` : ""}${
                        openInfo ? ` in ${openInfo.label}` : ""
                      } (topic: ${topic}).`
                    : everyInstalled
                      ? `You have every ${openInfo.label} extension installed.`
                      : categoryMembers.length === 0
                        ? `No ${openInfo.label} extensions yet.`
                        : null}
                </div>
              ) : shelves ? (
                <div className="flex flex-col gap-4">
                  {[
                    ...shelves.filter((sh) => sh.id === "featured"),
                    "kits" as const,
                    ...shelves.filter((sh) => sh.id !== "featured"),
                  ].map((sh) =>
                    sh === "kits" ? (
                      <KitShelf key="kits" kits={homeKits} onOpen={(id) => useExtStoreUI.getState().openKit(id)} />
                    ) : (
                      <Shelf
                        key={sh.id}
                        title={sh.title}
                        items={sh.items}
                        thumbs={thumbs}
                        busy={busy}
                        onOpen={openDetail}
                        onInstall={install}
                      />
                    ),
                  )}
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

              {hiddenUnverified > 0 && (
                <div className="text-text-muted">
                  {`${hiddenUnverified} unverified ${
                    hiddenUnverified === 1 ? "extension" : "extensions"
                  } hidden — “Only verified extensions” is on (Preferences ▸ Extensions).`}
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
                            !!upd?.hasUpdate && !!upd.latestTag && !!repo && !upd.requiresApp;
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
                                  ? () => void update(m.id, repo!)
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
          <Switch
            checked={enabled}
            ariaLabel={`Enable ${name}`}
            disabled={busy}
            onChange={onToggle}
            title={enabled ? "Disable (keeps files and settings)" : "Enable"}
          />
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
