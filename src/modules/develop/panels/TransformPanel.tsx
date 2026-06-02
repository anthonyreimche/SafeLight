import { useRef } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import {
  DEFAULT_TRANSFORM,
  type CropRect,
  type TransformParams,
} from "@/catalog/types";
import { fitCropToImage } from "@/rendering/crop-transform";
import { buildInverseTransform } from "@/rendering/transform";

const SLIDERS: { key: keyof TransformParams; label: string }[] = [
  { key: "perspectiveV", label: "Vertical" },
  { key: "perspectiveH", label: "Horizontal" },
  { key: "aspect", label: "Aspect" },
  { key: "scale", label: "Scale" },
  { key: "offsetX", label: "X Offset" },
  { key: "offsetY", label: "Y Offset" },
];

export function TransformPanel() {
  const transform = useDevelopStore((s) => s.params.transform);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);

  const photo = photos.find((p) => p.id === activePhotoId);
  const imageAspect = photo && photo.height > 0 ? photo.width / photo.height : 1;

  // Crop as it was before this drag began; fitting against it (rather than the
  // live shrinking crop) lets reducing a transform un-crop back outward.
  const baseCropRef = useRef<CropRect | null>(null);

  const onChange = (key: keyof TransformParams, v: number) => {
    const next: TransformParams = {
      ...useDevelopStore.getState().params.transform,
      [key]: v,
    };
    setParam("transform", next);
    if (constrainCrop) {
      if (!baseCropRef.current) {
        baseCropRef.current = useDevelopStore.getState().params.crop;
      }
      setParam(
        "crop",
        fitCropToImage(
          baseCropRef.current,
          buildInverseTransform(straighten, next, imageAspect),
        ),
      );
    }
  };

  const reset = () => {
    setParam("transform", { ...DEFAULT_TRANSFORM });
    commitEdit("Transform reset");
  };

  return (
    <Panel title="Transform" defaultOpen={false}>
      <div className="space-y-0.5">
        {SLIDERS.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            value={transform[s.key]}
            min={-100}
            max={100}
            step={1}
            onChange={(v) => onChange(s.key, v)}
            onCommit={() => {
              baseCropRef.current = null;
              commitEdit("Transform");
            }}
          />
        ))}

        <button
          onClick={reset}
          className="mt-1 w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-3 hover:text-text-primary"
        >
          Reset transform
        </button>
      </div>
    </Panel>
  );
}
