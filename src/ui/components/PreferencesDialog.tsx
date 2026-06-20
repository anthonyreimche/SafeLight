// Application-wide Preferences pop-up (Ctrl/Cmd+, or the ⚙ button in the top
// bar). Left rail of sections, controls on the right. Everything writes to the
// persisted settings store immediately — there is no OK/Apply; close when done.
// Theme and layout drive their own stores (themes.ts / dock.ts) directly.

import { useEffect, useMemo, useRef, useState } from "react";
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
import { applyTheme, useThemeStore } from "@/extensions/themes";
import {
  applyDockLayout,
  CUSTOM_LAYOUT,
  useLayoutStore,
} from "@/extensions/dock";
import { openExtensions } from "./ExtensionsDialog";
import {
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
// registered settings, auto-rendered from its declarative fields). `keywords`
// feeds the header search — for core sections it lists their field labels so a
// search can find a setting without a full declarative rewrite.

type PrefGroup = "General" | "Extensions";

interface PrefSection {
  id: string;
  label: string;
  group: PrefGroup;
  keywords: string[];
  order?: number;
  render: (query: string) => React.ReactNode;
}

const CORE_SECTIONS: PrefSection[] = [
  {
    id: "Interface",
    label: "Interface",
    group: "General",
    keywords: [
      "Theme",
      "Panel layout",
      "Interface scale",
      "Reduce motion",
      "Interface font",
    ],
    render: () => <InterfaceSection />,
  },
  {
    id: "Library",
    label: "Library",
    group: "General",
    keywords: ["Default grid size", "Default sort", "Confirm before removing"],
    render: () => <LibrarySection />,
  },
  {
    id: "Previews",
    label: "Previews",
    group: "General",
    keywords: [
      "Preview source",
      "Embedded JPEG",
      "Thumbnail quality",
      "Store previews on disk",
      "Develop cache",
      "Cache all",
      "Cached preview resolution",
      "Clear preview cache",
      "Rebuild thumbnails",
    ],
    render: () => <PreviewsSection />,
  },
  {
    id: "Rendering",
    label: "Rendering",
    group: "General",
    keywords: ["Display transform", "tone map", "pipeline"],
    render: () => <RenderingSection />,
  },
  {
    id: "Performance",
    label: "Performance",
    group: "General",
    keywords: [
      "Develop render resolution",
      "Open photos at",
      "GPU source cache",
      "Prefetch neighbours",
      "High bit-depth previews",
      "Live histogram",
    ],
    render: () => <PerformanceSection />,
  },
  {
    id: "Export",
    label: "Export",
    group: "General",
    keywords: [
      "Default format",
      "Default quality",
      "Default resolution",
      "Color space",
      "Bundle multiple photos as ZIP",
    ],
    render: () => <ExportSection />,
  },
  {
    id: "Shortcuts",
    label: "Shortcuts",
    group: "General",
    keywords: ["Single-key shortcuts", "keybindings", "keyboard"],
    render: () => <ShortcutsSection />,
  },
  {
    id: "Extensions",
    label: "Extensions",
    group: "General",
    keywords: ["Official extension topic", "Manage", "plugins"],
    render: () => <ExtensionsSection />,
  },
  {
    id: "Updates",
    label: "Updates",
    group: "General",
    keywords: [
      "Check for updates on startup",
      "Update channel",
      "Manual check",
      "Release history",
    ],
    render: () => <UpdatesSection />,
  },
  {
    id: "About",
    label: "About",
    group: "General",
    keywords: ["Version", "Electron", "Chromium", "Platform", "Project", "license"],
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

export function PreferencesDialog() {
  const open = useOpen((s) => s.open);
  const target = useOpen((s) => s.target);
  const extSettings = useRegistry((s) => s.settings);
  const [sectionId, setSectionId] = useState<string>("Interface");
  const [query, setQuery] = useState("");

  // Latest query in a ref so the (capture-phase) escape handler can read it
  // without re-registering on every keystroke.
  const queryRef = useRef("");
  queryRef.current = query;

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
          keywords: c.fields.flatMap((f) => [f.label, f.hint ?? ""]),
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
    () =>
      sections.filter(
        (s) =>
          !q ||
          s.label.toLowerCase().includes(q) ||
          s.keywords.some((k) => k.toLowerCase().includes(q)),
      ),
    [sections, q],
  );

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
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closePreferences();
      }}
    >
      <div className="flex h-[480px] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
            Preferences
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search settings…"
            spellCheck={false}
            className="ml-auto w-44 rounded bg-surface-1 px-2 py-0.5 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
          />
          <button
            onClick={closePreferences}
            className="rounded px-1.5 text-[14px] leading-none text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-36 shrink-0 overflow-y-auto border-r border-border bg-surface-0/40 py-2">
            {visible.length === 0 && (
              <div className="px-3 py-1.5 text-[11px] text-text-muted">
                No matches
              </div>
            )}
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
          <div className="flex-1 overflow-y-auto p-4">{active?.render(q)}</div>
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
      </div>
    </div>
  );
}

// ─── Section bodies ──────────────────────────────────────────────────────────

