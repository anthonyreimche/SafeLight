// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { useSlot } from "@/extensions/registry";
import { Slot } from "@/extensions/Slot";
import { useMaskScope } from "@/modules/develop/mask-scope";
import { DEFAULT_DEVELOP_PARAMS, type DevelopParams, type MaskAdjustments } from "@/catalog/types";
import type { MaskPanelContribution } from "@/extensions/types";

interface SliderDef {
  key: keyof DevelopParams;
  label: string;
  min: number;
  max: number;
  step: number;
  // Alt/Ctrl-drag preview mode (see develop-store.sharpenViz):
  // 1 = masking, 2 = detail, 3 = luminance (grayscale), 4 = chroma (colour-noise
  // reveal). Omitted = no preview.
  viz?: number;
}

const SHARPENING_SLIDERS: SliderDef[] = [
  { key: "sharpening",     label: "Amount",  min: 0, max: 150, step: 1,   viz: 3 },
  { key: "sharpenRadius",  label: "Radius",  min: 1, max: 3,   step: 0.1, viz: 3 },
  { key: "sharpenDetail",  label: "Detail",  min: 0, max: 100, step: 1,   viz: 2 },
  { key: "sharpenMasking", label: "Masking", min: 0, max: 100, step: 1,   viz: 1 },
];

const LUM_NR_SLIDERS: SliderDef[] = [
  { key: "luminanceNR",             label: "Luminance",  min: 0, max: 100, step: 1, viz: 3 },
  { key: "luminanceNRDetail",       label: "Detail",     min: 0, max: 100, step: 1, viz: 3 },
  { key: "luminanceNRContrast",     label: "Contrast",   min: 0, max: 100, step: 1, viz: 3 },
  { key: "luminanceNRShadows",      label: "Shadows",    min: 0, max: 100, step: 1, viz: 3 },
  { key: "luminanceNRHighlights",   label: "Highlights", min: 0, max: 100, step: 1, viz: 3 },
];

const COLOR_NR_SLIDERS: SliderDef[] = [
  { key: "colorNR",           label: "Color",      min: 0, max: 100, step: 1, viz: 4 },
  { key: "colorNRDetail",     label: "Detail",     min: 0, max: 100, step: 1, viz: 4 },
  { key: "colorNRSmoothness", label: "Smoothness", min: 0, max: 100, step: 1, viz: 4 },
];

function SliderGroup({
  title,
  sliders,
}: {
  title: string;
  sliders: SliderDef[];
}) {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const setSharpenViz = useDevelopStore((s) => s.setSharpenViz);

  return (
    <div>
      {title && (
        <div className="px-2 pt-2 pb-0.5 text-[10px] font-semibold uppercase tracking-widest text-neutral-500">
          {title}
        </div>
      )}
      <div className="space-y-0.5">
        {sliders.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            value={params[s.key] as number}
            min={s.min}
            max={s.max}
            step={s.step}
            defaultValue={DEFAULT_DEVELOP_PARAMS[s.key] as number}
            onChange={(v) => setParam(s.key, v)}
            onCommit={() => commitEdit(title ? `${title} ${s.label}` : s.label)}
            onModifierPreview={
              s.viz
                ? (active) => setSharpenViz(active ? s.viz! : 0)
                : undefined
            }
          />
        ))}
      </div>
    </div>
  );
}

export function DetailPanel() {
  // An extension denoise method (e.g. wavelet) contributes controls here; when it
  // does, its UI replaces the built-in mip-blur NR sliders (which the core shader
  // also stops applying — see uSkipCoreNR). Empty → the built-in NR shows.
  const denoiseControls = useSlot("develop-detail");
  const hasCustomNR = denoiseControls.length > 0;

  return (
    <Panel title="Detail">
      <div className="space-y-1">
        <SliderGroup title="Sharpening" sliders={SHARPENING_SLIDERS} />
        {hasCustomNR ? (
          <Slot name="develop-detail" />
        ) : (
          <>
            <SliderGroup title="Noise Reduction" sliders={LUM_NR_SLIDERS} />
            <SliderGroup title="" sliders={COLOR_NR_SLIDERS} />
          </>
        )}
      </div>
    </Panel>
  );
}

// Per-mask instance: the local detail taps the shader's mask stage supports
// (texture/clarity/dehaze live here rather than Basic, matching where they run
// in the display-space mask pass). No sharpening sub-controls or NR — noise
// reduction is a whole-image prepass with no per-mask path.
const MASK_SLIDERS: { key: keyof MaskAdjustments; label: string }[] = [
  { key: "texture", label: "Texture" },
  { key: "clarity", label: "Clarity" },
  { key: "dehaze", label: "Dehaze" },
  { key: "sharpness", label: "Sharpness" },
];

function DetailMaskPanel() {
  const scope = useMaskScope();
  return (
    <div className="space-y-0.5">
      {MASK_SLIDERS.map((s) => (
        <Slider
          key={s.key}
          label={s.label}
          value={scope.adj[s.key]}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          onChange={(v) => scope.setAdj({ [s.key]: v })}
          onCommit={() => scope.commit(`Mask ${s.label}`)}
        />
      ))}
    </div>
  );
}

export const DETAIL_MASK_PANEL: MaskPanelContribution = {
  component: DetailMaskPanel,
  order: 50,
  owns: MASK_SLIDERS.map((s) => s.key),
};
