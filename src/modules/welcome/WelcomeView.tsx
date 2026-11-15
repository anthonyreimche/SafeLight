// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Startup welcome grid: recently opened project folders shown as cover cards.
// Clicking a card opens it through the same path as "Open Folder" (no
// re-import), which is why launch lands here instead of auto-reopening the last
// project.

import { useEffect, useRef, useState } from "react";
import { useProjectStore } from "@/project/project-store";
import {
  listRecentProjects,
  removeRecentProject,
  type RecentProject,
} from "@/project/recent";
import { dragBarStyle, noDragStyle, useTitleBarOverlay } from "@/ui/window-chrome";
import { ReportIssueButton } from "@/ui/components/ReportIssueButton";
import { Skeleton } from "@/ui/components/Skeleton";
import { useDelayedFlag } from "@/ui/use-delayed-flag";
import { reducedMotion } from "@/ui/reduced-motion";
import { EASE_OUT, MOTION_MS } from "@/ui/motion";

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

const GRID = "grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4";

/** Cards in the shape of the recents, standing in while the list is read. */
function SkeletonCards() {
  return (
    <div className={`sl-enter-fade ${GRID}`} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border bg-surface-1">
          <Skeleton className="aspect-[4/3] w-full rounded-none" />
          <div className="flex flex-col gap-1.5 px-3 py-2.5">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="h-2.5 w-full" />
            <Skeleton className="h-2 w-1/4" />
          </div>
        </div>
      ))}
    </div>
  );
}

function RecentCard({
  card: c,
  index,
  opening,
  onOpen,
  onRemove,
}: {
  card: Card;
  index: number;
  opening: boolean;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);
  const [coverFailed, setCoverFailed] = useState(false);

  // Cascade in like the store's cards. Script-driven, so it asks for Reduce motion itself.
  useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      typeof el.animate !== "function" ||
      reducedMotion() ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const anim = el.animate(
      [
        { opacity: 0, transform: "translateY(6px)" },
        { opacity: 1, transform: "none" },
      ],
      { duration: 240, delay: Math.min(index * 35, 420), easing: "ease-out", fill: "backwards" },
    );
    return () => anim.cancel();
    // Mount-only: index is the position the card arrives at.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={ref} className="group relative">
      <button
        onClick={onOpen}
        disabled={opening}
        title={c.path ?? c.name}
        className="flex w-full flex-col overflow-hidden rounded-lg border border-border bg-surface-1 text-left transition hover:border-slider-fill disabled:opacity-60"
      >
        <div className="aspect-[4/3] w-full overflow-hidden bg-surface-2">
          {c.coverUrl && !coverFailed ? (
            <div className="relative h-full w-full">
              {!coverLoaded && <Skeleton className="absolute inset-0 rounded-none" />}
              <img
                src={c.coverUrl}
                alt=""
                draggable={false}
                className="h-full w-full object-cover"
                style={{
                  opacity: coverLoaded ? 1 : 0,
                  transition: `opacity ${MOTION_MS}ms ${EASE_OUT}`,
                }}
                onLoad={() => setCoverLoaded(true)}
                onError={() => setCoverFailed(true)}
              />
            </div>
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
      </button>
      <button
        onClick={onRemove}
        title="Remove from recents"
        aria-label={`Remove ${c.name} from recents`}
        className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded bg-black/60 text-sm text-on-media-muted opacity-50 hover:text-on-media focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );
}

export function WelcomeView() {
  useTitleBarOverlay("--color-surface-0"); // welcome view sits on surface-0
  const openProjectPicker = useProjectStore((s) => s.openProjectPicker);
  const openRecent = useProjectStore((s) => s.openRecent);
  const opening = useProjectStore((s) => s.opening);
  const recentsRevision = useProjectStore((s) => s.recentsRevision);
  const [cards, setCards] = useState<Card[] | null>(null);
  const showSkeletons = useDelayedFlag(cards === null);

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
  }, [recentsRevision]);

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
        <div className="flex items-center gap-2" style={noDragStyle}>
          <ReportIssueButton className="rounded px-2 py-1 text-text-secondary transition-colors hover:text-text-primary" />
          <button
            onClick={() => void openProjectPicker()}
            disabled={opening}
            className="rounded bg-slider-fill px-4 py-1.5 text-xs font-medium text-on-accent hover:opacity-90 disabled:opacity-60"
          >
            Open Folder…
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-10">
        {cards === null ? (
          showSkeletons ? <SkeletonCards /> : null
        ) : cards.length === 0 ? (
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
          <div className={GRID}>
            {cards.map((c, i) => (
              <RecentCard
                key={c.id}
                card={c}
                index={i}
                opening={opening}
                onOpen={() => void openRecent(c)}
                onRemove={() => void remove(c.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
