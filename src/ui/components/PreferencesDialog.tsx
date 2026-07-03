// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Application-wide Preferences pop-up (Ctrl/Cmd+, or the ⚙ button in the top
// bar). Left rail of sections, controls on the right. Everything writes to the
// persisted settings store immediately — there is no OK/Apply; close when done.
// Theme and layout drive their own stores (themes.ts / dock.ts) directly.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { pushEscapeHandler } from "@/ui/escape-stack";
import { SettingsFieldList } from "@/extensions/SettingsFieldList";
import {
  KEY_ACTIONS,
  comboFromEvent,
  findConflicts,
  resetAllBindings,
  resetBinding,
  setBinding,
  setShortcutsSuspended,
  useExtensionActions,
  useKeybindings,
  type ActionCategory,
} from "@/state/keybindings-store";
import { useRegistry } from "@/extensions/registry";
import { ModalWindow } from "@/ui/components/ModalWindow";
import { Select } from "@/ui/components/Select";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import {
  addUserLayout,
  applyDockLayout,
  CUSTOM_LAYOUT,
  deleteUserLayout,
  renameUserLayout,
  updateUserLayout,
  useLayoutStore,
  useUserLayouts,
} from "@/extensions/dock";
import { openExtensions } from "./ExtensionsDialog";
import {
  CANVAS_SURROUND_SHADES,
  DEFAULT_SETTINGS,
  resetSettings,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import {
  applyPipeline,
  DEFAULT_PIPELINE,
  usePipelineStore,
} from "@/extensions/pipelines";
import { clearRawCache } from "@/raw/raw-cache";
import { isNativeFS, nativeFs } from "@/project/native-fs";
import type { ExternalCatalogEntry } from "@/extensions/types";
import {
  preDecodeRawsForCache,
  rebuildThumbnails,
} from "@/modules/library/import-photos";
import type { PreviewSource } from "@/state/settings-store";
import { useCatalogStore } from "@/state/catalog-store";
import type { SortDirection, SortField } from "@/catalog/types";
import { COLOR_SPACES } from "@/rendering/color-space";
import {
  checkForUpdateNow,
  fetchAllReleases,
  dismissVersion,
  installVersion,
  openUrl,
  type CheckResult,
  type ReleaseEntry,
  type UpdateChannel,
} from "@/update/update-checker";

// ─── Open/close state (exported so the keyboard hook and TopBar can drive it) ─

const useOpen = create<{ open: boolean; target?: string }>(() => ({
  open: false,
}));
/** Open Preferences, optionally deep-linked to a section id (a core section's
 *  id or an extension id). */
export const openPreferences = (sectionId?: string) =>
  useOpen.setState({ open: true, target: sectionId });
export const closePreferences = () =>
  useOpen.setState({ open: false, target: undefined });
export const togglePreferences = () =>
  useOpen.setState((s) => ({ open: !s.open, target: undefined }));

// ─── Sections ────────────────────────────────────────────────────────────────
// The window is data-driven: a list of sections grouped into "General" (core,
// each backed by a bespoke component) and "Extensions" (one per extension that
// registered settings, auto-rendered from its declarative fields).
//
// Two things feed the header search:
//   • `items` — the individual settings in a section (display label + the text
//     they're searchable by). The search results list shows these directly, each
//     tagged with its section, so a query surfaces specific settings and where
//     they live rather than a whole tab.
//   • `keywords` — extra section-level synonyms (e.g. "tone map", "plugins") that
//     match the section as a whole when no individual item label fits.

type PrefGroup = "General" | "Extensions";

interface PrefSetting {
  /** Display label shown in search results. */
  label: string;
  /** Lowercase text this setting matches against (label + hint + option labels). */
  terms: string;
}

interface PrefSection {
  id: string;
  label: string;
  group: PrefGroup;
  items: PrefSetting[];
  keywords: string[];
  order?: number;
  render: (query: string) => React.ReactNode;
}

/** Build PrefSettings from a plain list of labels (core sections, no per-item hints). */
const settings = (...labels: string[]): PrefSetting[] =>
  labels.map((label) => ({ label, terms: label.toLowerCase() }));

/** A section matches a (lowercased) query via its title, any setting, or a synonym. */
const sectionMatches = (s: PrefSection, q: string): boolean =>
  s.label.toLowerCase().includes(q) ||
  s.items.some((it) => it.terms.includes(q)) ||
  s.keywords.some((k) => k.toLowerCase().includes(q));

/** One section's worth of search hits: the matching settings (empty = title/synonym match only). */
interface SearchGroup {
  section: PrefSection;
  items: PrefSetting[];
}

// While searching, section bodies render their *real* controls inside this
// context. The Field/Toggle/Slider wrappers read it and hide themselves when
// their label/hint doesn't match — so the results show the matching settings as
// live, editable controls rather than static text. Empty string = no filtering.
const PrefSearchContext = createContext("");

/** A field wrapper is visible when there's no active filter, or its text matches it.
 *  Exported so extension-contributed settings sections (e.g. core.accessibility)
 *  can reuse the same search-aware field primitives. */
export function useFieldVisible(label: string, hint?: string): boolean {
  const q = useContext(PrefSearchContext);
  if (!q) return true;
  return (
    label.toLowerCase().includes(q) ||
    (hint?.toLowerCase().includes(q) ?? false)
  );
}

// Fixed viewport gestures shown (read-only) at the bottom of the Shortcuts
// section. Hoisted to module scope so both the search index (Shortcuts `items`)
// and the section render share one source of truth. [combo, description].
const VIEWPORT_FIXED: [string, string][] = [
  ["Esc", "Exit tool / close dialog"],
  ["Space", "Toggle zoom (fit ↔ 100%)"],
  ["Ctrl/⌘ + Click", "Zoom in/out while masking or healing"],
  ["Ctrl/⌘ + Drag", "Pan while zoomed"],
];

const CORE_SECTIONS: PrefSection[] = [
  {
    id: "Interface",
    label: "Interface",
    group: "General",
    items: settings(
      "Theme",
      "Panel layout",
      "Interface scale",
      "Canvas surround",
      "Color assessment border",
      "Background dimming",
      "Sliders jump to cursor",
      "Highlight & shadow detail sliders",
      "Restore last project on launch",
      "Interface font",
    ),
    keywords: ["surround", "background", "grey", "gray", "neutral", "assessment", "proof", "mat", "border", "dim", "darken", "window", "preferences", "modal", "slider", "jump", "cursor", "click", "drag", "tone", "detail", "highlight", "shadow", "basic", "micro-contrast", "clarity"],
    render: () => <InterfaceSection />,
  },
  // Accessibility lives in the `core.accessibility` built-in extension (so the
  // whole opt-in stack can be disabled) — it registers its own settings section
  // via api.registerSettings. See src/extensions/accessibility/.
  {
    id: "Library",
    label: "Library",
    group: "General",
    items: settings(
      "Default grid size",
      "Default sort",
      "Confirm before removing photos",
    ),
    keywords: [],
    render: () => <LibrarySection />,
  },
  {
    id: "Previews",
    label: "Previews",
    group: "General",
    items: settings(
      "Preview source",
      "Thumbnail quality",
      "Store previews on disk",
      "Grid thumbnails",
      "Cache decoded RAW previews",
      "Cached preview resolution",
      "Cache storage",
      "Catalog location",
      "Separate catalog location",
      "Stored catalogs",
    ),
    keywords: [
      "Embedded JPEG",
      "Rebuild thumbnails",
      "Clear preview cache",
      "catalog storage",
      "read-only",
      "memory card",
      "sd card",
      "ssd",
      "reclaim disk",
      "orphaned catalog",
    ],
    render: () => <PreviewsSection />,
  },
  {
    id: "Rendering",
    label: "Rendering",
    group: "General",
    items: settings("Display transform"),
    keywords: ["tone map", "pipeline"],
    render: () => <RenderingSection />,
  },
  {
    id: "Performance",
    label: "Performance",
    group: "General",
    items: settings(
      "Develop render resolution",
      "Open photos at",
      "GPU source cache",
      "Prefetch neighbours",
      "High bit-depth previews",
      "Live histogram",
    ),
    keywords: [],
    render: () => <PerformanceSection />,
  },
  {
    id: "Export",
    label: "Export",
    group: "General",
    items: settings(
      "Default format",
      "Default quality",
      "Default resolution",
      "Color space",
      "Bundle multiple photos as ZIP",
    ),
    keywords: [],
    render: () => <ExportSection />,
  },
  {
    id: "Shortcuts",
    label: "Shortcuts",
    group: "General",
    items: settings(
      "Single-key shortcuts",
      ...KEY_ACTIONS.map((a) => a.label),
      ...VIEWPORT_FIXED.map(([, label]) => label),
    ),
    keywords: ["keybindings", "keyboard"],
    render: () => <ShortcutsSection />,
  },
  {
    id: "Extensions",
    label: "Extensions",
    group: "General",
    items: settings(
      "Official extension topic",
      "Check extensions for updates",
      "Auto-update extensions",
    ),
    keywords: ["Manage", "plugins"],
    render: () => <ExtensionsSection />,
  },
  {
    id: "Updates",
    label: "Updates",
    group: "General",
    items: settings(
      "Check for updates on startup",
      "Update channel",
      "Manual check",
      "Release history",
    ),
    keywords: [],
    render: () => <UpdatesSection />,
  },
  {
    id: "About",
    label: "About",
    group: "General",
    items: settings("Version", "Project"),
    keywords: ["Electron", "Chromium", "Platform", "license"],
    render: () => <AboutSection />,
  },
];

const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "dateImported", label: "Date imported" },
  { value: "dateCreated", label: "Date created" },
  { value: "filename", label: "Filename" },
  { value: "rating", label: "Rating" },
];

