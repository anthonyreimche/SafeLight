// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { AutoButton } from "@/ui/components/AutoButton";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import { useAutoAdjust } from "@/hooks/use-auto-adjust";
import type { DevelopParams } from "@/catalog/types";

type NumericParamKey = {
  [K in keyof DevelopParams]: DevelopParams[K] extends number ? K : never;
}[keyof DevelopParams];

// Per-band detail sliders are opt-in (Preferences ▸ Interface) to keep the panel
// compact. Tone recovery/lift preserves micro-contrast on its own regardless;
// these only expose manual control over it.
const DETAIL_KEYS = new Set<NumericParamKey>(["highlightDetail", "shadowDetail"]);

const basicSliders: {
  key: NumericParamKey;
  label: string;
  min: number;
  max: number;
  // Slider-icon contribution id; defaults to `core.${key}`. The per-band detail
  // sliders borrow their parent band's icon so they read as a sub-control.
  icon?: string;
}[] = [
  { key: "exposure", label: "Exposure", min: -5, max: 5 },
  { key: "contrast", label: "Contrast", min: -100, max: 100 },
  { key: "highlights", label: "Highlights", min: -100, max: 100 },
  { key: "highlightDetail", label: "Highlight Detail", min: -100, max: 100, icon: "core.highlights" },
  { key: "shadows", label: "Shadows", min: -100, max: 100 },
  { key: "shadowDetail", label: "Shadow Detail", min: -100, max: 100, icon: "core.shadows" },
  { key: "whites", label: "Whites", min: -100, max: 100 },
  { key: "blacks", label: "Blacks", min: -100, max: 100 },
  { key: "texture", label: "Texture", min: -100, max: 100 },
  { key: "clarity", label: "Clarity", min: -100, max: 100 },
  { key: "dehaze", label: "Dehaze", min: -100, max: 100 },
  { key: "vibrance", label: "Vibrance", min: -100, max: 100 },
  { key: "saturation", label: "Saturation", min: -100, max: 100 },
];

export function BasicPanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);
  const histogram = useDevelopStore((s) => s.histogram);
  const showDetail = useSettings((s) => s.basicDetailSliders);
  const { autoTone } = useAutoAdjust();

  const sliders = showDetail
    ? basicSliders
    : basicSliders.filter((s) => !DETAIL_KEYS.has(s.key));

  return (
    <Panel title="Basic">
      <AutoButton onClick={autoTone} disabled={!histogram} title="Auto tone" />
      <div className="space-y-0.5">
        {sliders.map((s) => (
          <Slider
            key={s.key}
            icon={s.icon ?? `core.${s.key}`}
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
