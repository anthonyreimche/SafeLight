// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Detail "store page" for one extension, shown inside the Extensions window when
// a card or installed row is clicked. For a repo-backed extension it pulls the
// GitHub README + metadata (stars, license, last-updated, issues/discussions
// links) through the native bridge and renders the README with the dependency-
// free Markdown component. Built-in extensions have no repo, so they show a
// local-only page (no README fetch, no install/uninstall).

import { useEffect } from "react";
import type { ExtensionManifest, ExtensionSearchResult } from "./types";
import { useExtStoreUI, loadRepoMeta, loadReadme } from "./store-ui";
import { useIsVerified, useBannedReason } from "./trust";
import { VerifiedBadge, FlaggedBadge } from "./TrustBadges";
import { Markdown } from "./Markdown";
import { openUrl } from "@/update/update-checker";
import { isNewer } from "@/update/semver";

/** Everything the detail page needs about the selected extension, resolved by
 *  the panel from its installed list / search results / built-ins. */
export interface DetailTarget {
  /** "owner/repo" when the extension has a GitHub repo, else null. */
  repo: string | null;
  name: string;
  description?: string;
  author?: string;
  installed: boolean;
  /** Present iff installed. */
  manifest?: ExtensionManifest;
  enabled: boolean;
  locked: boolean;
  hasSettings: boolean;
  /** Search-result fallback (stars/topics before repo metadata loads). */
  search?: ExtensionSearchResult;
}

interface Props {
  target: DetailTarget;
  busy: string | null;
  onInstall: (spec: string) => void;
  onUpdate: (id: string, repo: string, tag: string) => void;
  onUninstall: (id: string) => void;
  onToggle: (id: string, enable: boolean) => void;
  onSettings: (id: string) => void;
}

