// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { updateSettings, useSettings } from "@/state/settings-store";
import { Field, OptionRow, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

export function PerformanceSection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Develop render resolution"
        hint="Cap of the Develop render buffer. Higher keeps 100% zoom true 1:1 on large sensors but uses more GPU memory. Applies when a photo is reopened."
      >
        <OptionRow
          value={s.developMaxEdge}
          options={[
            { value: 4096, label: "4096 px" },
            { value: 6144, label: "6144 px" },
            { value: 8192, label: "8192 px" },
          ]}
          onChange={(v) =>
            updateSettings({ developMaxEdge: v as 4096 | 6144 | 8192 })
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
    "Develop render resolution",
    "Open photos at",
    "GPU source cache",
    "Prefetch neighbours",
    "High bit-depth previews",
    "Live histogram",
  ),
  keywords: [],
  render: () => <PerformanceSection />,
};
