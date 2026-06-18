import { useRef, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import {
  DEFAULT_TRANSFORM,
  type CropRect,
  type TransformParams,
  type UprightMode,
} from "@/catalog/types";
import { fitCropToImage } from "@/rendering/crop-transform";
import { buildInverseTransform, applyInsetToInverse } from "@/rendering/transform";
import { computeAutoCropScale } from "@/lens-profiles/auto-crop";
import { getRenderBridge } from "@/rendering/render-bridge";

function getLensCropScale(imageAspect: number): number {
  const st = useDevelopStore.getState();
  const lc = st.params.lensCorrection;
  if (lc.mode === "off") return 1;
  const lp = st.resolvedLensProfile;
  if (lc.mode === "profile" && lp?.distortion && lc.distortionEnabled) {
    return computeAutoCropScale(lp.distortion.model, lp.distortion.k, lc.distortion, imageAspect);
  }
  if (Math.abs(lc.distortion) > 0.001) {
    return computeAutoCropScale("poly3", [0], lc.distortion, imageAspect);
  }
  return 1;
}

const SLIDERS: { key: keyof TransformParams; label: string }[] = [
  { key: "perspectiveV", label: "Vertical" },
  { key: "perspectiveH", label: "Horizontal" },
  { key: "aspect", label: "Aspect" },
  { key: "scale", label: "Scale" },
  { key: "offsetX", label: "X Offset" },
  { key: "offsetY", label: "Y Offset" },
];

const UPRIGHT_MODES: { mode: UprightMode; label: string }[] = [
  { mode: "off", label: "Off" },
  { mode: "level", label: "Level" },
  { mode: "vertical", label: "Vert" },
  { mode: "auto", label: "Auto" },
  { mode: "full", label: "Full" },
  { mode: "guided", label: "Guided" },
];

export function TransformPanel() {
  const transform = useDevelopStore((s) => s.params.transform);
  const straighten = useDevelopStore((s) => s.params.straighten);
  const uprightMode = useDevelopStore((s) => s.params.uprightMode);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);
  const [analyzing, setAnalyzing] = useState(false);

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
          applyInsetToInverse(
            buildInverseTransform(straighten, next, imageAspect),
            getLensCropScale(imageAspect),
          ),
        ),
      );
    }
  };

  const applyUpright = async (mode: UprightMode) => {
    if (mode === "off") {
      setParam("uprightMode", "off");
      commitEdit("Upright off");
      return;
    }
    if (mode === "guided") {
      setParam("uprightMode", "guided");
      commitEdit("Upright guided");
      return;
    }
    setParam("uprightMode", mode);
    setAnalyzing(true);
    try {
      const result = await getRenderBridge().computeUpright(mode);
      const st = useDevelopStore.getState();
      setParam("straighten", result.straighten);
      const next: TransformParams = {
        ...st.params.transform,
        perspectiveV: Math.round(result.perspectiveV),
        perspectiveH: Math.round(result.perspectiveH),
        ...(result.aspect != null ? { aspect: Math.round(result.aspect) } : {}),
      };
      setParam("transform", next);
      if (constrainCrop) {
        setParam(
          "crop",
          fitCropToImage(
            st.params.crop,
            applyInsetToInverse(
              buildInverseTransform(result.straighten, next, imageAspect),
              getLensCropScale(imageAspect),
            ),
          ),
        );
      }
      commitEdit(`Upright ${mode}`);
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    setParam("transform", { ...DEFAULT_TRANSFORM });
    setParam("uprightMode", "off");
    commitEdit("Transform reset");
  };

  return (
    <Panel title="Transform" defaultOpen={false}>
      <div className="space-y-0.5">
        <div className="flex gap-0.5 mb-1">
          {UPRIGHT_MODES.map((u) => (
            <button
              key={u.mode}
              disabled={analyzing}
              onClick={() => applyUpright(u.mode)}
              className={`flex-1 rounded px-1 py-0.5 text-[10px] ${
                uprightMode === u.mode
                  ? "bg-accent text-text-primary"
                  : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              }`}
            >
              {u.label}
            </button>
          ))}
        </div>
        {SLIDERS.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            value={transform[s.key] as number}
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