const GROUPS: PrefGroup[] = ["General", "Extensions"];

// Section-rail width: user-adjustable via the drag handle, persisted across
// sessions. Clamped so the rail can't collapse to nothing or swallow the panel.
const RAIL_MIN = 120;
const RAIL_MAX = 320;
const RAIL_DEFAULT = 144; // matches the old fixed w-36
const RAIL_STORE_KEY = "safelight.prefs.railWidth";
const loadRailWidth = () => {
  const saved = Number(localStorage.getItem(RAIL_STORE_KEY));
  return saved >= RAIL_MIN && saved <= RAIL_MAX ? saved : RAIL_DEFAULT;
};

export function PreferencesDialog() {
  const open = useOpen((s) => s.open);
  const target = useOpen((s) => s.target);
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
      Math.max(RAIL_MIN, dragRef.current.startW + (e.clientX - dragRef.current.startX)),
    );
    setRailWidth(next);
  };
  const onHandleUp = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    localStorage.setItem(RAIL_STORE_KEY, String(railWidth));
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

// ─── Section bodies ──────────────────────────────────────────────────────────

function InterfaceSection() {
  const themes = useRegistry((s) => s.themes);
  const activeTheme = useThemeStore((s) => s.activeId);
  const uiScale = useSettings((s) => s.uiScale);
  const assessBorderPct = useSettings((s) => s.assessBorderPct);
  const windowDim = useSettings((s) => s.windowDim);
  const sliderJumpToCursor = useSettings((s) => s.sliderJumpToCursor);
  const basicDetailSliders = useSettings((s) => s.basicDetailSliders);
  const restoreLastProject = useSettings((s) => s.restoreLastProject);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Theme" hint="Themes from extensions appear here too.">
        <Select
          value={activeTheme}
          onChange={applyTheme}
          ariaLabel="Theme"
          className="w-full"
          options={Object.values(themes)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => ({ value: t.id, label: t.name }))}
        />
      </Field>
      <LayoutField />
      <SliderField
        label="Interface scale"
        value={uiScale}
        min={0.8}
        max={2}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => updateSettings({ uiScale: v })}
      />
      <CanvasSurroundField />
      <SliderField
        label="Color assessment border"
        value={assessBorderPct}
        min={1}
        max={12}
        step={0.5}
        format={(v) => `${v}%`}
        onChange={(v) => updateSettings({ assessBorderPct: v })}
      />
      <div>
        <SliderField
          label="Background dimming"
          value={windowDim}
          min={0}
          max={0.8}
          step={0.05}
          format={(v) => `${Math.round(v * 100)}%`}
          onChange={(v) => updateSettings({ windowDim: v })}
        />
        {useFieldVisible("Background dimming") && (
          <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
            How much the app dims behind the Preferences and Extensions windows.
            0% leaves the photo fully visible; higher values darken it to focus
            on the window.
          </p>
        )}
      </div>
      <ToggleField
        label="Sliders jump to cursor"
        hint="Clicking anywhere on a slider snaps its value to the cursor, then drags from there. Off keeps the default: a click grabs the current value and only dragging changes it. Hold Shift while dragging for fine control either way."
        checked={sliderJumpToCursor}
        onChange={(v) => updateSettings({ sliderJumpToCursor: v })}
      />
      <ToggleField
        label="Highlight & shadow detail sliders"
        hint="Add Highlight Detail and Shadow Detail sliders to the Develop Basic panel for per-band micro-contrast control. Off by default to keep the panel compact — highlight recovery and shadow lift already preserve detail on their own; turn this on to tune or reverse that per band."
        checked={basicDetailSliders}
        onChange={(v) => updateSettings({ basicDetailSliders: v })}
      />
      <ToggleField
        label="Restore last project on launch"
        hint="Reopen the most-recently-used project at startup instead of the welcome grid. Falls back to the grid if the folder can't be reopened."
        checked={restoreLastProject}
        onChange={(v) => updateSettings({ restoreLastProject: v })}
      />
      <FontField />
    </div>
  );
}

// AccessibilitySection moved to src/extensions/accessibility/AccessibilitySettings.tsx
// (the core.accessibility built-in extension registers it via api.registerSettings).

