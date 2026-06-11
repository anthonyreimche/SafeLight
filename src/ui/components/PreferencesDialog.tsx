// Application-wide Preferences pop-up (Ctrl/Cmd+, or the ⚙ button in the top
// bar). Left rail of sections, controls on the right. Everything writes to the
// persisted settings store immediately — there is no OK/Apply; close when done.
// Theme and layout drive their own stores (themes.ts / dock.ts) directly.

import { useState } from "react";
import { create } from "zustand";
import { useRegistry } from "@/extensions/registry";
import { applyTheme, useThemeStore } from "@/extensions/themes";
import {
  applyDockLayout,
  CUSTOM_LAYOUT,
  toggleDockPanel,
  useLayoutStore,
} from "@/extensions/dock";
import {
  DEFAULT_SETTINGS,
  resetSettings,
  updateSettings,
  useSettings,
} from "@/state/settings-store";
import { useUIStore } from "@/state/ui-store";
import { clearRawCache } from "@/raw/raw-cache";
import type { SortDirection, SortField } from "@/catalog/types";

// ─── Open/close state (exported so the keyboard hook and TopBar can drive it) ─

const useOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openPreferences = () => useOpen.setState({ open: true });
export const closePreferences = () => useOpen.setState({ open: false });
export const togglePreferences = () =>
  useOpen.setState((s) => ({ open: !s.open }));

// ─── Sections ────────────────────────────────────────────────────────────────

const SECTIONS = [
  "Interface",
  "Library",
  "Performance",
  "Export",
  "Shortcuts",
  "Extensions",
] as const;
type Section = (typeof SECTIONS)[number];

const SORT_FIELDS: { value: SortField; label: string }[] = [
  { value: "dateImported", label: "Date imported" },
  { value: "dateCreated", label: "Date created" },
  { value: "filename", label: "Filename" },
  { value: "rating", label: "Rating" },
];

export function PreferencesDialog() {
  const open = useOpen((s) => s.open);
  const [section, setSection] = useState<Section>("Interface");
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) closePreferences();
      }}
    >
      <div className="flex h-[480px] w-[640px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-3">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
            Preferences
          </span>
          <button
            onClick={closePreferences}
            className="rounded px-1.5 text-[14px] leading-none text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="w-36 shrink-0 border-r border-border bg-surface-0/40 py-2">
            {SECTIONS.map((s) => (
              <button
                key={s}
                onClick={() => setSection(s)}
                className={`block w-full px-3 py-1.5 text-left text-[11px] tracking-wider ${
                  section === s
                    ? "bg-surface-3 text-text-primary"
                    : "text-text-secondary hover:text-text-primary"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {section === "Interface" && <InterfaceSection />}
            {section === "Library" && <LibrarySection />}
            {section === "Performance" && <PerformanceSection />}
            {section === "Export" && <ExportSection />}
            {section === "Shortcuts" && <ShortcutsSection />}
            {section === "Extensions" && <ExtensionsSection />}
          </div>
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
    </div>
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
    </div>
  );
}

function PerformanceSection() {
  const s = useSettings();
  const [cleared, setCleared] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Cache decoded RAW previews"
        hint="Re-opening a photo in Develop loads in ~50ms instead of re-decoding (3–8s). Stored in the project folder or the browser."
        checked={s.rawCacheEnabled}
        onChange={(v) => updateSettings({ rawCacheEnabled: v })}
      />
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
      <Field label="Cache storage">
        <button
          onClick={() => {
            setCleared(false);
            void clearRawCache().then(() => setCleared(true));
          }}
          className={btnCls}
        >
          Clear preview cache
        </button>
        {cleared && (
          <span className="ml-2 text-[10px] text-text-muted">Cleared.</span>
        )}
      </Field>
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

function ShortcutsSection() {
  const singleKeys = useSettings((s) => s.singleKeyShortcuts);
  const rows: [string, string][] = [
    ["G", "Library module"],
    ["D", "Develop module"],
    ["F", "Fullscreen"],
    ["Tab", "Hide / show all panels"],
    ["[ / ]", "Shrink / grow brush"],
    ["Ctrl+,", "Preferences"],
  ];
  return (
    <div className="flex flex-col gap-4">
      <ToggleField
        label="Single-key shortcuts"
        hint="Disable if G/D/F conflict with other tools. Tab and Ctrl-combinations always work."
        checked={singleKeys}
        onChange={(v) => updateSettings({ singleKeyShortcuts: v })}
      />
      <div>
        <div className={labelCls}>Reference</div>
        <table className="mt-1 w-full text-[11px]">
          <tbody>
            {rows.map(([k, what]) => (
              <tr key={k} className="border-b border-border-subtle">
                <td className="py-1 pr-3 font-medium text-text-primary">{k}</td>
                <td className="py-1 text-text-secondary">{what}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExtensionsSection() {
  const topic = useSettings((s) => s.extensionTopic);
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Official extension topic"
        hint="GitHub topic used to discover extensions in the Extensions panel."
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
      <Field label="Manage">
        <button
          onClick={() => {
            closePreferences();
            toggleDockPanel("core.extensions");
          }}
          className={btnCls}
        >
          Open Extensions panel
        </button>
      </Field>
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
            checked ? "bg-accent" : "bg-surface-3"
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
              ? "bg-accent text-white"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
