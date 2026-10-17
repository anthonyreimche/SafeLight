// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions list under a saved layout in Preferences: whether picking the
// layout switches extensions, and which ones it turns on. All and None act on
// what the search shows.

import { useEffect, useId, useState } from "react";
import type { ExtensionManifest } from "@/extensions/types";
import { moduleEntry } from "@/extensions/registry";
import {
  layoutExtensionChoices,
  useDisabledExtensions,
  type LayoutExtensionChoice,
  type LayoutExtensionHold,
} from "@/extensions/loader";
import {
  setLayoutExtensions,
  setLayoutSwitchesExtensions,
  useUserLayouts,
} from "@/extensions/dock";
import { Switch } from "./Switch";

const HOLD_REASON: Record<LayoutExtensionHold, string> = {
  pixels: "Changes how photos look",
  unseen: "Hasn't run yet",
  kept: "Kept in every layout",
};

type HeldChoice = LayoutExtensionChoice & { hold: LayoutExtensionHold };

const isHeld = (c: LayoutExtensionChoice): c is HeldChoice => c.hold !== null;

const smallBtnCls =
  "rounded bg-surface-3 px-2 py-0.5 text-[10px] text-text-secondary hover:bg-surface-4 hover:text-text-primary disabled:opacity-40";

export function LayoutExtensionsEditor({ layoutId }: { layoutId: string }) {
  const layout = useUserLayouts((s) => moduleEntry(s.layouts, layoutId));
  const disabledIds = useDisabledExtensions((s) => s.ids);
  const [installed, setInstalled] = useState<ExtensionManifest[]>([]);
  const [query, setQuery] = useState("");
  const heldLabelId = useId();

  useEffect(() => {
    let live = true;
    window.safelightNative?.plugins
      .list()
      .then((list) => {
        if (live) setInstalled(list);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  if (!layout) return null;
  const q = query.trim().toLowerCase();
  const shown = layoutExtensionChoices(installed).filter(
    (c) => !q || c.name.toLowerCase().includes(q),
  );
  const tickable = shown.filter((c) => !isHeld(c));
  const held = shown.filter(isHeld);
  const ticked = (id: string) =>
    moduleEntry(layout.extensions, id) ?? !disabledIds.includes(id);
  const tickShown = (on: boolean) =>
    void setLayoutExtensions(
      layoutId,
      Object.fromEntries(tickable.map((c) => [c.id, on])),
    );

  return (
    <div className="flex flex-col gap-1.5 bg-surface-1 px-2 py-2">
      <Switch
        checked={!!layout.switchesExtensions}
        onChange={(on) => setLayoutSwitchesExtensions(layoutId, on)}
        className="w-full justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">
          Switch extensions with this layout
        </span>
      </Switch>
      {!layout.switchesExtensions ? (
        <p className="text-[10px] leading-relaxed text-text-muted">
          Picking this layout leaves extensions as they are.
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1">
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search extensions…"
              aria-label="Search extensions"
              spellCheck={false}
              className="min-w-0 flex-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
            />
            <button
              onClick={() => tickShown(true)}
              disabled={tickable.length === 0}
              className={smallBtnCls}
            >
              All
            </button>
            <button
              onClick={() => tickShown(false)}
              disabled={tickable.length === 0}
              className={smallBtnCls}
            >
              None
            </button>
          </div>
          <div className="max-h-56 overflow-y-auto">
            {shown.length === 0 && (
              <div className="px-1 py-1 text-[11px] text-text-muted">No matches.</div>
            )}
            {tickable.map((c) => (
              <label
                key={c.id}
                className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={ticked(c.id)}
                  onChange={(e) =>
                    void setLayoutExtensions(layoutId, { [c.id]: e.target.checked })
                  }
                />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
              </label>
            ))}
            {held.length > 0 && (
              <div role="group" aria-labelledby={heldLabelId}>
                <div
                  id={heldLabelId}
                  className="mt-1 px-1 py-1 text-[9px] uppercase tracking-widest text-text-muted"
                >
                  Not switched by layouts
                </div>
                {held.map((c) => (
                  <div
                    key={c.id}
                    className="flex items-center gap-2 px-1 py-1 text-[11px] text-text-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 text-[10px]">{HOLD_REASON[c.hold]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
