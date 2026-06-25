// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useRef, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { DEFAULT_CROP, type CropRect } from "@/catalog/types";
import {
  buildLensDistort,
  computeCropForAspect,
  fitCropToImage,
} from "@/rendering/crop-transform";
import { buildInverseTransform } from "@/rendering/transform";
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
  const transform = useDevelopStore((s) => s.params.transform);
  const lensCorrection = useDevelopStore((s) => s.params.lensCorrection);
  const resolvedLensProfile = useDevelopStore((s) => s.resolvedLensProfile);
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

  // Custom ratio entry (width : height).
  const [customW, setCustomW] = useState("16");
  const [customH, setCustomH] = useState("10");
  const customRatio = (() => {
    const w = parseFloat(customW);
    const h = parseFloat(customH);
    return w > 0 && h > 0 ? w / h : 0;
  })();

  const applyAspect = (ratio: number) => {
    setCropping(true);
    if (ratio === 0) {
      // Free: unlock the aspect but keep the current box.
      setCropAspect(0);
      return;
    }
    // Original (-1) resolves to the source image's own aspect. Keep the -1
    // sentinel in state so "Original" stays selected across photos (and its
    // ratio re-resolves per photo) rather than freezing this photo's aspect.
    const resolved = ratio === -1 ? imageAspect : ratio;
    setCropAspect(ratio === -1 ? -1 : resolved);
    // computeCropForAspect sizes the crop for the unrotated image; if the photo
    // is straightened, shrink it (ratio-preserving) so it fits the rotated
    // image and the handles stay inside.
    let next = computeCropForAspect(resolved, imageAspect);
    if (constrainCrop) {
      next = fitCropToImage(
        next,
        buildInverseTransform(straighten, transform, imageAspect),
        buildLensDistort(lensCorrection, resolvedLensProfile, imageAspect),
      );
    }
    setParam("crop", next);
    commitEdit("Crop");
  };

  const aspectActive = (ratio: number) => {
    if (ratio === 0) return cropAspect === 0;
    if (ratio === -1) return cropAspect === -1;
    return cropAspect > 0 && Math.abs(cropAspect - ratio) < 1e-4;
  };

  const resetCrop = () => {
    setCropAspect(-1);
    setParam("crop", { ...DEFAULT_CROP });
    setParam("straighten", 0);
    commitEdit("Crop reset");
  };

  return (
    <Panel title="Crop & Straighten" defaultOpen={false}>
      <div className="space-y-2">
        <button
          onClick={() => setCropping(!cropping)}
          aria-pressed={cropping}
          className={`w-full rounded px-2 py-1 text-[11px] font-medium ${
            cropping
              ? "bg-slider-fill text-white hover:bg-surface-4"
              : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
          }`}
        >
          {cropping ? "Done" : "Crop"}
        </button>

        {cropping && (
          <>
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

            {/* Custom ratio: width : height, applied like any preset. */}
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={1}
                value={customW}
                onChange={(e) => setCustomW(e.target.value)}
                className="w-12 min-w-0 rounded bg-surface-2 px-1.5 py-1 text-center text-[11px] text-text-primary outline-none focus:bg-surface-3"
              />
              <span className="text-[11px] text-text-muted">:</span>
              <input
                type="number"
                min={1}
                value={customH}
                onChange={(e) => setCustomH(e.target.value)}
                className="w-12 min-w-0 rounded bg-surface-2 px-1.5 py-1 text-center text-[11px] text-text-primary outline-none focus:bg-surface-3"
              />
              <button
                disabled={customRatio <= 0}
                onClick={() => applyAspect(customRatio)}
                className={`min-w-0 flex-1 rounded px-2 py-1 text-[11px] disabled:opacity-40 ${
                  customRatio > 0 && aspectActive(customRatio)
                    ? "bg-surface-3 text-text-primary"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                }`}
              >
                Custom
              </button>
            </div>
          </>
        )}

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
                  buildInverseTransform(s, transform, imageAspect),
                  buildLensDistort(lensCorrection, resolvedLensProfile, imageAspect),
                ),
              );
            }
          }}
          onCommit={() => {
            baseCropRef.current = null;
            commitEdit("Straighten");
          }}
        />

        {cropping && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[10px] text-text-muted">
              <span>Overlay</span>
              <span>O cycles · Shift+O flips</span>
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
        )}

        <label className="flex cursor-pointer items-center gap-2 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={constrainCrop}
            onChange={(e) => setConstrainCrop(e.target.checked)}
            className="accent-slider-fill"
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
