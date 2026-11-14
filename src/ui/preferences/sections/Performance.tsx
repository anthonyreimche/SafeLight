// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useState } from "react";
import { readWebGLInfo } from "@/diagnostics/environment";
import { integratedGpuLead, integratedGpuName } from "@/diagnostics/integrated-gpu";
import { updateSettings, useSettings, type AppSettings } from "@/state/settings-store";
import { btnCls, Field, OptionRow, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

type DevelopMaxEdge = AppSettings["developMaxEdge"];
type RenderResolution = DevelopMaxEdge | "dynamic";

// Graphics that share the processor's memory pay for every full-size target
// Develop draws through: a smaller render buffer, a smaller GPU cache, no
// background decode of the next photo and a histogram that waits for edits to
// settle.
const INTEGRATED_GRAPHICS = {
  developMaxEdge: 2560,
  developDynamicDetail: false,
  gpuSourceCacheBytes: 256 * 1024 * 1024,
  developPrefetchNeighbors: false,
  liveHistogram: false,
} satisfies Partial<AppSettings>;

function IntegratedGraphicsField() {
  const s = useSettings();
  // Once per mount: the probe makes a WebGL context, so not on every re-render.
  const [found] = useState(() => {
    const renderer = readWebGLInfo()?.renderer;
    return renderer ? integratedGpuName(renderer) : null;
  });
  const inUse = (Object.keys(INTEGRATED_GRAPHICS) as (keyof typeof INTEGRATED_GRAPHICS)[]).every(
    (k) => s[k] === INTEGRATED_GRAPHICS[k],
  );
  const lead = integratedGpuLead(found);
  return (
    <Field
      label="Integrated graphics"
      hint={`${lead}Sets a 2560 px render resolution, a 256 MB GPU source cache, no neighbour prefetch and a histogram that updates once edits settle. 100% zoom is softer on large sensors, and wide effects from some extensions can look slightly different.`}
    >
      <div className="flex items-center gap-2">
        <button className={`${btnCls} disabled:cursor-default disabled:opacity-45`} disabled={inUse} onClick={() => updateSettings(INTEGRATED_GRAPHICS)}>
          Use integrated graphics settings
        </button>
        {inUse && <span className="text-[10px] text-text-secondary">In use.</span>}
      </div>
    </Field>
  );
}

export function PerformanceSection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <IntegratedGraphicsField />
      <Field
        label="Develop render resolution"
        hint="Cap of the Develop render buffer. Higher keeps more detail when zoomed in but uses more GPU memory; lower is faster on integrated graphics. Dynamic keeps a 4096 px buffer, measures zoom against the photo's own pixels (100% is one photo pixel per screen pixel) and, for RAW photos, sharpens the area in view from the original when you zoom in past the buffer, at the cost of one more decode per photo and extra memory while it is open. A size applies when a photo is reopened; Dynamic's zoom scale applies at once."
      >
        <OptionRow<RenderResolution>
          value={s.developDynamicDetail ? "dynamic" : s.developMaxEdge}
          options={[
            { value: 2560, label: "2560 px" },
            { value: 3072, label: "3072 px" },
            { value: 4096, label: "4096 px" },
            { value: 6144, label: "6144 px" },
            { value: 8192, label: "8192 px" },
            { value: "dynamic", label: "Dynamic" },
          ]}
          onChange={(v) =>
            updateSettings(
              v === "dynamic"
                ? { developDynamicDetail: true, developMaxEdge: 4096 }
                : { developDynamicDetail: false, developMaxEdge: v },
            )
          }
        />
      </Field>
      <Field
        label="Open photos at"
        hint="Zoom a photo opens at in Develop. Fit shows the whole frame; 100% opens at 1:1 (pixel-accurate)."
      >
        <OptionRow
          value={s.developOpenZoom}
          options={[
            { value: "fit", label: "Fit" },
            { value: "100", label: "100%" },
          ]}
          onChange={(v) =>
            updateSettings({ developOpenZoom: v as "fit" | "100" })
          }
        />
      </Field>
      <Field
        label="GPU source cache"
        hint="GPU memory budget for resident decoded RAW sources. Larger keeps more photos ready for instant re-open and crisp zoom; least-recently-used sources are evicted past the budget."
      >
        <OptionRow
          value={s.gpuSourceCacheBytes}
          options={[
            { value: 256 * 1024 * 1024, label: "256 MB" },
            { value: 512 * 1024 * 1024, label: "512 MB" },
            { value: 1024 * 1024 * 1024, label: "1 GB" },
            { value: 2048 * 1024 * 1024, label: "2 GB" },
          ]}
          onChange={(v) => updateSettings({ gpuSourceCacheBytes: v })}
        />
      </Field>
      <ToggleField
        label="Prefetch neighbours"
        hint="While editing a photo, background-decode the previous/next photo so stepping to it is instant. Off saves CPU/VRAM at the cost of a short decode on each step."
        checked={s.developPrefetchNeighbors}
        onChange={(v) => updateSettings({ developPrefetchNeighbors: v })}
      />
      <ToggleField
        label="High bit-depth previews"
        hint="Smoother gradients on graphics cards that support it, for photos that still use the older processing and have heal or clone spots. Turn off to use less graphics memory on those photos. Applies after you restart Safelight."
        checked={s.highBitDepth}
        onChange={(v) => updateSettings({ highBitDepth: v })}
      />
      <ToggleField
        label="Live histogram"
        hint="Update the histogram on every frame while dragging sliders. Off recomputes it after edits settle — slightly smoother on slow machines."
        checked={s.liveHistogram}
        onChange={(v) => updateSettings({ liveHistogram: v })}
      />
    </div>
  );
}

export const performanceSection: PrefSection = {
  id: "Performance",
  label: "Performance",
  group: "General",
  items: settings(
    "Integrated graphics",
    "Develop render resolution",
    "Open photos at",
    "GPU source cache",
    "Prefetch neighbours",
    "High bit-depth previews",
    "Live histogram",
  ),
  keywords: ["integrated graphics", "slow", "gpu memory", "laptop", "dynamic", "zoom"],
  render: () => <PerformanceSection />,
};
