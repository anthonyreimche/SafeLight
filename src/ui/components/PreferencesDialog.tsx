// Application-wide Preferences pop-up (Ctrl/Cmd+, or the ⚙ button in the top
// bar). Left rail of sections, controls on the right. Everything writes to the
// persisted settings store immediately — there is no OK/Apply; close when done.
// Theme and layout drive their own stores (themes.ts / dock.ts) directly.

import { useEffect, useState } from "react";
import { create } from "zustand";
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
import {
  applyPipeline,
  DEFAULT_PIPELINE,
  usePipelineStore,
} from "@/extensions/pipelines";
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
  "Rendering",
  "Performance",
  "Export",
  "Shortcuts",
  "Extensions",
  "About",
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
            {section === "Rendering" && <RenderingSection />}
            {section === "Performance" && <PerformanceSection />}
            {section === "Export" && <ExportSection />}
            {section === "Shortcuts" && <ShortcutsSection />}
            {section === "Extensions" && <ExtensionsSection />}
            {section === "About" && <AboutSection />}
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

      <div className="border-t border-border-subtle pt-3">
        <div className={labelCls}>Render pipeline</div>
      </div>
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
        <button onClick={resetAllBindings} className={btnCls}>
          Reset all shortcuts
        </button>
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
        © {new Date().getFullYear()} Anthony Reimche. MIT licensed.
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
