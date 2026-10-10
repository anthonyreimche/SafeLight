// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Release notes for the Extensions store, rendered with the dependency-free
// Markdown component (React elements, never HTML).

import { useEffect, useState } from "react";
import type { ExtensionRelease } from "./types";
import { Markdown } from "./Markdown";
import { loadReleases, useExtStoreUI } from "./store-ui";
import { sameVersion } from "./release-picks";

const dateOf = (iso: string): string => {
  const t = Date.parse(iso);
  return Number.isFinite(t)
    ? new Date(t).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
    : "";
};

/** One section per release that has notes, headed by version and date.
 *  Renders nothing when none of them has notes. */
export function ReleaseNotes({ releases, repo }: { releases: ExtensionRelease[]; repo: string }) {
  const shown = releases.filter((r) => r.notes.trim());
  if (shown.length === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((r) => (
        <section key={r.tag}>
          <div className="mb-1 flex items-baseline gap-2 text-[11px]">
            <span className="font-medium text-text-primary">{r.version}</span>
            {r.publishedAt && <span className="text-text-muted">{dateOf(r.publishedAt)}</span>}
          </div>
          <Markdown source={r.notes} repo={repo} branch={r.tag} />
        </section>
      ))}
    </div>
  );
}

/** A "What's new" toggle for one pending update: loads the repo's releases
 *  when opened and shows the target release's notes. */
export function UpdateNotes({ repo, version }: { repo: string; version: string }) {
  const [open, setOpen] = useState(false);
  const releases = useExtStoreUI((s) => s.releases[repo]);
  useEffect(() => {
    if (open) void loadReleases(repo);
  }, [open, repo]);
  const target =
    releases?.status === "ready" ? releases.data.filter((r) => sameVersion(r.version, version)) : [];
  return (
    <div className="pl-2">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="text-[10px] text-text-muted hover:text-text-primary"
      >
        {open ? "▾" : "▸"} What's new
      </button>
      {open &&
        (releases?.status === "error" ? (
          <div className="text-[10px] text-text-muted">
            Couldn't load release notes: {releases.error}
          </div>
        ) : releases?.status !== "ready" ? (
          <div className="text-[10px] text-text-muted">Loading…</div>
        ) : target.some((r) => r.notes.trim()) ? (
          <div className="mt-1 rounded bg-surface-1 p-2">
            <ReleaseNotes releases={target} repo={repo} />
          </div>
        ) : (
          <div className="text-[10px] text-text-muted">No release notes for {version}.</div>
        ))}
    </div>
  );
}
