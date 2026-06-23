// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Startup welcome grid: recently opened project folders shown as cover cards.
// Clicking a card opens it through the same path as "Open Folder" (no
// re-import), which is why launch lands here instead of auto-reopening the last
// project.

import { useEffect, useState } from "react";
import { useProjectStore } from "@/project/project-store";
import {
  listRecentProjects,
  removeRecentProject,
  type RecentProject,
} from "@/project/recent";
import { dragBarStyle, noDragStyle, useTitleBarOverlay } from "@/ui/window-chrome";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function FolderIcon() {
  return (
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

interface Card extends RecentProject {
  coverUrl: string | null;
}

export function WelcomeView() {
  useTitleBarOverlay("--color-surface-0"); // welcome view sits on surface-0
  const openProjectPicker = useProjectStore((s) => s.openProjectPicker);
  const openRecent = useProjectStore((s) => s.openRecent);
  const opening = useProjectStore((s) => s.opening);
  const [cards, setCards] = useState<Card[] | null>(null);

  useEffect(() => {
    const urls: string[] = [];
    let alive = true;
    void listRecentProjects().then((list) => {
      if (!alive) return;
      setCards(
        list.map((p) => {
          const coverUrl = p.cover ? URL.createObjectURL(p.cover) : null;
          if (coverUrl) urls.push(coverUrl);
          return { ...p, coverUrl };
        }),
      );
    });
    return () => {
      alive = false;
      for (const u of urls) URL.revokeObjectURL(u);
    };
  }, []);

  const remove = async (id: string) => {
    await removeRecentProject(id);
    setCards((cs) => (cs ? cs.filter((c) => c.id !== id) : cs));
  };

  return (
    <div className="flex h-full flex-col bg-surface-0 text-text-primary">
      <header
        className="flex h-[38px] shrink-0 items-center justify-between px-8"
        style={dragBarStyle}
      >
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-semibold tracking-[0.3em] text-text-secondary">
            SAFELIGHT
          </span>
          <span className="text-xs text-text-muted">Recent projects</span>
        </div>
        <button
          onClick={() => void openProjectPicker()}
          disabled={opening}
          style={noDragStyle}
          className="rounded bg-slider-fill px-4 py-1.5 text-xs font-medium text-white hover:bg-surface-4 disabled:opacity-60"
        >
          Open Folder…
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {cards === null ? null : cards.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-text-muted">
            <p className="text-sm">No recent projects</p>
            <button
              onClick={() => void openProjectPicker()}
              className="rounded bg-surface-3 px-3 py-1.5 text-xs text-text-secondary hover:bg-surface-4 hover:text-text-primary"
            >
              Open a folder to get started
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {cards.map((c) => (
              <button
                key={c.id}
                onClick={() => void openRecent(c)}
                disabled={opening}
                title={c.path ?? c.name}
                className="group relative flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 text-left transition hover:border-slider-fill disabled:opacity-60"
              >
                <div className="aspect-[4/3] w-full overflow-hidden bg-surface-2">
                  {c.coverUrl ? (
                    <img
                      src={c.coverUrl}
                      alt=""
                      draggable={false}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-text-muted">
                      <FolderIcon />
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-0.5 px-3 py-2">
                  <span className="truncate text-sm font-medium text-text-primary">
                    {c.name}
                  </span>
                  <span className="truncate text-[11px] text-text-muted">
                    {c.path ?? "Browser folder"}
                  </span>
                  <span className="text-[10px] text-text-muted">
                    {timeAgo(c.openedAt)}
                  </span>
                </div>
                <span
                  role="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    void remove(c.id);
                  }}
                  title="Remove from recents"
                  className="absolute right-1.5 top-1.5 hidden h-6 w-6 items-center justify-center rounded bg-black/60 text-sm text-text-secondary hover:text-white group-hover:flex"
                >
                  ×
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
