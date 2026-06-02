import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { DevelopParams } from "@/catalog/types";

interface SliderDef {
  key: keyof DevelopParams;
  label: string;
  min: number;
  max: number;
  step: number;
}

const SHARPENING_SLIDERS: SliderDef[] = [
  { key: "sharpening",     label: "Amount",  min: 0, max: 150, step: 1   },
  { key: "sharpenRadius",  label: "Radius",  min: 1, max: 3,   step: 0.1 },
  { key: "sharpenDetail",  label: "Detail",  min: 0, max: 100, step: 1   },
  { key: "sharpenMasking", label: "Masking", min: 0, max: 100, step: 1   },
];

const LUM_NR_SLIDERS: SliderDef[] = [
  { key: "luminanceNR",         label: "Luminance", min: 0, max: 100, step: 1 },
  { key: "luminanceNRDetail",   label: "Detail",    min: 0, max: 100, step: 1 },
  { key: "luminanceNRContrast", label: "Contrast",  min: 0, max: 100, step: 1 },
];

const COLOR_NR_SLIDERS: SliderDef[] = [
  { key: "colorNR",           label: "Color",      min: 0, max: 100, step: 1 },
  { key: "colorNRDetail",     label: "Detail",     min: 0, max: 100, step: 1 },
  { key: "colorNRSmoothness", label: "Smoothness", min: 0, max: 100, step: 1 },
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
            onChange={(v) => setParam(s.key, v)}
            onCommit={() => commitEdit(title ? `${title} ${s.label}` : s.label)}
          />
        ))}
      </div>
    </div>
  );
}

export function DetailPanel() {
  return (
    <Panel title="Detail">
      <div className="space-y-1">
        <SliderGroup title="Sharpening" sliders={SHARPENING_SLIDERS} />
        <SliderGroup title="Noise Reduction" sliders={LUM_NR_SLIDERS} />
        <SliderGroup title="" sliders={COLOR_NR_SLIDERS} />
      </div>
    </Panel>
  );
}
