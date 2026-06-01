import { useRef } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { DEFAULT_CROP, type CropRect } from "@/catalog/types";
import { computeCropForAspect, fitCropToImage } from "@/rendering/crop-transform";
import { CROP_GUIDES } from "../crop-guides";

// ratio is width:height in pixels. 0 = Free (no lock); -1 = Original (locks to
// the source image's own aspect, resolved per photo). Locked ratios can be
// dragged into either orientation (3:2 ⇄ 2:3) from the handles.
const ASPECTS: { label: string; ratio: number }[] = [
  { label: "Free", ratio: 0 },
  { label: "Original", ratio: -1 },
  { label: "1:1", ratio: 1 },
  { label: "3:2", ratio: 3 / 2 },
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
  const cropGuide = useDevelopStore((s) => s.cropGuide);
  const setCropGuide = useDevelopStore((s) => s.setCropGuide);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const crop = useDevelopStore((s) => s.params.crop);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);

  const photo = photos.find((p) => p.id === activePhotoId);
  const imageAspect = photo && photo.height > 0 ? photo.width / photo.height : 1;

  // The crop as it was before a straighten drag began. Fitting against this
  // (rather than the live, shrinking crop) lets rotating back un-crop outward.
  const baseCropRef = useRef<CropRect | null>(null);

  const applyAspect = (ratio: number) => {
    setCropping(true);
    if (ratio === 0) {
      // Free: unlock the aspect but keep the current box.
      setCropAspect(0);
      return;
    }
    // Original (-1) resolves to the source image's own aspect.
    const resolved = ratio === -1 ? imageAspect : ratio;
    setCropAspect(resolved);
    // computeCropForAspect sizes the crop for the unrotated image; if the photo
    // is straightened, shrink it (ratio-preserving) so it fits the rotated
    // image and the handles stay inside.
    let next = computeCropForAspect(resolved, imageAspect);
    if (constrainCrop) {
      next = fitCropToImage(next, (straighten * Math.PI) / 180, imageAspect);
    }
    setParam("crop", next);
    commitEdit("Crop");
  };

  const aspectActive = (ratio: number) => {
    if (ratio === 0) return cropAspect === 0;
    const resolved = ratio === -1 ? imageAspect : ratio;
    return cropAspect !== 0 && Math.abs(cropAspect - resolved) < 1e-4;
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
                aspectActive(a.ratio)
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
          // Displayed value is negated so dragging rotates the intuitive way;
          // the stored `straighten` (and leveling) keep their sign convention.
          value={-straighten}
          min={-45}
          max={45}
          step={0.1}
          onChange={(v) => {
            const s = -v;
            setParam("straighten", s);
            if (constrainCrop) {
              if (!baseCropRef.current) baseCropRef.current = crop;
              setParam(
                "crop",
                fitCropToImage(
                  baseCropRef.current,
                  (s * Math.PI) / 180,
                  imageAspect,
                ),
              );
            }
          }}
          onCommit={() => {
            baseCropRef.current = null;
            commitEdit("Straighten");
          }}
        />

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-text-muted">
            <span>Overlay</span>
            <span>press O to cycle</span>
          </div>
          <div className="grid grid-cols-3 gap-1">
            {CROP_GUIDES.map((g) => (
              <button
                key={g.id}
                onClick={() => setCropGuide(g.id)}
                className={`rounded px-2 py-1 text-[11px] ${
                  cropGuide === g.id
                    ? "bg-surface-3 text-text-primary"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                }`}
              >
                {g.label}
              </button>
            ))}
          </div>
        </div>

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
