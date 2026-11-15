// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A detail page's screenshot strip. An image that fails to load drops out,
// and the strip goes when none are left. A click enlarges one over the page.
// While one is enlarged, the app's global shortcuts are suspended (the switch
// SetupFlow and Preferences use), so Esc closes only the enlarged view, not the
// Extensions window, and ←/→ step through the screenshots, not the photo behind
// them. The enlarged view follows its URL, so a thumbnail failing can't swap it
// for a different screenshot; if the enlarged image itself fails, it closes.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { suspendShortcuts } from "@/state/keybindings-store";
import { trapTab } from "@/ui/focus-trap";
import { Skeleton } from "@/ui/components/Skeleton";
import { EASE_OUT, MOTION_MS } from "@/ui/motion";

/** One thumbnail: a breathing box the size of a typical screenshot until the picture
 *  loads, then the picture fading in over it. */
function Thumb({
  url,
  index,
  onOpen,
  onFail,
}: {
  url: string;
  index: number;
  onOpen: () => void;
  onFail: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  return (
    <button
      data-shot={url}
      onClick={onOpen}
      aria-label={`Enlarge screenshot ${index + 1}`}
      className={`relative h-[120px] shrink-0 overflow-hidden rounded bg-surface-2 ${loaded ? "" : "w-[214px]"}`}
    >
      {!loaded && <Skeleton className="absolute inset-0 rounded-none" />}
      <img
        src={url}
        alt={`Screenshot ${index + 1}`}
        referrerPolicy="no-referrer"
        className="h-full w-auto object-contain"
        style={{ opacity: loaded ? 1 : 0, transition: `opacity ${MOTION_MS}ms ${EASE_OUT}` }}
        onLoad={() => setLoaded(true)}
        onError={onFail}
      />
    </button>
  );
}

export function Screenshots({ urls }: { urls: string[] }) {
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [openUrl, setOpenUrl] = useState<string | null>(null);
  const key = urls.join("\n");
  useEffect(() => {
    setFailed(new Set());
    setOpenUrl(null);
  }, [key]);
  const shown = useMemo(() => urls.filter((u) => !failed.has(u)), [urls, failed]);
  const openIndex = openUrl === null ? -1 : shown.indexOf(openUrl);
  const openShot = openIndex < 0 ? null : shown[openIndex];
  const isOpen = openShot !== null;

  useEffect(() => {
    if (!isOpen) return;
    return suspendShortcuts();
  }, [isOpen]);

  const dialogRef = useRef<HTMLDivElement>(null);
  const stripRef = useRef<HTMLDivElement>(null);
  const lastShot = useRef<string | null>(null);
  lastShot.current = openShot ?? lastShot.current;

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => {
      const thumb = Array.from(stripRef.current?.querySelectorAll<HTMLElement>("button") ?? []).find(
        (b) => b.dataset.shot === lastShot.current,
      );
      (opener?.isConnected ? opener : thumb)?.focus();
    };
  }, [isOpen]);

  const onDialogKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    trapTab(e, dialogRef.current);
    if (e.key === "Escape") setOpenUrl(null);
    else if (e.key === "ArrowRight") setOpenUrl(shown[(openIndex + 1) % shown.length]);
    else if (e.key === "ArrowLeft") setOpenUrl(shown[(openIndex - 1 + shown.length) % shown.length]);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  if (shown.length === 0) return null;
  const fail = (u: string) => {
    setFailed((s) => new Set(s).add(u));
    setOpenUrl((cur) => (cur === u ? null : cur));
  };

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div ref={stripRef} className="flex gap-2 overflow-x-auto pb-1">
        {shown.map((u, i) => (
          <Thumb key={u} url={u} index={i} onOpen={() => setOpenUrl(u)} onFail={() => fail(u)} />
        ))}
      </div>
      {openShot !== null && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Screenshot ${openIndex + 1} of ${shown.length}`}
          ref={dialogRef}
          tabIndex={-1}
          onKeyDown={onDialogKeyDown}
          onClick={() => setOpenUrl(null)}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4 outline-none"
        >
          <img
            src={openShot}
            alt={`Screenshot ${openIndex + 1}`}
            referrerPolicy="no-referrer"
            className="max-h-full max-w-full object-contain"
          />
        </div>
      )}
    </div>
  );
}