function relTime(iso: string): string {
  const then = iso ? new Date(iso).getTime() : 0;
  if (!then) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  const units: [number, string][] = [
    [31536000, "year"],
    [2592000, "month"],
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [secs, label] of units) {
    const v = Math.floor(s / secs);
    if (v >= 1) return `${v} ${label}${v > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

function LinkBtn({ label, url }: { label: string; url: string }) {
  return (
    <button
      onClick={() => openUrl(url)}
      className="rounded bg-surface-2 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
    >
      {label} ↗
    </button>
  );
}

export function ExtensionDetail({
  target,
  busy,
  onInstall,
  onUpdate,
  onUninstall,
  onToggle,
  onSettings,
}: Props) {
  const { repo } = target;
  const verified = useIsVerified(repo);
  const banned = useBannedReason(repo);
  const meta = useExtStoreUI((s) => (repo ? s.meta[repo] : undefined));
  const readme = useExtStoreUI((s) => (repo ? s.readme[repo] : undefined));
  const update = useExtStoreUI((s) =>
    target.manifest ? s.updates[target.manifest.id] : undefined,
  );

  const repoMeta = meta?.status === "ready" ? meta.data : null;
  const branch = repoMeta?.defaultBranch;

  // Load metadata on open, then the README once we know the default branch.
  useEffect(() => {
    if (repo) void loadRepoMeta(repo);
  }, [repo]);
  useEffect(() => {
    if (repo && branch) void loadReadme(repo, branch);
  }, [repo, branch]);

  // Prefer manifest-declared assets, then GitHub-derived ones.
  const icon =
    target.manifest?.icon ??
    (repoMeta ? repoMeta.ogImageUrl : undefined) ??
    repoMeta?.ownerAvatarUrl ??
    undefined;
  const stars = repoMeta?.stars ?? target.search?.stars ?? 0;
  const license = target.manifest?.license ?? repoMeta?.license ?? null;
  const author =
    target.author ?? target.manifest?.author ?? repoMeta?.ownerLogin ?? "";
  const description =
    target.description ??
    target.manifest?.description ??
    repoMeta?.description ??
    "";
  const homepage = target.manifest?.homepage ?? repoMeta?.homepage ?? null;

  const id = target.manifest?.id;
  const hasUpdate = !!update?.hasUpdate && !!update.latestTag && !!repo;

  // The extension declares a newer SafeLight than this build — warn (the running
  // version comes from the Vite build-time constant).
  const minApp = target.manifest?.minAppVersion;
  const appTooOld = !!minApp && isNewer(__APP_VERSION__, minApp);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-start gap-3 border-b border-border-subtle p-3">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded bg-surface-2">
          {icon && (
            <img
              src={icon}
              alt=""
              className="h-full w-full object-cover"
              onError={(e) => (e.currentTarget.style.display = "none")}
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text-primary">
              {target.name}
            </span>
            {target.locked && (
              <span className="rounded bg-surface-3 px-1 py-px text-[9px] uppercase tracking-wider text-text-muted">
                Core
              </span>
            )}
            {target.installed && target.manifest && (
              <span className="text-[10px] text-text-muted">
                v{target.manifest.version}
              </span>
            )}
            {repo && banned ? (
              <FlaggedBadge reason={banned} large />
            ) : (
              verified && <VerifiedBadge large />
            )}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-text-muted">
            {author && <span>by {author}</span>}
            {stars > 0 && <span>★ {stars}</span>}
            {repoMeta?.updatedAt && <span>updated {relTime(repoMeta.updatedAt)}</span>}
            {license && <span>{license}</span>}
            {repoMeta && repoMeta.openIssues > 0 && (
              <span>{repoMeta.openIssues} open issues</span>
            )}
          </div>
          {description && (
            <div className="mt-1 text-[11px] text-text-secondary">{description}</div>
          )}
          {appTooOld && (
            <div className="mt-1 text-[10px]" style={{ color: "var(--color-rating)" }}>
              Requires SafeLight {minApp} or newer — please update the app.
            </div>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border-subtle px-3 py-2">
        {!target.installed && repo && banned && (
          <span
            title={banned}
            className="rounded px-3 py-1 text-[11px] font-medium text-label-red"
            style={{ background: "color-mix(in srgb, var(--color-label-red) 16%, transparent)" }}
          >
            Blocked — {banned}
          </span>
        )}
        {!target.installed && repo && !banned && (
          <button
            disabled={busy !== null}
            onClick={() => onInstall(repo)}
            title={
              verified
                ? "Reviewed and verified by Safelight"
                : "Not reviewed by Safelight — runs with full access to your photos and metadata"
            }
            className="rounded bg-slider-fill px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy === repo ? "Installing…" : verified ? "Install" : "Install (unverified)"}
          </button>
        )}
        {target.installed && hasUpdate && id && repo && (
          <button
            disabled={busy !== null}
            onClick={() => onUpdate(id, repo, update!.latestTag!)}
            className="rounded bg-slider-fill px-3 py-1 text-[11px] font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy === id ? "Updating…" : `Update to ${update!.latestTag}`}
          </button>
        )}
        {target.installed && id && !target.locked && (
          <button
            disabled={busy !== null}
            onClick={() => onToggle(id, !target.enabled)}
            className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40"
          >
            {target.enabled ? "Disable" : "Enable"}
          </button>
        )}
        {target.installed && id && target.hasSettings && target.enabled && (
          <button
            onClick={() => onSettings(id)}
            className="rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary"
          >
            Settings
          </button>
        )}
        <div className="flex-1" />
        {repoMeta && <LinkBtn label="Repo" url={repoMeta.htmlUrl} />}
        {repoMeta?.hasIssues && (
          <LinkBtn label="Issues" url={`${repoMeta.htmlUrl}/issues`} />
        )}
        {repoMeta?.hasDiscussions && (
          <LinkBtn label="Discussions" url={`${repoMeta.htmlUrl}/discussions`} />
        )}
        {homepage && <LinkBtn label="Homepage" url={homepage} />}
        {target.installed && id && !target.locked && (
          <button
            disabled={busy !== null}
            onClick={() => onUninstall(id)}
            className="rounded px-2 py-1 text-[10px] text-text-muted hover:text-label-red disabled:opacity-40"
          >
            Uninstall
          </button>
        )}
      </div>

      {/* README / body */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!repo ? (
          <div className="text-[11px] text-text-muted">
            {target.locked
              ? "A built-in extension — part of SafeLight core."
              : "No repository linked for this extension."}
          </div>
        ) : meta?.status === "error" ? (
          <div className="text-[11px] text-text-muted">
            Couldn’t load details: {meta.error}
          </div>
        ) : !readme || readme.status === "loading" || meta?.status === "loading" ? (
          <div className="text-[11px] text-text-muted">Loading…</div>
        ) : readme.status === "error" ? (
          <div className="text-[11px] text-text-muted">
            Couldn’t load README: {readme.error}
          </div>
        ) : readme.data ? (
          <Markdown source={readme.data} repo={repo} branch={branch} />
        ) : (
          <div className="text-[11px] text-text-muted">
            This extension has no README.
          </div>
        )}
      </div>
    </div>
  );
}
