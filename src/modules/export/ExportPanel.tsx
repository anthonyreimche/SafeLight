// Export as a dock panel (View ▸ Export from either module): format, quality,
// resolution and delivery settings plus the export action, in one column.

import { useEffect, useMemo, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useCatalogStore } from "@/state/catalog-store";
import {
  exportPhotos,
  type DeliveryMode,
  type ExportFormat,
  type ExportSettings,
} from "./export-image";
import { getSettings } from "@/state/settings-store";

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

export function ExportPanel() {
  const photos = useCatalogStore((s) => s.photos);
  const selectedIds = useCatalogStore((s) => s.selectedIds);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);

  // Defaults come from Preferences ▸ Export; the panel state is per-session.
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
              <button onClick={() => void pickFolder()} className="underline hover:text-text-primary">Change…</button></>
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

      <div className="p-3">
        <p className="text-[11px] text-text-secondary">
          {targets.length === 0
            ? "Select one or more photos in the Library to export."
            : `${targets.length} photo${
                targets.length === 1 ? "" : "s"
              } ready as ${format.split("/")[1].toUpperCase()}.`}
        </p>
        <button
          onClick={() => void handleExport()}
          disabled={busy || targets.length === 0}
          className="mt-2 w-full rounded bg-slider-fill px-3 py-2 text-xs font-medium text-white hover:bg-surface-4 disabled:cursor-not-allowed disabled:opacity-40"
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

      <Panel title="Privacy" defaultOpen={false}>
        <p className="text-[10px] leading-snug text-text-muted">
          Exports are rendered locally and carry no EXIF or location metadata.
          Nothing leaves your device.
        </p>
      </Panel>
    </div>
  );
}
