import { Panel } from "@/ui/components/Panel";
import { useCatalogStore } from "@/state/catalog-store";

function formatSize(bytes: number): string {
  if (bytes >= 1 << 20) return `${(bytes / (1 << 20)).toFixed(1)} MB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KB`;
  return `${bytes} B`;
}

function formatDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` : s;
}

export function MetadataPanel() {
  const photo = useCatalogStore((s) =>
    s.photos.find((p) => p.id === s.activePhotoId),
  );
  if (!photo) {
    return (
      <Panel title="Metadata">
        <p className="text-[11px] text-text-muted">Select a photo</p>
      </Panel>
    );
  }

  const e = photo.exif;
  const camera = [e.cameraMake, e.cameraModel].filter(Boolean).join(" ");
  const rows: [string, string | undefined][] = [
    ["Camera", camera || undefined],
    ["Lens", e.lens],
    ["Focal length", e.focalLength ? `${e.focalLength} mm` : undefined],
    ["Aperture", e.aperture ? `f/${e.aperture}` : undefined],
    ["Shutter", e.shutterSpeed],
    ["ISO", e.iso ? `${e.iso}` : undefined],
    ["Date", formatDate(e.dateTimeOriginal)],
    [
      "Dimensions",
      photo.width && photo.height
        ? `${photo.width} × ${photo.height}`
        : undefined,
    ],
    ["Size", formatSize(photo.fileSize)],
    ["Type", photo.mimeType || undefined],
  ];
  const visible = rows.filter((r): r is [string, string] => Boolean(r[1]));

  return (
    <Panel title="Metadata">
      <dl className="space-y-0.5">
        {visible.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2 text-[11px]">
            <dt className="shrink-0 text-text-muted">{k}</dt>
            <dd className="truncate text-right text-text-secondary" title={v}>
              {v}
            </dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
