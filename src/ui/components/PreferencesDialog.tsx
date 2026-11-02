// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Application-wide Preferences pop-up (Ctrl/Cmd+, or the ⚙ button in the top
// bar). Left rail of sections, controls on the right. Everything writes to the
// persisted settings store immediately — there is no OK/Apply; close when done.
// Theme and layout drive their own stores (themes.ts / dock.ts) directly.

import { useEffect, useMemo, useRef, useState } from "react";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { uiZoom } from "@/ui/frame-point";
import { SettingsFieldList } from "@/extensions/SettingsFieldList";
import { useRegistry } from "@/extensions/registry";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { resetSettings } from "@/state/settings-store";
import { PrefSearchContext } from "@/ui/preferences/fields";
import { closePreferences, usePreferencesStore } from "@/ui/preferences/preferences-store";
import {
  sectionMatches,
  type PrefGroup,
  type PrefSection,
  type SearchGroup,
} from "@/ui/preferences/section-model";
import { CORE_SECTIONS } from "@/ui/preferences/sections";

export {
  openPreferences,
  closePreferences,
  togglePreferences,
} from "@/ui/preferences/preferences-store";
export {
  Field,
  ToggleField,
  SliderField,
  OptionRow,
  useFieldVisible,
} from "@/ui/preferences/fields";

const GROUPS: PrefGroup[] = ["General", "Extensions"];

// Section-rail width: user-adjustable via the drag handle, persisted across
// sessions. Clamped so the rail can't collapse to nothing or swallow the panel.
const RAIL_MIN = 120;
const RAIL_MAX = 320;
const RAIL_DEFAULT = 144; // matches the old fixed w-36
const RAIL_STORE_KEY = "safelight.prefs.railWidth";
const loadRailWidth = () => {
  try {
    const saved = Number(localStorage.getItem(RAIL_STORE_KEY));
    return saved >= RAIL_MIN && saved <= RAIL_MAX ? saved : RAIL_DEFAULT;
  } catch {
    return RAIL_DEFAULT;
  }
};

