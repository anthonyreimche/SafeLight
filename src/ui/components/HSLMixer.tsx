import { useState } from "react";
import { Slider } from "@/ui/components/Slider";
import { HSL_CHANNELS } from "@/catalog/types";
import type { HSLAdjustments, HSLBand, HSLChannel } from "@/catalog/types";

const BANDS: { key: HSLBand; label: string }[] = [
  { key: "hue", label: "Hue" },
  { key: "saturation", label: "Sat" },
  { key: "luminance", label: "Lum" },
];

export const HSL_CHANNEL_COLORS: Record<HSLChannel, string> = {
  red: "#e74c3c",
  orange: "#e67e22",
  yellow: "#f1c40f",
  green: "#2ecc71",
  aqua: "#1abc9c",
  blue: "#3498db",
  purple: "#9b59b6",
  magenta: "#e84393",
};

export interface HSLMixerProps {
  value: HSLAdjustments;
  onChange: (band: HSLBand, channel: HSLChannel, value: number) => void;
  onCommit: (channel: HSLChannel) => void;
  // Controlled band selection (for syncing with picker)
  selectedBand?: HSLBand;
  onBandChange?: (band: HSLBand) => void;
}

// Controlled 8-band hue/sat/lum mixer. Shared by the global HSL panel and
// per-mask HSL sub-panels; state lives with the caller.
export function HSLMixer({ value, onChange, onCommit, selectedBand, onBandChange }: HSLMixerProps) {
  const [internalBand, setInternalBand] = useState<HSLBand>("hue");
  const band = selectedBand ?? internalBand;
  const setBand = onBandChange ?? setInternalBand;

  return (
    <>
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
              style={{ background: HSL_CHANNEL_COLORS[channel] }}
            />
            <div className="flex-1">
              <Slider
                label=""
                value={value[band][channel]}
                min={-100}
                max={100}
                onChange={(v) => onChange(band, channel, v)}
                onCommit={() => onCommit(channel)}
              />
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
