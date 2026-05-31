import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { DevelopParams } from "@/catalog/types";

type NumericParamKey = {
  [K in keyof DevelopParams]: DevelopParams[K] extends number ? K : never;
}[keyof DevelopParams];

const basicSliders: {
  key: NumericParamKey;
  label: string;
  min: number;
  max: number;
}[] = [
  { key: "exposure", label: "Exposure", min: -5, max: 5 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "whites", label: "Whites", min: -100, max: 100 },
  { key: "blacks", label: "Blacks", min: -100, max: 100 },
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
];

export function BasicPanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="Basic">
      <div className="space-y-0.5">
        {basicSliders.map((s) => (
          <Slider
            key={s.key}
            label={s.label}
            value={params[s.key]}
            min={s.min}
            max={s.max}
            step={s.key === "exposure" ? 0.1 : 1}
            onChange={(v) => setParam(s.key, v)}
            onCommit={() => commitEdit(s.label)}
          />
        ))}
      </div>
    </Panel>
  );
}
