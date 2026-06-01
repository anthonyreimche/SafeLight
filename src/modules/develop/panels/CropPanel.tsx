import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { DEFAULT_CROP } from "@/catalog/types";
import { computeCropForAspect, fitCropToImage } from "@/rendering/crop-transform";

// ratio is width:height in pixels; 0 means "Original" (full frame, free aspect).
const ASPECTS: { label: string; ratio: number }[] = [
  { label: "Original", ratio: 0 },
  { label: "1:1", ratio: 1 },
  { label: "3:2", ratio: 3 / 2 },
  { label: "2:3", ratio: 2 / 3 },
  { label: "4:3", ratio: 4 / 3 },
  { label: "16:9", ratio: 16 / 9 },
];

export function CropPanel() {
  const cropping = useDevelopStore((s) => s.cropping);
  const setCropping = useDevelopStore((s) => s.setCropping);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const setConstrainCrop = useDevelopStore((s) => s.setConstrainCrop);
  const cropAspect = useDevelopStore((s) => s.cropAspect);
  const setCropAspect = useDevelopStore((s) => s.setCropAspect);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const crop = useDevelopStore((s) => s.params.crop);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);

  const photo = photos.find((p) => p.id === activePhotoId);
  const imageAspect = photo && photo.height > 0 ? photo.width / photo.height : 1;

  const applyAspect = (ratio: number) => {
    setCropAspect(ratio);
    setParam(
      "crop",
      ratio <= 0 ? { ...DEFAULT_CROP } : computeCropForAspect(ratio, imageAspect),
    );
    setCropping(true);
    commitEdit("Crop");
  };

  const resetCrop = () => {
    setCropAspect(0);
    setParam("crop", { ...DEFAULT_CROP });
    setParam("straighten", 0);
    commitEdit("Crop reset");
  };

  return (
    <Panel title="Crop & Straighten" defaultOpen={false}>
      <div className="space-y-2">
        <button
          onClick={() => setCropping(!cropping)}
          className={`w-full rounded px-2 py-1 text-[11px] font-medium ${
            cropping
              ? "bg-accent text-white hover:bg-accent-hover"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          }`}
        >
          {cropping ? "Done" : "Crop"}
        </button>

        <div className="grid grid-cols-3 gap-1">
          {ASPECTS.map((a) => (
            <button
              key={a.label}
              onClick={() => applyAspect(a.ratio)}
              className={`rounded px-2 py-1 text-[11px] ${
                cropAspect === a.ratio
                  ? "bg-surface-3 text-text-primary"
                  : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              }`}
            >
              {a.label}
            </button>
          ))}
        </div>

        <Slider
          label="Straighten"
          value={straighten}
          min={-45}
          max={45}
          step={0.1}
          onChange={(v) => {
            setParam("straighten", v);
            if (cropping && constrainCrop) {
              setParam(
                "crop",
                fitCropToImage(crop, (v * Math.PI) / 180, imageAspect),
              );
            }
          }}
          onCommit={() => commitEdit("Straighten")}
        />

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={constrainCrop}
            onChange={(e) => setConstrainCrop(e.target.checked)}
            className="accent-accent"
          />
          Constrain to image
        </label>

        {cropping && (
          <p className="text-[10px] leading-snug text-text-muted">
            Drag the edges/corners to crop · Ctrl-drag across a line to level.
          </p>
        )}

        <button
          onClick={resetCrop}
          className="w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Reset crop
        </button>
      </div>
    </Panel>
  );
}
