// Export as a dock panel (View > Export from either module): format, quality,
// resolution and delivery settings plus the export action, in one column.

import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useCatalogStore } from "@/state/catalog-store";
import { useRegistry } from "@/extensions/registry";
import type { ExportProcessorField } from "@/extensions/types";
import {
  exportPhotos,
  type DeliveryMode,
  type ExportFormat,
  type ExportSettings,
  type ProcessorSettings,
} from "./export-image";
import {
  getSettings,
  useSettings,
  updateSettings,
  type ExportPreset,
} from "@/state/settings-store";

const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "image/jpeg", label: "JPEG" },
  { value: "image/png", label: "PNG" },
  { value: "image/webp", label: "WebP" },
];

const RESOLUTIONS: { value: number | null; label: string }[] = [
  { value: null, label: "Original" },
  { value: 4096, label: "4096 px" },
  { value: 2048, label: "2048 px" },
  { value: 1024, label: "1024 px" },
];

/** Renders one settings field for an export processor, styled to match the
 *  existing panel controls (toggles, sliders, text inputs, button-group selects). */
function ProcessorFieldRow({
  field,
  value,
  onChange,
}: {
  field: ExportProcessorField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const optBtn = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] ${
      active
        ? "bg-surface-3 text-text-primary"
        : "bg-surface-2 text-text-muted hover:text-text-primary"
    }`;

  if (field.type === "boolean") {
    const checked = typeof value === "boolean" ? value : field.default;
    return (
      <label className="flex items-center justify-between gap-2 text-[11px]">
        <span className="text-text-secondary">{field.label}</span>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          className="accent-slider-fill"
        />
      </label>
    );
  }

  if (field.type === "number") {
    const num = typeof value === "number" ? value : field.default;
    return (
      <Slider
        label={field.label}
        value={num}
        min={field.min ?? 0}
        max={field.max ?? 100}
        step={field.step}
        defaultValue={field.default}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (field.type === "string") {
    const str = typeof value === "string" ? value : field.default;
    return (
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-text-secondary">{field.label}</span>
        <input
          type="text"
          value={str}
          placeholder={field.placeholder}
          onChange={(e) => onChange(e.target.value)}
          className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:ring-1 focus:ring-slider-fill"
        />
      </label>
    );
  }

  if (field.type === "select") {
    const sel = typeof value === "string" ? value : field.default;
    return (
      <div className="flex flex-col gap-1">
        <span className="text-[11px] text-text-secondary">{field.label}</span>
        <div className="flex flex-wrap gap-1">
          {field.options.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange(opt.value)}
              className={optBtn(sel === opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return null;
}

export function ExportPanel() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);

  // Defaults come from Preferences > Export; the panel state is per-session.
  const [format, setFormat] = useState<ExportFormat>(getSettings().exportFormat);
  const [quality, setQuality] = useState(getSettings().exportQuality);
  const [longEdge, setLongEdge] = useState<number | null>(
    getSettings().exportLongEdge,
  );
  const [delivery, setDelivery] = useState<DeliveryMode>("folder");
  const [destDir, setDestDir] = useState<FileSystemDirectoryHandle | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [status, setStatus] = useState<string | null>(null);

  // Output sharpening state.
  const [sharpenAmount, setSharpenAmount] = useState(0);
  const [sharpenRadius, setSharpenRadius] = useState(1.0);

  // Presets from persistent settings.
  const presets = useSettings((s) => s.exportPresets);
  const [savingPreset, setSavingPreset] = useState(false);
  const [presetName, setPresetName] = useState("");

  // Extension export processors and filename templates from the registry.
  const rawProcessors = useRegistry((s) => s.exportProcessors);
  const rawTemplates = useRegistry((s) => s.filenameTemplates);
  const exportProcessors = useMemo(
    () => Object.values(rawProcessors).sort((a, b) => a.order - b.order),
    [rawProcessors],
  );
  const filenameTemplates = useMemo(
    () => Object.values(rawTemplates),
    [rawTemplates],
  );

  // Per-processor field values; keyed by processorId -> fieldKey -> value.
  const [processorSettings, setProcessorSettings] = useState<ProcessorSettings>({});
  // Active filename template id (undefined = built-in behaviour).
  const [filenameTemplateId, setFilenameTemplateId] = useState<string | undefined>();

  // Keep filenameTemplateId in sync when the selected template is unregistered.
  useEffect(() => {
    if (
      filenameTemplateId !== undefined &&
      !filenameTemplates.some((t) => t.id === filenameTemplateId)
    ) {
      setFilenameTemplateId(undefined);
    }
  }, [filenameTemplates, filenameTemplateId]);

  const setProcField = (procId: string, key: string, value: unknown) => {
    setProcessorSettings((prev) => ({
      ...prev,
      [procId]: { ...(prev[procId] ?? {}), [key]: value },
    }));
  };

  // Export the current selection; fall back to the single active photo.
  const targets = useMemo(() => {
    if (selectedIds.size > 0) return photos.filter((p) => selectedIds.has(p.id));
    if (activePhotoId) {
      const p = photos.find((ph) => ph.id === activePhotoId);
      return p ? [p] : [];
    }
    return [];
  }, [photos, selectedIds, activePhotoId]);

  const hasQuality = format !== "image/png";

  // Revert to Files when dropping to a single photo (ZIP/Folder are multi-only).
  useEffect(() => {
    if (targets.length === 1 && (delivery === "zip" || delivery === "folder")) {
      setDelivery("files");
    }
  }, [targets.length, delivery]);

  // ── Preset helpers ──────────────────────────────────────────────────────

  const loadPreset = (preset: ExportPreset) => {
    setFormat(preset.format);
    setQuality(preset.quality);
    setLongEdge(preset.longEdge);
    setSharpenAmount(preset.sharpenAmount);
    setSharpenRadius(preset.sharpenRadius);
  };

  const savePreset = () => {
    const name = presetName.trim();
    if (!name) return;
    const preset: ExportPreset = {
      name,
      format: format as ExportPreset["format"],
      quality,
      longEdge,
      colorSpace: getSettings().exportColorSpace,
      sharpenAmount,
      sharpenRadius,
    };
    const existing = presets.filter((p) => p.name !== name);
    updateSettings({ exportPresets: [...existing, preset] });
    setSavingPreset(false);
    setPresetName("");
  };

  const deletePreset = (name: string) => {
    updateSettings({ exportPresets: presets.filter((p) => p.name !== name) });
  };

  // ── Folder picker ───────────────────────────────────────────────────────

  const pickFolder = async () => {
    try {
      const dir = await window.showDirectoryPicker({ mode: "readwrite", id: "safelight-export" });
      setDestDir(dir);
      setDelivery("folder");
    } catch {
      // user cancelled
    }
  };

  const handleExport = async () => {
    if (busy || targets.length === 0) return;
    let dir = destDir;
    if (delivery === "folder" && !dir) {
      try {
        dir = await window.showDirectoryPicker({ mode: "readwrite", id: "safelight-export" });
        setDestDir(dir);
      } catch {
        return; // user cancelled
      }
    }

    setBusy(true);
    setStatus(null);
    setProgress({ done: 0, total: targets.length });

    const settings: ExportSettings = {
      format,
      quality: quality / 100,
      longEdge,
      bundle: delivery === "zip",
      delivery,
      colorSpace: getSettings().exportColorSpace,
      processorSettings,
      filenameTemplateId,
      sharpenAmount,
      sharpenRadius,
    };
    try {
      const result = await exportPhotos(
        targets,
        settings,
        (p) => setProgress({ done: p.done, total: p.total }),
        dir ?? undefined,
      );
      setStatus(
        result.failed.length === 0
          ? `Exported ${result.exported} photo${result.exported === 1 ? "" : "s"}.`
          : `Exported ${result.exported}; ${result.failed.length} could not be decoded.`,
      );
    } catch (e) {
      setStatus(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  const optionBtn = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] ${
      active
        ? "bg-surface-3 text-text-primary"
        : "bg-surface-2 text-text-muted hover:text-text-primary"
    }`;

  return (
    <div className="flex flex-col">
      {presets.length > 0 && (
        <Panel title="Preset">
          <div className="flex flex-col gap-1">
            {presets.map((p) => (
              <div key={p.name} className="flex items-center gap-1">
                <button
                  onClick={() => loadPreset(p)}
                  className={`flex-1 text-left ${optionBtn(false)}`}
                >
                  {p.name}
                </button>
                <button
                  onClick={() => deletePreset(p.name)}
                  className="rounded px-1.5 py-1 text-[10px] text-text-muted hover:text-text-primary"
                  title="Delete preset"
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </Panel>
      )}

      <Panel title="Format">
        <div className="flex gap-1">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              onClick={() => setFormat(f.value)}
              className={`flex-1 ${optionBtn(format === f.value)}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </Panel>

      {hasQuality && (
        <Panel title="Quality">
          <Slider
            label=""
            value={quality}
            min={1}
            max={100}
            defaultValue={90}
            onChange={setQuality}
          />
        </Panel>
      )}

      <Panel title="Resolution">
        <div className="grid grid-cols-2 gap-1">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.label}
              onClick={() => setLongEdge(r.value)}
              className={optionBtn(longEdge === r.value)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[10px] leading-snug text-text-muted">
          Long edge. Original is limited by the largest decodable size.
        </p>
      </Panel>

      <Panel title="Output Sharpening" defaultOpen={false}>
        <Slider
          label="Amount"
          value={sharpenAmount}
          min={0}
          max={150}
          step={1}
          defaultValue={0}
          onChange={setSharpenAmount}
        />
        <Slider
          label="Radius"
          value={sharpenRadius}
          min={0.3}
          max={3}
          step={0.1}
          defaultValue={1}
          onChange={setSharpenRadius}
        />
        {sharpenAmount === 0 && (
          <p className="mt-1 text-[10px] leading-snug text-text-muted">
            Off. Increase amount to sharpen after resize.
          </p>
        )}
      </Panel>

      <Panel title="Delivery">
        <div className="flex gap-1">
          {targets.length !== 1 && (
            <button
              onClick={() => setDelivery("zip")}
              className={`flex-1 ${optionBtn(delivery === "zip")}`}
            >
              ZIP
            </button>
          )}
          <button
            onClick={() => setDelivery("files")}
            className={`flex-1 ${optionBtn(delivery === "files")}`}
          >
            Files
          </button>
          {targets.length !== 1 && (
            <button
              onClick={() => setDelivery("folder")}
              className={`flex-1 ${optionBtn(delivery === "folder")}`}
            >
              Folder
            </button>
          )}
        </div>
        {delivery === "folder" ? (
          <p className="mt-2 text-[10px] leading-snug text-text-muted">
            {destDir ? (
              <>Saving to <span className="text-text-secondary">{destDir.name}</span>.{" "}
              <button onClick={() => void pickFolder()} className="underline hover:text-text-primary">Change...</button></>
            ) : "A folder picker will open on export."}
          </p>
        ) : delivery === "zip" ? (
          <p className="mt-2 text-[10px] leading-snug text-text-muted">
            All photos in a single ZIP download.
          </p>
        ) : (
          <p className="mt-2 text-[10px] leading-snug text-text-muted">
            One download prompt per photo.
          </p>
        )}
      </Panel>

      {filenameTemplates.length > 0 && (
        <Panel title="Filename" defaultOpen={false}>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => setFilenameTemplateId(undefined)}
              className={`text-left ${optionBtn(filenameTemplateId === undefined)}`}
            >
              Default
            </button>
            {filenameTemplates.map((t) => (
              <button
                key={t.id}
                onClick={() => setFilenameTemplateId(t.id)}
                className={`text-left ${optionBtn(filenameTemplateId === t.id)}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {filenameTemplateId !== undefined && (() => {
            const tpl = filenameTemplates.find((t) => t.id === filenameTemplateId);
            return tpl ? (
              <p className="mt-2 font-mono text-[10px] leading-snug text-text-muted">
                {tpl.template}
              </p>
            ) : null;
          })()}
        </Panel>
      )}

      {exportProcessors.map((proc) => {
        const fields = proc.settings ?? [];
        const procVals = processorSettings[proc.id] ?? {};
        const enabledField = fields.find((f) => f.key === "enabled" && f.type === "boolean");
        const otherFields = fields.filter(
          (f) => !(f.key === "enabled" && f.type === "boolean"),
        );

        return (
          <Panel key={proc.id} title={proc.label} defaultOpen={false}>
            {enabledField && (
              <ProcessorFieldRow
                key="enabled"
                field={enabledField}
                value={procVals.enabled}
                onChange={(v) => setProcField(proc.id, "enabled", v)}
              />
            )}
            {otherFields.map((field) => (
              <ProcessorFieldRow
                key={field.key}
                field={field}
                value={procVals[field.key]}
                onChange={(v) => setProcField(proc.id, field.key, v)}
              />
            ))}
            {fields.length === 0 && (
              <p className="text-[10px] text-text-muted">No settings.</p>
            )}
          </Panel>
        );
      })}

      <div className="p-3">
        <p className="text-[11px] text-text-secondary">
          {targets.length === 0
            ? "Select one or more photos in the Library to export."
            : `${targets.length} photo${
                targets.length === 1 ? "" : "s"
              } ready as ${format.split("/")[1].toUpperCase()}.`}
        </p>
        <div className="mt-2 flex gap-1">
          <button
            onClick={() => void handleExport()}
            disabled={busy || targets.length === 0}
            className="flex-1 rounded bg-slider-fill px-3 py-2 text-xs font-medium text-white hover:bg-surface-4 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && progress
              ? `Exporting ${progress.done}/${progress.total}...`
              : targets.length > 0
                ? `Export ${targets.length}`
                : "Export"}
          </button>
          {savingPreset ? (
            <form
              className="flex gap-1"
              onSubmit={(e) => { e.preventDefault(); savePreset(); }}
            >
              <input
                type="text"
                value={presetName}
                onChange={(e) => setPresetName(e.target.value)}
                placeholder="Preset name"
                autoFocus
                className="w-24 rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none focus:ring-1 focus:ring-slider-fill"
                onKeyDown={(e) => { if (e.key === "Escape") setSavingPreset(false); }}
              />
              <button
                type="submit"
                disabled={!presetName.trim()}
                className="rounded bg-surface-3 px-2 py-1 text-[11px] text-text-primary hover:bg-surface-4 disabled:opacity-40"
              >
                Save
              </button>
            </form>
          ) : (
            <button
              onClick={() => setSavingPreset(true)}
              className="rounded bg-surface-2 px-2 py-1 text-[11px] text-text-muted hover:text-text-primary"
              title="Save current settings as a preset"
            >
              Save...
            </button>
          )}
        </div>
        {status && (
          <p className="mt-3 text-[11px] text-text-secondary">{status}</p>
        )}
      </div>

      <Panel title="Privacy" defaultOpen={false}>
        <p className="text-[10px] leading-snug text-text-muted">
          Exports are rendered locally and carry no EXIF or location metadata.
          Nothing leaves your device.
        </p>
      </Panel>
    </div>
  );
}