// Panel-layout manager: a selectable list of layouts (Custom + the user's saved
// layouts + read-only presets contributed by extensions). User layouts can be
// updated to the current arrangement, renamed inline, or deleted; "Add layout"
// captures the current dock as a new named layout. Replaces the old dropdown —
// a dropdown can only pick, and the user now needs to manage the list.
function LayoutField() {
  const presets = useRegistry((s) => s.layouts);
  const userLayouts = useUserLayouts((s) => s.layouts);
  const activeId = useLayoutStore((s) => s.activeId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  // Guards against committing twice when Enter (or Esc) unmounts the input and
  // fires its blur handler too. Reset each time an input opens.
  const committedRef = useRef(false);

  // While an inline name input is open, Esc cancels it (top of the modal
  // escape stack) instead of closing Preferences.
  const inputOpen = adding || editingId !== null;
  useEffect(() => {
    if (!inputOpen) return;
    return pushEscapeHandler(() => {
      committedRef.current = true; // suppress the unmount blur-commit
      setAdding(false);
      setEditingId(null);
    });
  }, [inputOpen]);

  if (!useFieldVisible("Panel layout", "dock arrangement window")) return null;

  const userList = Object.values(userLayouts).sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const presetList = Object.values(presets).sort((a, b) =>
    a.name.localeCompare(b.name),
  );

  const startRename = (id: string, name: string) => {
    committedRef.current = false;
    setAdding(false);
    setEditingId(id);
    setDraft(name);
  };
  const commitRename = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    if (editingId) renameUserLayout(editingId, draft);
    setEditingId(null);
  };
  const startAdd = () => {
    committedRef.current = false;
    setEditingId(null);
    setAdding(true);
    setDraft("");
  };
  const commitAdd = () => {
    if (committedRef.current) return;
    committedRef.current = true;
    addUserLayout(draft);
    setAdding(false);
    setDraft("");
  };

  const nameInput = (onCommit: () => void) => (
    <div className="flex items-center gap-1.5 bg-surface-2 px-2 py-1">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onCommit();
        }}
        onBlur={onCommit}
        placeholder="Layout name"
        aria-label="Layout name"
        spellCheck={false}
        className="min-w-0 flex-1 rounded bg-surface-1 px-1.5 py-0.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
      />
      <button
        // Commit happens on blur; mousedown would blur the input first and make
        // this a no-op, so commit here and let blur see the cleared state.
        onMouseDown={(e) => {
          e.preventDefault();
          onCommit();
        }}
        className="rounded bg-slider-fill px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
      >
        Save
      </button>
    </div>
  );

  return (
    <div>
      <div className={labelCls}>Panel layout</div>
      <div className="mt-1.5 overflow-hidden rounded border border-border">
        <LayoutRow
          active={activeId === CUSTOM_LAYOUT}
          name="Custom"
          hint="Your live arrangement — any change you make to a layout is kept here."
          onClick={() => applyDockLayout(CUSTOM_LAYOUT)}
        />
        {userList.map((l) =>
          editingId === l.id ? (
            <div key={l.id} className="border-t border-border-subtle">
              {nameInput(commitRename)}
            </div>
          ) : (
            <LayoutRow
              key={l.id}
              active={activeId === l.id}
              name={l.name}
              onClick={() => applyDockLayout(l.id)}
              actions={
                <>
                  <RowButton
                    title="Save the current arrangement into this layout"
                    onClick={() => updateUserLayout(l.id)}
                  >
                    ↻
                  </RowButton>
                  <RowButton
                    title="Rename"
                    onClick={() => startRename(l.id, l.name)}
                  >
                    ✎
                  </RowButton>
                  <RowButton
                    title="Delete layout"
                    onClick={() => deleteUserLayout(l.id)}
                  >
                    ×
                  </RowButton>
                </>
              }
            />
          ),
        )}
        {adding && (
          <div className="border-t border-border-subtle">
            {nameInput(commitAdd)}
          </div>
        )}
        {presetList.length > 0 && (
          <div className="border-t border-border bg-surface-0/30 px-2 py-1 text-[9px] uppercase tracking-widest text-text-muted">
            Presets
          </div>
        )}
        {presetList.map((l) => (
          <LayoutRow
            key={l.id}
            active={activeId === l.id}
            name={l.name}
            hint={l.description}
            onClick={() => applyDockLayout(l.id)}
          />
        ))}
      </div>
      <div className="mt-2">
        <button onClick={startAdd} className={btnCls}>
          + Add layout
        </button>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
        Saves the current panel arrangement (both Library and Develop) as a named
        layout. Switch layouts here or from the Layout menu in the top bar.
      </p>
    </div>
  );
}

function LayoutRow({
  active,
  name,
  hint,
  onClick,
  actions,
}: {
  active: boolean;
  name: string;
  hint?: string;
  onClick: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div
      className={`group flex items-center border-t border-border-subtle first:border-t-0 ${
        active ? "bg-surface-3" : "hover:bg-surface-2"
      }`}
    >
      <button
        onClick={onClick}
        title={hint}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left"
      >
        <span className="w-3 shrink-0 text-[11px] text-slider-fill">
          {active ? "✓" : ""}
        </span>
        <span
          className={`truncate text-[11px] ${
            active ? "text-text-primary" : "text-text-secondary"
          }`}
        >
          {name}
        </span>
      </button>
      {actions && (
        <div className="flex shrink-0 items-center gap-0.5 px-1 opacity-0 transition-opacity group-hover:opacity-100">
          {actions}
        </div>
      )}
    </div>
  );
}

function RowButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className="rounded px-1.5 py-0.5 text-[12px] leading-none text-text-muted hover:bg-surface-4 hover:text-text-primary"
    >
      {children}
    </button>
  );
}