function InterfaceSection() {
  const themes = useRegistry((s) => s.themes);
  const layouts = useRegistry((s) => s.layouts);
  const activeTheme = useThemeStore((s) => s.activeId);
  const activeLayout = useLayoutStore((s) => s.activeId);
  const uiScale = useSettings((s) => s.uiScale);
  const reduceMotion = useSettings((s) => s.reduceMotion);
  const restoreLastProject = useSettings((s) => s.restoreLastProject);

  return (
    <div className="flex flex-col gap-4">
      <Field label="Theme" hint="Themes from extensions appear here too.">
        <select
          value={activeTheme}
          onChange={(e) => applyTheme(e.target.value)}
          className={selectCls}
        >
          {Object.values(themes)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
        </select>
      </Field>
      <Field label="Panel layout">
        <select
          value={activeLayout}
          onChange={(e) => applyDockLayout(e.target.value)}
          className={selectCls}
        >
          <option value={CUSTOM_LAYOUT}>Custom (your arrangement)</option>
          {Object.values(layouts)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
        </select>
      </Field>
      <SliderField
        label="Interface scale"
        value={uiScale}
        min={0.8}
        max={1.3}
        step={0.05}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(v) => updateSettings({ uiScale: v })}
      />
      <ToggleField
        label="Reduce motion"
        hint="Minimize animated UI affordances."
        checked={reduceMotion}
        onChange={(v) => updateSettings({ reduceMotion: v })}
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
          <select
            value={s.defaultSortField}
            onChange={(e) =>
              updateSettings({ defaultSortField: e.target.value as SortField })
            }
            className={selectCls}
          >
            {SORT_FIELDS.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
          <select
            value={s.defaultSortDirection}
            onChange={(e) =>
              updateSettings({
                defaultSortDirection: e.target.value as SortDirection,
              })
            }
            className={selectCls}
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
        </div>
      </Field>
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
        <select
          value={active ? activeId : DEFAULT_PIPELINE}
          onChange={(e) => applyPipeline(e.target.value)}
          className={selectCls}
        >
          {Object.values(pipelines).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
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
    </div>
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
          ]}
          onChange={(v) =>
            updateSettings({
              exportFormat: v as typeof s.exportFormat,
            })
          }
        />
      </Field>
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
        <select
          value={s.exportColorSpace}
          onChange={(e) =>
            updateSettings({
              exportColorSpace: e.target.value as typeof s.exportColorSpace,
            })
          }
          className={selectCls}
        >
          {COLOR_SPACES.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
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

  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Single-key shortcuts"
        hint="Disable if bare-letter shortcuts (G/D/F) conflict with other tools. Combinations with modifiers always work."
        checked={singleKeys}
        onChange={(v) => updateSettings({ singleKeyShortcuts: v })}
      />
      <p className="text-[10px] leading-relaxed text-text-muted">
        Click a shortcut, then press the new keys. Esc cancels. Develop and
        Library shortcuts may share keys — they're active in different modules.
      </p>
      {CATEGORIES.map((cat) => (
        <div key={cat}>
          <div className={labelCls}>{cat}</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>
              {KEY_ACTIONS.filter((a) => a.category === cat).map((a) => {
                const combo = overrides[a.id] ?? a.def;
                const overridden = a.id in overrides;
                const conflict = conflicts.has(a.id);
                return (
                  <tr key={a.id} className="border-b border-border-subtle">
                    <td className="py-1 pr-3 text-text-secondary">{a.label}</td>
                    <td className="w-28 py-1 text-right">
                      <button
                        onClick={() =>
                          setCapturing(capturing === a.id ? null : a.id)
                        }
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
              })}
            </tbody>
          </table>
        </div>
      ))}
      {extActions.length > 0 && (
        <div>
          <div className={labelCls}>Extensions</div>
          <table className="mt-1 w-full text-[11px]">
            <tbody>
              {extActions.map((a) => {
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
              })}
            </tbody>
          </table>
        </div>
      )}
      <div>
        <div className={labelCls}>Viewport (fixed)</div>
        <table className="mt-1 w-full text-[11px]">
          <tbody>
            {[
              ["Esc", "Exit tool / close dialog"],
              ["Space", "Toggle zoom (fit ↔ 100%)"],
              ["Ctrl/⌘ + Click", "Zoom in/out while masking or healing"],
              ["Ctrl/⌘ + Drag", "Pan while zoomed"],
            ].map(([combo, label]) => (
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
      <div>
        <button onClick={resetAllBindings} className={btnCls}>
          Reset all shortcuts
        </button>
      </div>
    </div>
  );
}

function ExtensionsSection() {
  const topic = useSettings((s) => s.extensionTopic);
  const checkExtensionUpdates = useSettings((s) => s.checkExtensionUpdates);
  const autoUpdateExtensions = useSettings((s) => s.autoUpdateExtensions);
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
        hint="Stable only notifies on new minor/major releases (vX.Y). All releases includes patch/bug-fix releases (vX.Y.Z)."
      >
        <OptionRow<UpdateChannel>
          value={channel}
          options={[
            { value: "patch", label: "All releases" },
            { value: "minor", label: "Stable only" },
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

      <p className="text-[10px] leading-relaxed text-text-muted">
        © {new Date().getFullYear()} Anthony Reimche. GPL-3.0 licensed.
      </p>
    </div>
  );
}

// ─── Small controls ──────────────────────────────────────────────────────────

const labelCls =
  "text-[10px] uppercase tracking-widest text-text-muted";
const selectCls =
  "rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:bg-surface-3";
const inputCls =
  "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3";
const btnCls =
  "rounded bg-surface-3 px-2.5 py-1 text-[11px] text-text-secondary hover:bg-surface-4 hover:text-text-primary";

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
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

function ToggleField({
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
  return (
    <div>
      <button
        onClick={() => onChange(!checked)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">{label}</span>
        <span
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

function SliderField({
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

function OptionRow<T extends string | number>({
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
