import { useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import {
  type TransformParams,
  type UprightMode,
} from "@/catalog/types";
import { buildLensDistort, maxCropForTransform } from "@/rendering/crop-transform";
import { buildInverseTransform } from "@/rendering/transform";
import { getRenderBridge } from "@/rendering/render-bridge";
import { computeGuidedCorrection } from "@/rendering/upright";

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
  const guidedEditing = useDevelopStore((s) => s.guidedEditing);
  const setGuidedEditing = useDevelopStore((s) => s.setGuidedEditing);
  const constrainCrop = useDevelopStore((s) => s.constrainCrop);
  const setConstrainCrop = useDevelopStore((s) => s.setConstrainCrop);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const activePhotoId = useCatalogStore((s) => s.activePhotoId);
  const photos = useCatalogStore((s) => s.photos);
  const [analyzing, setAnalyzing] = useState(false);

  const photo = photos.find((p) => p.id === activePhotoId);
  const imageAspect = photo && photo.height > 0 ? photo.width / photo.height : 1;

  const cropAspect = useDevelopStore((s) => s.cropAspect);

  const fitCrop = (nextStraighten: number, nextTransform: TransformParams) => {
    if (!constrainCrop) return;
    const st = useDevelopStore.getState();
    const inv = buildInverseTransform(nextStraighten, nextTransform, imageAspect);
    const distort = buildLensDistort(
      st.params.lensCorrection, st.resolvedLensProfile, imageAspect,
    );
    // -1 = Original: resolve to the image's own aspect.
    setParam(
      "crop",
      maxCropForTransform(inv, cropAspect === -1 ? imageAspect : cropAspect, distort),
    );
  };

  const onChange = (key: keyof TransformParams, v: number) => {
    const next: TransformParams = {
      ...useDevelopStore.getState().params.transform,
      [key]: v,
    };
    setParam("transform", next);
    if (constrainCrop) {
      fitCrop(straighten, next);
    }
  };

  const applyUpright = async (mode: UprightMode) => {
    if (mode === "off") {
      // Clear the upright correction: zero the sliders it drives and reset tilt.
      const next: TransformParams = {
        ...useDevelopStore.getState().params.transform,
        perspectiveV: 0,
        perspectiveH: 0,
        aspect: 0,
      };
      setGuidedEditing(false);
      setParam("uprightMode", "off");
      setParam("straighten", 0);
      setParam("transform", next);
      fitCrop(0, next);
      commitEdit("Upright off");
      return;
    }
    if (mode === "guided") {
      // Guided stays the selected mode. The button toggles the drawing overlay:
      // open it on entry, close it on "Done" (which releases the canvas without
      // dropping the mode). Either way, recompute from the lines drawn so far.
      const closing = uprightMode === "guided" && guidedEditing;
      setParam("uprightMode", "guided");
      setGuidedEditing(!closing);
      const st = useDevelopStore.getState();
      const result = computeGuidedCorrection(st.params.guidedLines, imageAspect);
      const next: TransformParams = {
        ...st.params.transform,
        perspectiveV: Math.round(result.perspectiveV),
        perspectiveH: Math.round(result.perspectiveH),
      };
      setParam("straighten", result.straighten);
      setParam("transform", next);
      fitCrop(result.straighten, next);
      commitEdit("Guided Upright");
      return;
    }
    setGuidedEditing(false);
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
      fitCrop(result.straighten, next);
      commitEdit(`Upright ${mode}`);
    } finally {
      setAnalyzing(false);
    }
  };

  return (
    <Panel title="Transform" defaultOpen={false}>
      <div className="space-y-0.5">
        <div className="flex gap-0.5 mb-1">
          {UPRIGHT_MODES.map((u) => {
            const active = uprightMode === u.mode;
            // While the guided overlay is open the button finishes editing.
            const label =
              u.mode === "guided" && active && guidedEditing ? "Done" : u.label;
            return (
              <button
                key={u.mode}
                disabled={analyzing}
                onClick={() => applyUpright(u.mode)}
                className={`flex-1 rounded px-1 py-0.5 text-[10px] ${
                  active
                    ? "bg-accent text-text-primary"
                    : "bg-surface-2 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        <Slider label="Vertical" value={transform.perspectiveV} min={-100} max={100} step={1}
          onChange={(v) => onChange("perspectiveV", v)}
          onCommit={() => commitEdit("Transform")}
        />
        <Slider label="Horizontal" value={transform.perspectiveH} min={-100} max={100} step={1}
          onChange={(v) => onChange("perspectiveH", v)}
          onCommit={() => commitEdit("Transform")}
        />
        <Slider label="Aspect" value={transform.aspect} min={-100} max={100} step={1}
          onChange={(v) => onChange("aspect", v)}
          onCommit={() => commitEdit("Transform")}
        />

        <label className="flex items-center gap-1.5 pt-1 text-[11px] text-text-secondary">
          <input
            type="checkbox"
            checked={constrainCrop}
            onChange={(e) => setConstrainCrop(e.target.checked)}
            className="accent-slider-fill"
          />
          Constrain crop
        </label>
      </div>
    </Panel>
  );
}
