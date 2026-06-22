import { Panel } from "@/ui/components/Panel";
import { Rating } from "@/ui/components/Rating";
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

function formatFocal(e: { focalLength?: number; focalLength35mm?: number }): string | undefined {
  if (!e.focalLength) return undefined;
  if (e.focalLength35mm && e.focalLength35mm !== e.focalLength)
    return `${e.focalLength} mm (${e.focalLength35mm} mm eq.)`;
  return `${e.focalLength} mm`;
}

function formatExposureComp(v: number | undefined): string | undefined {
  if (v === undefined || v === 0) return undefined;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v} EV`;
}

function formatCoord(lat: number | undefined, lon: number | undefined): string | undefined {
  if (lat === undefined || lon === undefined) return undefined;
  const ns = lat >= 0 ? "N" : "S";
  const ew = lon >= 0 ? "E" : "W";
  return `${Math.abs(lat).toFixed(4)}° ${ns}, ${Math.abs(lon).toFixed(4)}° ${ew}`;
}

function formatAltitude(v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  return `${v} m`;
}

function formatDistance(v: number | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v >= 1) return `${v} m`;
  return `${Math.round(v * 100)} cm`;
}

function formatLens(e: {
  lens?: string;
  lensMake?: string;
}): string | undefined {
  if (!e.lens) return undefined;
  if (e.lensMake && !e.lens.startsWith(e.lensMake)) return `${e.lensMake} ${e.lens}`;
  return e.lens;
}

export function MetadataPanel() {
  const photo = useCatalogStore((s) =>
    s.photos.find((p) => p.id === s.activePhotoId),
  );
  const setRating = useCatalogStore((s) => s.setRating);
  if (!photo) {
    return (
      <Panel title="Metadata">
        <p className="text-[11px] text-text-muted">Select a photo</p>
      </Panel>
    );
  }

  const e = photo.exif;
  const camera = [e.cameraMake, e.cameraModel].filter(Boolean).join(" ");
  const hasGps = e.gpsLatitude !== undefined && e.gpsLongitude !== undefined;

  const rows: [string, string | undefined][] = [
    ["Filename", photo.filename],
    ["Artist", e.artist],
    ["Copyright", e.copyright],
    ["Description", e.imageDescription],
    ["Camera", camera || undefined],
    ["Body S/N", e.bodySerial],
    ["Software", e.software],
    ["Lens", formatLens(e)],
    ["Lens S/N", e.lensSerial],
    ["Focal length", formatFocal(e)],
    ["Max aperture", e.maxAperture ? `f/${e.maxAperture}` : undefined],
    ["Aperture", e.aperture ? `f/${e.aperture}` : undefined],
    ["Shutter", e.shutterSpeed],
    ["ISO", e.iso ? `${e.iso}` : undefined],
    ["Program", e.exposureProgram],
    ["Exp. mode", e.exposureMode],
    ["Exp. comp.", formatExposureComp(e.exposureCompensation)],
    ["Metering", e.meteringMode],
    ["White balance", e.whiteBalance],
    ["Flash", e.flash],
    ["Focus dist.", formatDistance(e.subjectDistance)],
    ["Scene", e.sceneCaptureType],
    ["Color space", e.colorSpace],
    ["Date", formatDate(e.dateTimeOriginal)],
    ["Location", formatCoord(e.gpsLatitude, e.gpsLongitude)],
    ["Altitude", hasGps ? formatAltitude(e.gpsAltitude) : undefined],
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
      <div className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
        <span className="shrink-0 text-text-muted">Rating</span>
        <Rating
          value={photo.rating}
          onChange={(r) => setRating(photo.id, r)}
          size="md"
        />
      </div>
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