export function PreferencesDialog() {
  const open = usePreferencesStore((s) => s.open);
  const target = usePreferencesStore((s) => s.target);
  const extSettings = useRegistry((s) => s.settings);
  const [sectionId, setSectionId] = useState<string>("Interface");
  const [query, setQuery] = useState("");
  const [railWidth, setRailWidth] = useState(loadRailWidth);

  // Latest query in a ref so the (capture-phase) escape handler can read it
  // without re-registering on every keystroke.
  const queryRef = useRef("");
  queryRef.current = query;

  // Drag-to-resize the section rail. Pointer capture keeps the drag alive even
  // when the cursor outruns the 1px handle; the final width is persisted on up.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: React.PointerEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: railWidth };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onHandleMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const next = Math.min(
      RAIL_MAX,
      Math.max(RAIL_MIN, dragRef.current.startW + (e.clientX - dragRef.current.startX) / uiZoom()),
    );
    setRailWidth(next);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    try {
      localStorage.setItem(RAIL_STORE_KEY, String(railWidth));
    } catch {
      // Storage unavailable: the width just won't persist.
    }
    (e.target as Element).releasePointerCapture(e.pointerId);
  };

  // One section per extension that registered settings — auto-rendered from its
  // declarative fields, or its custom component if it supplied one.
  const extSections = useMemo<PrefSection[]>(
    () =>
      Object.entries(extSettings)
        .map(([id, c]) => ({
          id,
          label: c.title ?? id,
          group: "Extensions" as const,
          order: c.order ?? 100,
          items: c.fields.map((f) => ({
            label: f.label,
            terms: [
              f.label,
              f.hint ?? "",
              ...(f.type === "select" ? f.options.map((o) => o.label) : []),
            ]
              .join(" ")
              .toLowerCase(),
          })),
          keywords: c.keywords ?? [],
          render: (q: string) => {
            const Custom = c.component;
            return Custom ? (
              <Custom />
            ) : (
              <SettingsFieldList extensionId={id} fields={c.fields} query={q} />
            );
          },
        }))
        .sort(
          (a, b) => (a.order - b.order) || a.label.localeCompare(b.label),
        ),
    [extSettings],
  );

  const sections = useMemo(
    () => [...CORE_SECTIONS, ...extSections],
    [extSections],
  );

  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => sections.filter((s) => !q || sectionMatches(s, q)),
    [sections, q],
  );

  // Flat, grouped-by-section search results: the individual settings that match,
  // each landing under its section so the user sees the setting *and* where it
  // lives. A section that matches only via its label/synonyms (no specific item)
  // still appears, as a single jump-to-section entry.
  const results = useMemo<SearchGroup[]>(() => {
    if (!q) return [];
    const out: SearchGroup[] = [];
    for (const s of sections) {
      const items = s.items.filter((it) => it.terms.includes(q));
      if (items.length === 0 && !sectionMatches(s, q)) continue;
      out.push({ section: s, items });
    }
    return out;
  }, [sections, q]);

  // Deep-link: when opened with a target id, jump there and clear any search.
  useEffect(() => {
    if (open && target) {
      setSectionId(target);
      setQuery("");
    }
  }, [open, target]);

  // Keep the selection valid as search filters the list (or an extension that
  // owned the open section is uninstalled).
  useEffect(() => {
    if (!open) return;
    if (!visible.some((s) => s.id === sectionId)) {
      setSectionId(visible[0]?.id ?? "Interface");
    }
  }, [open, visible, sectionId]);

  // Esc clears the search first, then closes (via the shared modal stack, so a
  // nested dialog on top still closes before us).
  useEffect(() => {
    if (!open) return;
    return pushEscapeHandler(() => {
      if (queryRef.current) setQuery("");
      else closePreferences();
    });
  }, [open]);

  if (!open) return null;

  const active = sections.find((s) => s.id === sectionId) ?? visible[0];
  const hasExtensions = visible.some((s) => s.group === "Extensions");

  return (
    <ModalWindow
      title="Preferences"
      onClose={closePreferences}
      titlebar={
        <div className="relative flex items-center">
          <svg
            viewBox="0 0 16 16"
            aria-hidden="true"
            className="pointer-events-none absolute left-2 h-3 w-3 text-text-muted"
          >
            <circle
              cx="7"
              cy="7"
              r="4.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <line
              x1="10.5"
              y1="10.5"
              x2="14"
              y2="14"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
            />
          </svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            aria-label="Search settings"
            spellCheck={false}
            className="w-48 rounded bg-surface-1 py-0.5 pl-7 pr-6 text-[11px] text-text-primary outline-none transition-[width] placeholder:text-text-muted focus:w-64 focus:bg-surface-3"
          />
          {query && (
            <button
              onClick={() => setQuery("")}
              title="Clear search"
              className="absolute right-1 rounded px-1 text-[12px] leading-none text-text-muted hover:text-text-primary"
            >
              ×
            </button>
          )}
        </div>
      }
    >
        <div className="flex min-h-0 flex-1">
          {q ? (
            // Search mode: a flat results list (setting → its section) replaces the
            // rail+panel. Picking a result jumps to that section and clears search.
            <SearchResults
              groups={results}
              query={q}
              onPick={(id) => {
                setSectionId(id);
                setQuery("");
              }}
            />
          ) : (
            <>
              <div
                style={{ width: railWidth }}
                className="shrink-0 overflow-y-auto bg-surface-0/40 py-2"
              >
                {GROUPS.map((g) => {
                  const items = visible.filter((s) => s.group === g);
                  if (items.length === 0) return null;
                  return (
                    <div key={g} className="mb-1">
                      {/* Show group headers only once the Extensions group exists —
                          otherwise a lone "General" header is just noise. */}
                      {hasExtensions && (
                        <div className="px-3 pb-0.5 pt-1 text-[9px] uppercase tracking-widest text-text-muted">
                          {g}
                        </div>
                      )}
                      {items.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setSectionId(s.id)}
                          className={`block w-full truncate px-3 py-1.5 text-left text-[11px] tracking-wider ${
                            active?.id === s.id
                              ? "bg-surface-3 text-text-primary"
                              : "text-text-secondary hover:text-text-primary"
                          }`}
                        >
                          {s.label}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
              <div
                onPointerDown={onHandleDown}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
                onPointerCancel={onHandleUp}
                onLostPointerCapture={onHandleUp}
                title="Drag to resize"
                className="w-1 shrink-0 cursor-col-resize touch-none border-r border-border hover:bg-slider-fill/40"
              />
              <div className="flex-1 overflow-y-auto p-4">{active?.render(q)}</div>
            </>
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center justify-between border-t border-border bg-surface-2 px-3">
          <button
            onClick={resetSettings}
            title="Restore every preference to its default (theme and layout are kept)"
            className="rounded px-2 py-0.5 text-[10px] text-text-muted hover:bg-surface-4 hover:text-text-primary"
          >
            Reset to defaults
          </button>
          <span className="text-[10px] text-text-muted">
            Changes apply immediately
          </span>
        </div>
    </ModalWindow>
  );
}

// ─── Search results ──────────────────────────────────────────────────────────
// Shown in place of the rail+panel while the search box has text. Each matching
// setting is listed under its section heading, so the result tells you both the
// setting and where to find it. Clicking either the setting or the heading opens
// that section.

function SearchResults({
  groups,
  query,
  onPick,
}: {
  groups: SearchGroup[];
  query: string;
  onPick: (sectionId: string) => void;
}) {
  if (groups.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto p-4">
        <p className="text-[11px] leading-relaxed text-text-muted">
          No settings match “{query}”.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4">
      {groups.map(({ section, items }) => {
        // Sections matched by a specific setting render only the matching
        // controls (filter = query). Sections matched only by their title or a
        // synonym have no single setting to isolate, so show the whole panel.
        const filter = items.length > 0 ? query : "";
        return (
          <div key={section.id} className="mb-6 last:mb-0">
            <button
              onClick={() => onPick(section.id)}
              title={`Open ${section.label}`}
              className="mb-2 flex items-center gap-1 text-[9px] uppercase tracking-widest text-text-muted hover:text-text-secondary"
            >
              {section.group === "Extensions" && (
                <span className="opacity-70">Extensions ›</span>
              )}
              {section.label}
            </button>
            <PrefSearchContext.Provider value={filter}>
              {section.render(filter)}
            </PrefSearchContext.Provider>
          </div>
        );
      })}
    </div>
  );
}
