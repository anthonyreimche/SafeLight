import { useMemo, useState } from "react";
import { AppShell } from "@/ui/components/AppShell";
import { Panel } from "@/ui/components/Panel";
import { useCatalogStore } from "@/state/catalog-store";
import {
  exportPhotos,
  type ExportFormat,
  type ExportSettings,
} from "./export-image";

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

export function ExportView() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);

  const [format, setFormat] = useState<ExportFormat>("image/jpeg");
  const [quality, setQuality] = useState(90);
  const [longEdge, setLongEdge] = useState<number | null>(null);
  const [bundle, setBundle] = useState(true);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [status, setStatus] = useState<string | null>(null);

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

  const handleExport = async () => {
    if (busy || targets.length === 0) return;
    setBusy(true);
    setStatus(null);
    setProgress({ done: 0, total: targets.length });

    const settings: ExportSettings = {
      format,
      quality: quality / 100,
      longEdge,
      bundle,
    };
    const result = await exportPhotos(targets, settings, (p) =>
      setProgress({ done: p.done, total: p.total }),
    );

    setBusy(false);
    setProgress(null);
    setStatus(
      result.failed.length === 0
        ? `Exported ${result.exported} photo${result.exported === 1 ? "" : "s"}.`
        : `Exported ${result.exported}; ${result.failed.length} could not be decoded.`,
    );
  };

  const optionBtn = (active: boolean) =>
    `rounded px-2 py-1 text-[11px] ${
      active
        ? "bg-surface-3 text-text-primary"
        : "bg-surface-2 text-text-muted hover:text-text-primary"
    }`;

  return (
    <AppShell
      rightSidebar={
        <div className="flex flex-col">
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
              <div className="flex items-center gap-2 py-0.5">
                <input
                  type="range"
                  min={1}
                  max={100}
                  step={1}
                  value={quality}
                  onChange={(e) => setQuality(Number(e.target.value))}
                  onDoubleClick={() => setQuality(90)}
                  title="Quality (double-click to reset)"
                  className="sl-slider flex-1"
                  style={{
                    background: `linear-gradient(to right, #5a5a5a 0%, #5a5a5a ${quality}%, var(--color-surface-3) ${quality}%, var(--color-surface-3) 100%)`,
                  }}
                />
                <span className="w-8 text-right text-[11px] tabular-nums text-text-secondary">
                  {quality}
                </span>
              </div>
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

          {targets.length > 1 && (
            <Panel title="Delivery">
              <div className="flex gap-1">
                <button
                  onClick={() => setBundle(true)}
                  className={`flex-1 ${optionBtn(bundle)}`}
                >
                  ZIP archive
                </button>
                <button
                  onClick={() => setBundle(false)}
                  className={`flex-1 ${optionBtn(!bundle)}`}
                >
                  Separate files
                </button>
              </div>
              <p className="mt-2 text-[10px] leading-snug text-text-muted">
                A ZIP keeps it to a single download. Separate files prompt the
                browser once per photo.
              </p>
            </Panel>
          )}

          <Panel title="Privacy" defaultOpen={false}>
            <p className="text-[10px] leading-snug text-text-muted">
              Exports are rendered locally and carry no EXIF or location
              metadata. Nothing leaves your device.
            </p>
          </Panel>
        </div>
      }
      statusBar={
        <div className="flex w-full items-center justify-between">
          <span>Export</span>
          <span>
            {targets.length} photo{targets.length === 1 ? "" : "s"} selected
          </span>
        </div>
      }
    >
      <div className="flex flex-1 items-center justify-center">
        <div className="w-72 text-center">
          <p className="text-sm text-text-primary">Export</p>
          <p className="mt-1 text-xs text-text-muted">
            {targets.length === 0
              ? "Select one or more photos in the Library to export."
              : `${targets.length} photo${
                  targets.length === 1 ? "" : "s"
                } ready as ${format.split("/")[1].toUpperCase()}.`}
          </p>

          <button
            onClick={handleExport}
            disabled={busy || targets.length === 0}
            className="mt-4 w-full rounded bg-accent px-3 py-2 text-xs font-medium text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && progress
              ? `Exporting ${progress.done}/${progress.total}…`
              : targets.length > 0
                ? `Export ${targets.length}`
                : "Export"}
          </button>

          {status && (
            <p className="mt-3 text-[11px] text-text-secondary">{status}</p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