function CanvasSurroundField() {
  const override = useSettings((s) => s.canvasSurroundOverride);
  const surround = useSettings((s) => s.canvasSurround);
  if (!useFieldVisible("Canvas surround", "color behind the image in Develop"))
    return null;
  return (
    <div>
      <button
        role="switch"
        aria-checked={override}
        onClick={() => updateSettings({ canvasSurroundOverride: !override })}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">Canvas surround</span>
        <span
          aria-hidden="true"
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            override ? "bg-slider-fill" : "bg-surface-3"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
              override ? "left-3.5" : "left-0.5"
            }`}
          />
        </span>
      </button>
      <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
        A fixed shade behind the image in Develop, independent of the theme.
        A middle grey keeps brightness, contrast and saturation perception
        accurate while editing (as darktable and Ansel do); black and white
        bracket the range. Off = follow the active theme. Also adjustable from
        the Develop toolbar.
      </p>
      <div
        className={`mt-2 flex gap-1.5 transition-opacity ${
          override ? "" : "pointer-events-none opacity-40"
        }`}
      >
        {CANVAS_SURROUND_SHADES.map((shade) => (
          <button
            key={shade.value}
            title={shade.label}
            aria-label={shade.label}
            aria-pressed={surround === shade.value}
            disabled={!override}
            onClick={() => updateSettings({ canvasSurround: shade.value })}
            className={`relative h-7 flex-1 rounded border transition-all ${
              surround === shade.value
                ? "border-slider-fill ring-1 ring-slider-fill"
                : "border-border hover:border-text-muted"
            }`}
            style={{ background: shade.value }}
          >
            {surround === shade.value && (
              // A checkmark, not just the ring/colour, marks the active swatch
              // (WCAG 1.4.1). The dark halo keeps the white tick legible on
              // every shade, light or dark.
              <span
                className="pointer-events-none absolute inset-0 flex items-center justify-center text-[11px] font-bold leading-none text-white"
                style={{ textShadow: "0 0 2px #000, 0 0 2px #000" }}
              >
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

const FONT_PRESETS: { value: string; label: string }[] = [
  { value: "", label: "Default (Mono)" },
  {
    value: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
    label: "System Sans",
  },
  { value: "Inter, system-ui, sans-serif", label: "Inter" },
  { value: 'Georgia, "Times New Roman", serif', label: "Serif" },
];

function FontField() {
  const uiFont = useSettings((s) => s.uiFont);
  const isPreset = FONT_PRESETS.some((p) => p.value === uiFont);
  return (
    <Field
      label="Interface font"
      hint="Any installed font works in the custom field (CSS font-family syntax)."
    >
      <OptionRow
        value={isPreset ? uiFont : "custom"}
        options={FONT_PRESETS}
        onChange={(v) => updateSettings({ uiFont: v as string })}
      />
      <input
        value={uiFont}
        onChange={(e) => updateSettings({ uiFont: e.target.value })}
        placeholder='Custom, e.g. "IBM Plex Sans", sans-serif'
        aria-label="Custom interface font family"
        spellCheck={false}
        className={`mt-1.5 ${inputCls}`}
      />
    </Field>
  );
}

function LibrarySection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <SliderField
        label="Default grid size"
        value={s.defaultGridSize}
        min={120}
        max={360}
        step={10}
        format={(v) => `${v} px`}
        onChange={(v) => {
          updateSettings({ defaultGridSize: v });
          useUIStore.getState().setGridSize(v); // apply live
        }}
      />
      <Field label="Default sort">
        <div className="flex gap-1.5">
          <Select
            value={s.defaultSortField}
            onChange={(v) => updateSettings({ defaultSortField: v as SortField })}
            ariaLabel="Default sort field"
            className="flex-1"
            options={SORT_FIELDS.map((f) => ({ value: f.value, label: f.label }))}
          />
          <Select
            value={s.defaultSortDirection}
            onChange={(v) =>
              updateSettings({ defaultSortDirection: v as SortDirection })
            }
            ariaLabel="Default sort direction"
            className="flex-1"
            options={[
              { value: "desc", label: "Descending" },
              { value: "asc", label: "Ascending" },
            ]}
          />
        </div>
      </Field>
      <ToggleField
        label="Show photos in subfolders"
        hint="When a folder is selected, also show photos from its subfolders. Off shows only photos directly inside the selected folder."
        checked={s.showSubfolderPhotos}
        onChange={(v) => updateSettings({ showSubfolderPhotos: v })}
      />
      <ToggleField
        label="Confirm before removing photos"
        hint="Ask for confirmation when removing photos from the catalog. The originals on disk are never deleted either way."
        checked={s.confirmRemovePhotos}
        onChange={(v) => updateSettings({ confirmRemovePhotos: v })}
      />
    </div>
  );
}

function RenderingSection() {
  const pipelines = useRegistry((s) => s.pipelines);
  const activeId = usePipelineStore((s) => s.activeId);
  const active = pipelines[activeId];

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Display transform"
        hint="How scene-linear image data is tone-mapped for display. Applies everywhere the pipeline renders — develop, loupe, thumbnails and export — so output matches the screen. Transforms from extensions appear here too."
      >
        <Select
          value={active ? activeId : DEFAULT_PIPELINE}
          onChange={applyPipeline}
          ariaLabel="Display transform"
          className="w-full"
          options={Object.values(pipelines).map((p) => ({ value: p.id, label: p.name }))}
        />
      </Field>
      {active?.description && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          {active.description}
        </p>
      )}
      <p className="text-[10px] leading-relaxed text-text-muted">
        Replacement transforms disable the default RAW base curve and interpret
        the tone sliders through their own response — the same edit will read
        differently between transforms by design.
      </p>
    </div>
  );
}

// Cache-mode tri-state derived from two booleans: caching off, or on with/without
// the eager full-catalog prefetch. Stored as two flags so existing settings
// migrate for free (rawCacheEnabled stays meaningful; prefetch defaults on).
type CacheMode = "eager" | "ondemand" | "off";

function PreviewsSection() {
  const s = useSettings();
  const cacheMode: CacheMode = !s.rawCacheEnabled
    ? "off"
    : s.rawCachePrefetch
      ? "eager"
      : "ondemand";

  const [cleared, setCleared] = useState(false);
  const [rebuild, setRebuild] = useState<{ done: number; total: number } | null>(
    null,
  );
  const rebuilding = rebuild !== null && rebuild.done < rebuild.total;
  const handleRebuild = () => {
    const photos = useCatalogStore.getState().photos;
    if (photos.length === 0 || rebuilding) return;
    setRebuild({ done: 0, total: photos.length });
    void rebuildThumbnails(
      photos,
      (done, total) => setRebuild({ done, total }),
      (p) => useCatalogStore.getState().updatePhoto(p),
    );
  };

  const [cacheAll, setCacheAll] = useState<{ done: number; total: number } | null>(
    null,
  );
  const cachingAll = cacheAll !== null && cacheAll.done < cacheAll.total;
  const handleCacheAll = () => {
    const photos = useCatalogStore.getState().photos;
    if (photos.length === 0 || cachingAll || !s.rawCacheEnabled) return;
    setCacheAll({ done: 0, total: 1 }); // placeholder until the real count lands
    void preDecodeRawsForCache(photos, {
      force: true,
      onProgress: (done, total) => setCacheAll({ done, total }),
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Preview source"
        hint="How RAW grid previews are built. Embedded uses the camera's JPEG (fastest). Rendered always decodes the RAW (neutral, slower). Auto uses the embedded JPEG when it's already sharp enough, else renders."
      >
        <OptionRow
          value={s.previewSource}
          options={[
            { value: "auto", label: "Auto" },
            { value: "embedded", label: "Embedded JPEG" },
            { value: "rendered", label: "Rendered" },
          ]}
          onChange={(v) => updateSettings({ previewSource: v as PreviewSource })}
        />
      </Field>
      <Field
        label="Thumbnail quality"
        hint="Long edge of rendered grid thumbnails. Higher is sharper but slower; takes effect on newly rendered thumbnails."
      >
        <OptionRow
          value={s.thumbMaxEdge}
          options={[
            { value: 320, label: "Fast (320px)" },
            { value: 640, label: "Balanced (640px)" },
            { value: 960, label: "Sharp (960px)" },
          ]}
          onChange={(v) =>
            updateSettings({ thumbMaxEdge: v as 320 | 640 | 960 })
          }
        />
      </Field>
      <ToggleField
        label="Store previews on disk"
        hint="Save grid previews in the project's .safelight/previews folder so they load instantly next open. Off keeps the folder small but rebuilds previews on demand each open."
        checked={s.persistPreviews}
        onChange={(v) => updateSettings({ persistPreviews: v })}
      />
      <Field
        label="Grid thumbnails"
        hint="Re-decodes every photo in the open project and regenerates its grid thumbnail at the current Thumbnail quality. Use after changing the settings above."
      >
        <button onClick={handleRebuild} disabled={rebuilding} className={btnCls}>
          {rebuilding ? "Rebuilding…" : "Rebuild thumbnails"}
        </button>
        {rebuild !== null && (
          <span className="ml-2 text-[10px] text-text-muted">
            {rebuilding
              ? `${rebuild.done} / ${rebuild.total}`
              : `Rebuilt ${rebuild.total}.`}
          </span>
        )}
      </Field>

      <div className="border-t border-border-subtle pt-3">
        <div className={labelCls}>Develop cache</div>
      </div>
      <Field
        label="Cache decoded RAW previews"
        hint="Re-opening a photo in Develop loads in ~50ms instead of re-decoding (3–8s). Cache all decodes the whole catalog on open; As needed only caches photos as you open them; Off never caches."
      >
        <OptionRow
          value={cacheMode}
          options={[
            { value: "eager", label: "Cache all" },
            { value: "ondemand", label: "As needed" },
            { value: "off", label: "Off" },
          ]}
          onChange={(v) => {
            if (v === "off") updateSettings({ rawCacheEnabled: false });
            else
              updateSettings({
                rawCacheEnabled: true,
                rawCachePrefetch: v === "eager",
              });
          }}
        />
      </Field>
      <Field
        label="Cached preview resolution"
        hint="Long-edge cap of cached previews. Live edits always render full resolution."
      >
        <OptionRow
          value={s.rawCacheMaxEdge}
          options={[
            { value: 2048, label: "2048 px" },
            { value: 3072, label: "3072 px" },
            { value: 4096, label: "4096 px" },
          ]}
          onChange={(v) =>
            updateSettings({ rawCacheMaxEdge: v as 2048 | 3072 | 4096 })
          }
        />
      </Field>
      <Field
        label="Cache storage"
        hint="Cache all photos in the open project now, or clear the cache to reclaim disk space."
      >
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCacheAll}
            disabled={cachingAll || !s.rawCacheEnabled}
            className={btnCls}
          >
            {cachingAll ? "Caching…" : "Cache all now"}
          </button>
          <button
            onClick={() => {
              setCleared(false);
              void clearRawCache().then(() => setCleared(true));
            }}
            className={btnCls}
          >
            Clear preview cache
          </button>
        </div>
        {cacheAll !== null && (
          <span className="ml-2 text-[10px] text-text-muted">
            {cachingAll
              ? `${cacheAll.done} / ${cacheAll.total}`
              : cacheAll.total === 0
                ? "Already cached."
                : `Cached ${cacheAll.total}.`}
          </span>
        )}
        {cleared && (
          <span className="ml-2 text-[10px] text-text-muted">Cleared.</span>
        )}
      </Field>

      {isNativeFS() && (
        <>
          <div className="border-t border-border-subtle pt-3">
            <div className={labelCls}>Catalog storage</div>
          </div>
          <Field
            label="Catalog location"
            hint="Where each project's working data (catalog, previews, cache) lives. In photo folder keeps it beside the photos; a read-only source like a memory card falls back to the separate location automatically. Separate folder always stores it there — keeps photo folders clean and is handy on a fast SSD."
          >
            <OptionRow
              value={s.catalogLocation}
              options={[
                { value: "in-folder", label: "In photo folder" },
                { value: "external", label: "Separate folder" },
              ]}
              onChange={(v) =>
                updateSettings({ catalogLocation: v as "in-folder" | "external" })
              }
            />
          </Field>
          <Field
            label="Separate catalog location"
            hint="Where Separate folder catalogs — and the automatic fallback for read-only sources — are stored. Each source folder gets its own subfolder, keyed by path so it's stable across opens. Default: the app's data directory."
          >
            <div className="flex items-center gap-1.5">
              <span
                className="min-w-0 flex-1 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary"
                title={s.externalCatalogDir || undefined}
              >
                {s.externalCatalogDir || "App data folder (default)"}
              </span>
              <button
                onClick={() => {
                  void nativeFs()
                    ?.pickDirectory()
                    .then((dir) => {
                      if (dir) updateSettings({ externalCatalogDir: dir });
                    });
                }}
                className={btnCls}
              >
                Choose folder…
              </button>
              {s.externalCatalogDir && (
                <button
                  onClick={() => updateSettings({ externalCatalogDir: "" })}
                  className={btnCls}
                >
                  Use default
                </button>
              )}
            </div>
          </Field>
          <StoredCatalogsField />
        </>
      )}
    </div>
  );
}

/** Human-readable byte size (1 KB = 1024 B). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Lists the "separate" catalogs Safelight keeps outside photo folders (read-only
 *  sources + Separate-folder projects) so the user can see what's on disk and
 *  reclaim space. Deleting one drops that project's edits/ratings/cache — the
 *  photos are never touched — so it's behind a per-row confirm. Renders nothing on
 *  builds whose bridge predates listExternalCatalogs. */
const STORED_CATALOGS_HINT =
  "Catalogs kept outside photo folders — for read-only sources and Separate-folder projects. Deleting one removes that project's saved edits, ratings, previews and cache; the photos themselves are untouched.";

function StoredCatalogsField() {
  const s = useSettings();
  const fs = nativeFs();
  const visible = useFieldVisible("Stored catalogs", STORED_CATALOGS_HINT);
  const [items, setItems] = useState<ExternalCatalogEntry[] | null>(null);
  const [confirmPath, setConfirmPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => () => void (mountedRef.current = false), []);

  useEffect(() => {
    // Skip the (potentially gigabytes-wide) recursive disk walk unless the field
    // is both supported and actually on screen — preferences search mounts the
    // whole Previews section even when this field is filtered out of the results.
    if (!visible || !fs?.listExternalCatalogs) return;
    let cancelled = false;
    setItems(null);
    void (async () => {
      // Catalogs can sit under the app-data default and/or the chosen base; query
      // both and dedupe by path so a freshly-changed base still shows old ones.
      const bases = Array.from(new Set(["", s.externalCatalogDir.trim()]));
      const lists = await Promise.all(
        bases.map((b) => fs.listExternalCatalogs!(b || null).catch(() => [])),
      );
      if (cancelled) return;
      const byPath = new Map<string, ExternalCatalogEntry>();
      for (const list of lists) for (const it of list) byPath.set(it.path, it);
      setItems([...byPath.values()].sort((a, b) => b.bytes - a.bytes));
    })();
    return () => {
      cancelled = true;
    };
  }, [fs, s.externalCatalogDir, visible]);

  if (!visible || !fs?.listExternalCatalogs) return null;

  const del = async (it: ExternalCatalogEntry) => {
    setBusy(true);
    try {
      await fs.remove(it.path);
      // Also drop its spillover pointer so no stale breadcrumb lingers (best-effort;
      // a leftover pointer is harmless — the marker re-check makes it a no-op).
      if (it.sourcePath && fs.clearSpilloverPointer)
        await fs.clearSpilloverPointer(it.sourcePath).catch(() => {});
      // Drop the row locally instead of re-walking every remaining catalog.
      if (mountedRef.current)
        setItems((prev) => prev?.filter((e) => e.path !== it.path) ?? prev);
    } finally {
      if (mountedRef.current) {
        setBusy(false);
        setConfirmPath(null);
      }
    }
  };

  return (
    <Field label="Stored catalogs" hint={STORED_CATALOGS_HINT}>
      <div className="flex flex-col gap-1">
        {items === null ? (
          <span className="text-[10px] text-text-muted">Scanning…</span>
        ) : items.length === 0 ? (
          <span className="text-[10px] text-text-muted">None stored yet.</span>
        ) : (
          items.map((it) => (
            <div
              key={it.path}
              className="flex items-center gap-1.5 rounded bg-surface-2 px-2 py-1"
            >
              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[11px] text-text-secondary"
                  title={it.sourcePath ?? it.path}
                >
                  {it.sourcePath ?? it.name}
                </div>
                <div className="text-[10px] text-text-muted">
                  {formatBytes(it.bytes)}
                  {it.sourcePath ? "" : " · source unknown"}
                </div>
              </div>
              <button className={btnCls} onClick={() => void fs.reveal(it.path)}>
                Reveal
              </button>
              {confirmPath === it.path ? (
                <>
                  <button
                    className={btnCls}
                    disabled={busy}
                    onClick={() => void del(it)}
                  >
                    {busy ? "Deleting…" : "Confirm delete"}
                  </button>
                  <button className={btnCls} onClick={() => setConfirmPath(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className={btnCls} onClick={() => setConfirmPath(it.path)}>
                  Delete
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </Field>
  );
}

function PerformanceSection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Develop render resolution"
        hint="Cap of the Develop render buffer. Higher keeps 100% zoom true 1:1 on large sensors but uses more GPU memory. Applies when a photo is reopened."
      >
        <OptionRow
          value={s.developMaxEdge}
          options={[
            { value: 4096, label: "4096 px" },
            { value: 6144, label: "6144 px" },
            { value: 8192, label: "8192 px" },
          ]}
          onChange={(v) =>
            updateSettings({ developMaxEdge: v as 4096 | 6144 | 8192 })
          }
        />
      </Field>
      <Field
        label="Open photos at"
        hint="Zoom a photo opens at in Develop. Fit shows the whole frame; 100% opens at 1:1 (pixel-accurate)."
      >
        <OptionRow
          value={s.developOpenZoom}
          options={[
            { value: "fit", label: "Fit" },
            { value: "100", label: "100%" },
          ]}
          onChange={(v) =>
            updateSettings({ developOpenZoom: v as "fit" | "100" })
          }
        />
      </Field>
      <Field
        label="GPU source cache"
        hint="GPU memory budget for resident decoded RAW sources. Larger keeps more photos ready for instant re-open and crisp zoom; least-recently-used sources are evicted past the budget."
      >
        <OptionRow
          value={s.gpuSourceCacheBytes}
          options={[
            { value: 256 * 1024 * 1024, label: "256 MB" },
            { value: 512 * 1024 * 1024, label: "512 MB" },
            { value: 1024 * 1024 * 1024, label: "1 GB" },
            { value: 2048 * 1024 * 1024, label: "2 GB" },
          ]}
          onChange={(v) => updateSettings({ gpuSourceCacheBytes: v })}
        />
      </Field>
      <ToggleField
        label="Prefetch neighbours"
        hint="While editing a photo, background-decode the previous/next photo so stepping to it is instant. Off saves CPU/VRAM at the cost of a short decode on each step."
        checked={s.developPrefetchNeighbors}
        onChange={(v) => updateSettings({ developPrefetchNeighbors: v })}
      />
      <ToggleField
        label="High bit-depth previews"
        hint="16-bit GPU textures for cached previews (smoother gradients). Turn off to halve texture memory. Applies when Develop is reopened."
        checked={s.highBitDepth}
        onChange={(v) => updateSettings({ highBitDepth: v })}
      />
      <ToggleField
        label="Live histogram"
        hint="Update the histogram on every frame while dragging sliders. Off recomputes it after edits settle — slightly smoother on slow machines."
        checked={s.liveHistogram}
        onChange={(v) => updateSettings({ liveHistogram: v })}
      />
    </div>
  );
}

function ExportSection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <Field label="Default format">
        <OptionRow
          value={s.exportFormat}
          options={[
            { value: "image/jpeg", label: "JPEG" },
            { value: "image/png", label: "PNG" },
            { value: "image/webp", label: "WebP" },
            { value: "image/tiff", label: "TIFF" },
          ]}
          onChange={(v) =>
            updateSettings({
              exportFormat: v as typeof s.exportFormat,
            })
          }
        />
      </Field>
      {s.exportFormat === "image/tiff" && (
        <Field
          label="TIFF bit depth"
          hint="16-bit preserves the full editing precision (best for further work or print); 8-bit is smaller and universally compatible."
        >
          <OptionRow
            value={s.exportTiffBitDepth}
            options={[
              { value: 8, label: "8-bit" },
              { value: 16, label: "16-bit" },
            ]}
            onChange={(v) =>
              updateSettings({ exportTiffBitDepth: v as 8 | 16 })
            }
          />
        </Field>
      )}
      <SliderField
        label="Default quality"
        value={s.exportQuality}
        min={10}
        max={100}
        step={1}
        format={(v) => String(v)}
        onChange={(v) => updateSettings({ exportQuality: v })}
      />
      <Field label="Default resolution">
        <OptionRow
          value={s.exportLongEdge ?? 0}
          options={[
            { value: 0, label: "Original" },
            { value: 4096, label: "4096 px" },
            { value: 2048, label: "2048 px" },
            { value: 1024, label: "1024 px" },
          ]}
          onChange={(v) =>
            updateSettings({ exportLongEdge: v === 0 ? null : (v as number) })
          }
        />
      </Field>
      <Field
        label="Color space"
        hint="Output profile. Pixels are converted and the matching ICC profile is embedded so other apps read the colors correctly. sRGB suits the web; Adobe RGB / ProPhoto keep a wider gamut for print."
      >
        <Select
          value={s.exportColorSpace}
          onChange={(v) =>
            updateSettings({ exportColorSpace: v as typeof s.exportColorSpace })
          }
          ariaLabel="Color space"
          className="w-full"
          options={COLOR_SPACES.map((c) => ({ value: c.value, label: c.label }))}
        />
      </Field>
      <ToggleField
        label="Bundle multiple photos as ZIP"
        checked={s.exportBundle}
        onChange={(v) => updateSettings({ exportBundle: v })}
      />
      <p className="text-[10px] leading-relaxed text-text-muted">
        These set the Export panel's starting values; you can still change them
        per export.
      </p>
    </div>
  );
}

const PRETTY_KEYS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  " ": "Space",
};
const prettyCombo = (combo: string) =>
  combo
    .split("+")
    .map((p) => PRETTY_KEYS[p] ?? p)
    .join("+");

const CATEGORIES: ActionCategory[] = ["General", "Develop", "Library"];

function ShortcutsSection() {
  const singleKeys = useSettings((s) => s.singleKeyShortcuts);
  const overrides = useKeybindings((s) => s.overrides);
  const extActionsMap = useExtensionActions((s) => s.actions);
  const extActions = Array.from(extActionsMap.values());
  const [capturing, setCapturing] = useState<string | null>(null);

  // While capturing, the global handlers stand down (they also listen in the
  // capture phase) and the next keydown is recorded. Esc cancels.
  useEffect(() => {
    if (!capturing) return;
    setShortcutsSuspended(true);
    const h = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // bare modifier — keep waiting
      setBinding(capturing, combo);
      setCapturing(null);
    };
    window.addEventListener("keydown", h, true);
    return () => {
      setShortcutsSuspended(false);
      window.removeEventListener("keydown", h, true);
    };
  }, [capturing]);

  const conflicts = findConflicts(overrides);

  // When the Preferences search is active, show only the bindings whose label
  // matches — otherwise the whole key list buries the one you searched for. The
  // explanatory text and reset button are chrome, so they hide while searching.
  const filterQ = useContext(PrefSearchContext);
  const matches = (label: string) => !filterQ || label.toLowerCase().includes(filterQ);

  // One editable binding row, shared by the built-in categories and extensions.
  const bindingRow = (a: { id: string; label: string; def: string }) => {
    const combo = overrides[a.id] ?? a.def;
    const overridden = a.id in overrides;
    const conflict = conflicts.has(a.id);
    return (
      <tr key={a.id} className="border-b border-border-subtle">
        <td className="py-1 pr-3 text-text-secondary">{a.label}</td>
        <td className="w-28 py-1 text-right">
          <button
            onClick={() => setCapturing(capturing === a.id ? null : a.id)}
            title={conflict ? "Conflicts with another shortcut" : undefined}
            className={`rounded px-2 py-0.5 font-medium ${
              capturing === a.id
                ? "bg-slider-fill text-white"
                : conflict
                  ? "bg-surface-2 text-red-400"
                  : "bg-surface-2 text-text-primary hover:bg-surface-3"
            }`}
          >
            {capturing === a.id ? "Press keys…" : prettyCombo(combo)}
          </button>
        </td>
        <td className="w-6 py-1 text-right">
          {overridden && (
            <button
              onClick={() => resetBinding(a.id)}
              title={`Reset to ${prettyCombo(a.def)}`}
              className="rounded px-1 text-text-muted hover:text-text-primary"
            >
              ↺
            </button>
          )}
        </td>
      </tr>
    );
  };

  const extVisible = extActions.filter((a) => matches(a.label));
  const fixedVisible = VIEWPORT_FIXED.filter(([, label]) => matches(label));

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Single-key shortcuts"
        hint="Disable if bare-letter shortcuts (G/D/F) conflict with other tools. Combinations with modifiers always work."
        checked={singleKeys}
        onChange={(v) => updateSettings({ singleKeyShortcuts: v })}
      />
      {!filterQ && (
        <p className="text-[10px] leading-relaxed text-text-muted">
          Click a shortcut, then press the new keys. Esc cancels. Develop and
          Library shortcuts may share keys — they're active in different modules.
        </p>
      )}
      {CATEGORIES.map((cat) => {
        const acts = KEY_ACTIONS.filter(
          (a) => a.category === cat && matches(a.label),
        );
        if (acts.length === 0) return null;
        return (
          <div key={cat}>
            <div className={labelCls}>{cat}</div>
            <table className="mt-1 w-full text-[11px]">
              <tbody>{acts.map(bindingRow)}</tbody>
            </table>
          </div>
        );
      })}
      {extVisible.length > 0 && (
        <div>
          <div className={labelCls}>Extensions</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>{extVisible.map(bindingRow)}</tbody>
          </table>
        </div>
      )}
      {fixedVisible.length > 0 && (
        <div>
          <div className={labelCls}>Viewport (fixed)</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>
              {fixedVisible.map(([combo, label]) => (
                <tr key={combo} className="border-b border-border-subtle">
                  <td className="py-1 pr-3 text-text-secondary">{label}</td>
                  <td className="w-28 py-1 text-right">
                    <span className="rounded bg-surface-2 px-2 py-0.5 font-medium text-text-muted">
                      {combo}
                    </span>
                  </td>
                  <td className="w-6" />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!filterQ && (
        <div>
          <button onClick={resetAllBindings} className={btnCls}>
            Reset all shortcuts
          </button>
        </div>
      )}
    </div>
  );
}

function ExtensionsSection() {
  const topic = useSettings((s) => s.extensionTopic);
  const checkExtensionUpdates = useSettings((s) => s.checkExtensionUpdates);
  const autoUpdateExtensions = useSettings((s) => s.autoUpdateExtensions);
  const onlyVerifiedExtensions = useSettings((s) => s.onlyVerifiedExtensions);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Official extension topic"
        hint="GitHub topic used to discover extensions in the Extensions window."
      >
        <input
          value={topic}
          onChange={(e) => updateSettings({ extensionTopic: e.target.value })}
          onBlur={(e) => {
            if (!e.target.value.trim())
              updateSettings({
                extensionTopic: DEFAULT_SETTINGS.extensionTopic,
              });
          }}
          spellCheck={false}
          className={inputCls}
        />
      </Field>
      <ToggleField
        label="Check extensions for updates"
        hint="On launch, compare installed extensions against the latest GitHub release and flag any with an update available."
        checked={checkExtensionUpdates}
        onChange={(v) => updateSettings({ checkExtensionUpdates: v })}
      />
      <ToggleField
        label="Auto-update extensions"
        hint="Silently install extension updates in the background when found. Off by default — updates are flagged for you to apply manually."
        checked={autoUpdateExtensions}
        onChange={(v) => updateSettings({ autoUpdateExtensions: v })}
      />
      <ToggleField
        label="Only verified extensions"
        hint="Block installing any extension that isn't on Safelight's verified allowlist. Banned extensions are always blocked regardless of this setting."
        checked={onlyVerifiedExtensions}
        onChange={(v) => updateSettings({ onlyVerifiedExtensions: v })}
      />
      <Field label="Manage">
        <button
          onClick={() => {
            closePreferences();
            openExtensions();
          }}
          className={btnCls}
        >
          Open Extensions…
        </button>
      </Field>
    </div>
  );
}

function DownloadButton({ tag }: { tag: string }) {
  const [state, setState] = useState<"idle" | "downloading" | "error">("idle");
  const [errMsg, setErrMsg] = useState("");

  if (state === "downloading") {
    return <span className="shrink-0 text-[10px] text-text-muted">Downloading…</span>;
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-0.5">
      <button
        onClick={() => {
          setState("downloading");
          setErrMsg("");
          installVersion(tag).catch((e: unknown) => {
            setState("error");
            setErrMsg(e instanceof Error ? e.message : String(e));
          });
        }}
        className="rounded bg-slider-fill px-2 py-0.5 text-[10px] font-medium text-white hover:opacity-90"
      >
        Download
      </button>
      {state === "error" && (
        <span className="max-w-[180px] truncate text-[9px] text-red-400" title={errMsg}>
          {errMsg}
        </span>
      )}
    </div>
  );
}

function CheckResultBadge({
  result,
  onDismiss,
}: {
  result: CheckResult;
  onDismiss: () => void;
}) {
  switch (result.kind) {
    case "network-error":
      return (
        <p className="text-[10px] text-red-400">
          Could not reach GitHub. Check your internet connection.
        </p>
      );
    case "parse-error":
      return (
        <p className="text-[10px] text-red-400">
          GitHub responded with unexpected data. The API may be down.
        </p>
      );
    case "no-releases":
      return (
        <p className="text-[10px] text-text-muted">
          No published releases found for this channel.
        </p>
      );
    case "current-version-unknown":
      return (
        <p className="text-[10px] text-red-400">
          Could not read the running version (got: “{result.rawVersion}”). Try
          rebuilding the app.
        </p>
      );
    case "up-to-date":
      return (
        <p className="text-[10px] text-text-muted">
          v{result.currentVersion} is the latest release.
        </p>
      );
    case "update-available":
      return (
        <div className="flex items-center gap-2 rounded border border-border bg-surface-2 px-3 py-2 text-[11px]">
          <span className="font-medium text-text-primary">
            v{result.info.version} is available
            <span className="ml-1 font-normal text-text-muted">
              (you have v{result.currentVersion})
            </span>
          </span>
          <button
            onClick={() => openUrl(result.info.releasesUrl)}
            className="rounded border border-border px-2 py-0.5 text-[10px] text-text-primary hover:bg-surface-3"
          >
            View release
          </button>
          <DownloadButton tag={result.info.tag} />
          <button
            onClick={() => {
              dismissVersion(result.info.version);
              onDismiss();
            }}
            className="ml-auto text-text-muted hover:text-text-primary"
            title="Dismiss for this version"
          >
            ×
          </button>
        </div>
      );
  }
}

function UpdatesSection() {
  const checkForUpdates = useSettings((s) => s.checkForUpdates);
  const channel = useSettings((s) => s.updateChannel);
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [releases, setReleases] = useState<ReleaseEntry[] | null>(null);
  const [loadingReleases, setLoadingReleases] = useState(false);
  const [releasesError, setReleasesError] = useState(false);

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    const r = await checkForUpdateNow(__APP_VERSION__, channel);
    setResult(r);
    setChecking(false);
  };

  const loadReleases = async () => {
    setLoadingReleases(true);
    setReleasesError(false);
    const r = await fetchAllReleases();
    if (r === null) setReleasesError(true);
    else setReleases(r);
    setLoadingReleases(false);
  };

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Check for updates on startup"
        hint="Silently checks the GitHub releases API once on launch and shows a banner if a newer version is available. No data is sent."
        checked={checkForUpdates}
        onChange={(v) => updateSettings({ checkForUpdates: v })}
      />

      <Field
        label="Update channel"
        hint="Stable only notifies on full releases. All releases also includes pre-releases (betas)."
      >
        <OptionRow<UpdateChannel>
          value={channel}
          options={[
            { value: "all", label: "All releases" },
            { value: "stable", label: "Stable only" },
          ]}
          onChange={(v) => updateSettings({ updateChannel: v })}
        />
      </Field>

      <div className="border-t border-border-subtle pt-3" />

      <Field label="Manual check">
        <button
          onClick={() => void checkNow()}
          disabled={checking}
          className={btnCls}
        >
          {checking ? "Checking…" : "Check now"}
        </button>
        {result && (
          <div className="mt-2">
            <CheckResultBadge result={result} onDismiss={() => setResult(null)} />
          </div>
        )}
      </Field>

      <div className="border-t border-border-subtle pt-3" />

      <Field label="Release history">
        {releases === null && !loadingReleases && (
          <button
            onClick={() => void loadReleases()}
            className={btnCls}
          >
            Load releases
          </button>
        )}
        {loadingReleases && (
          <span className="text-[10px] text-text-muted">Loading…</span>
        )}
        {releasesError && (
          <span className="text-[10px] text-red-400">Could not load releases. Check your connection.</span>
        )}
        {releases && releases.length > 0 && (
          <div className="mt-1 flex flex-col gap-1">
            {releases.map((r) => (
              <div
                key={r.version}
                className="flex items-center gap-2 rounded border border-border-subtle bg-surface-2 px-3 py-1.5 text-[11px]"
              >
                <span className="font-medium text-text-primary tabular-nums">
                  v{r.version}
                </span>
                {r.prerelease && (
                  <span className="shrink-0 rounded border border-border-subtle px-1.5 py-px text-[9px] uppercase tracking-wide text-text-muted">
                    Pre-release
                  </span>
                )}
                {r.body && (
                  <span className="flex-1 truncate text-text-muted" title={r.body}>
                    {r.body.split("\n")[0].replace(/^[#\s*-]+/, "").trim()}
                  </span>
                )}
                <button
                  onClick={() => openUrl(r.releasesUrl)}
                  className="ml-auto shrink-0 rounded border border-border px-2 py-0.5 text-[10px] text-text-primary hover:bg-surface-3"
                >
                  View release
                </button>
                <DownloadButton tag={r.tag} />
              </div>
            ))}
          </div>
        )}
      </Field>

      <p className="text-[10px] leading-relaxed text-text-muted">
        Uses the public GitHub Releases API. Safelight does not auto-download or
        auto-install updates.
      </p>
    </div>
  );
}

function AboutSection() {
  const native = window.safelightNative;
  const repo = "https://github.com/anthonyreimche/SafeLight";
  const rows: { label: string; value: string }[] = [
    { label: "Version", value: `v${__APP_VERSION__}` },
    ...(native
      ? [
          { label: "Electron", value: native.versions.electron },
          { label: "Chromium", value: native.versions.chrome },
          { label: "Platform", value: native.platform },
        ]
      : [{ label: "Environment", value: "Browser (dev)" }]),
  ];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <div className="text-[15px] font-semibold tracking-wide text-text-primary">
          Safelight
        </div>
        <p className="mt-0.5 text-[11px] text-text-secondary">
          A fast RAW photo editor.
        </p>
        <p className="mt-1.5 text-[11px] text-text-primary">
          Safelight — founded and principally authored by Anthony Reimche
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-text-secondary">
          Free software under the GNU GPL v3 (with a §7(b) attribution term).
          Includes third-party components under their own licenses. Product
          names and trademarks are the property of their respective owners.
        </p>
      </div>

      <table className="w-full text-[11px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border-subtle">
              <td className="py-1 pr-3 text-text-muted">{r.label}</td>
              <td className="py-1 text-right font-medium text-text-primary tabular-nums">
                {r.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <Field label="Project">
        <a
          href={repo}
          target="_blank"
          rel="noreferrer"
          className="text-[11px] text-slider-fill hover:underline"
        >
          {repo.replace("https://", "")}
        </a>
      </Field>

      <Field label="Legal">
        <div className="flex flex-col gap-0.5">
          {[
            ["License (GNU GPL v3)", "LICENSE"],
            ["Third-party notices", "THIRD-PARTY-NOTICES.md"],
            ["Privacy", "PRIVACY.md"],
            ["Trademarks", "TRADEMARKS.md"],
          ].map(([label, file]) => (
            <a
              key={file}
              href={`${repo}/blob/main/${file}`}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-slider-fill hover:underline"
            >
              {label}
            </a>
          ))}
        </div>
      </Field>

      <p className="text-[10px] leading-relaxed text-text-muted">
        © {new Date().getFullYear()} Anthony Reimche. Licensed under the GNU
        GPL v3 with an attribution-preservation term (§7b) — free to use,
        modify and redistribute; the founding-author credit above must be kept.
        See the LICENSE file for details.
      </p>
    </div>
  );
}

// ─── Small controls ──────────────────────────────────────────────────────────

const labelCls =
  "text-[10px] uppercase tracking-widest text-text-muted";
const inputCls =
  "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3";
const btnCls =
  "rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  if (!useFieldVisible(label, hint)) return null;
  return (
    <div>
      <div className={labelCls}>{label}</div>
      <div className="mt-1.5">{children}</div>
      {hint && (
        <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function ToggleField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  if (!useFieldVisible(label, hint)) return null;
  return (
    <div>
      <button
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">{label}</span>
        <span
          aria-hidden="true"
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            checked ? "bg-slider-fill" : "bg-surface-3"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
              checked ? "left-3.5" : "left-0.5"
            }`}
          />
        </span>
      </button>
      {hint && (
        <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

export function SliderField({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
}) {
  if (!useFieldVisible(label)) return null;
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className={labelCls}>{label}</span>
        <span className="text-[11px] text-text-primary">{format(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="sl-slider mt-2 w-full"
        style={{
          background: `linear-gradient(to right, var(--color-slider-fill) ${pct}%, var(--color-surface-3) ${pct}%)`,
        }}
      />
    </div>
  );
}

export function OptionRow<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          onClick={() => onChange(o.value)}
          aria-pressed={o.value === value}
          className={`rounded px-2 py-1 text-[11px] ${
            o.value === value
              ? "bg-slider-fill text-white"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
