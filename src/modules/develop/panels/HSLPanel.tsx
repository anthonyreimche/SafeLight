import { useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import { HSL_CHANNELS } from "@/catalog/types";
import type { HSLBand, HSLChannel } from "@/catalog/types";

const BANDS: { key: HSLBand; label: string }[] = [
  { key: "hue", label: "Hue" },
  { key: "saturation", label: "Sat" },
  { key: "luminance", label: "Lum" },
];

const CHANNEL_COLORS: Record<HSLChannel, string> = {
  red: "#e74c3c",
  orange: "#e67e22",
  yellow: "#f1c40f",
  green: "#2ecc71",
  aqua: "#1abc9c",
  blue: "#3498db",
  purple: "#9b59b6",
  magenta: "#e84393",
};

export function HSLPanel() {
  const [band, setBand] = useState<HSLBand>("hue");
  const params = useDevelopStore((s) => s.params);
  const setHslValue = useDevelopStore((s) => s.setHslValue);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  return (
    <Panel title="HSL / Color">
      <div className="mb-2 flex rounded bg-surface-2">
        {BANDS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBand(b.key)}
            className={`flex-1 py-1 text-[10px] uppercase tracking-wider ${
              band === b.key
                ? "bg-surface-3 text-text-primary"
                : "text-text-muted hover:text-text-secondary"
            } first:rounded-l last:rounded-r`}
          >
            {b.label}
          </button>
        ))}
      </div>

      <div className="space-y-0.5">
        {HSL_CHANNELS.map((channel) => (
          <div key={channel} className="flex items-center gap-1.5">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: CHANNEL_COLORS[channel] }}
            />
            <div className="flex-1">
              <Slider
                label=""
                value={params.hsl[band][channel]}
                min={-100}
                max={100}
                onChange={(v) => setHslValue(band, channel, v)}
                onCommit={() => commitEdit(`HSL ${channel}`)}
              />
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}
