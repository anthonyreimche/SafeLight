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

import { useEffect, useMemo, useState } from "react";
import { setShortcutsSuspended, shortcutsSuspended } from "@/state/keybindings-store";

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
    const prev = shortcutsSuspended();
    setShortcutsSuspended(true);
    return () => setShortcutsSuspended(prev);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpenUrl(null);
      else if (e.key === "ArrowRight") setOpenUrl(shown[(openIndex + 1) % shown.length]);
      else if (e.key === "ArrowLeft") setOpenUrl(shown[(openIndex - 1 + shown.length) % shown.length]);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [isOpen, openIndex, shown]);

  if (shown.length === 0) return null;
  const fail = (u: string) => {
    setFailed((s) => new Set(s).add(u));
    setOpenUrl((cur) => (cur === u ? null : cur));
  };

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div className="flex gap-2 overflow-x-auto pb-1">
        {shown.map((u, i) => (
          <button
            key={u}
            onClick={() => setOpenUrl(u)}
            aria-label={`Enlarge screenshot ${i + 1}`}
            className="h-[120px] shrink-0 overflow-hidden rounded bg-surface-2"
          >
            <img
              src={u}
              alt={`Screenshot ${i + 1}`}
              referrerPolicy="no-referrer"
              className="h-full w-auto object-contain"
              onError={() => fail(u)}
            />
          </button>
        ))}
      </div>
      {openShot !== null && (
        <div
          role="dialog"
          aria-label={`Screenshot ${openIndex + 1} of ${shown.length}`}
          onClick={() => setOpenUrl(null)}
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/80 p-4"
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
