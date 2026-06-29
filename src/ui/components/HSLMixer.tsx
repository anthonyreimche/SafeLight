// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
  // "tabs": one band at a time (Hue|Sat|Lum). "all": every band stacked, the
  // Lightroom "All" layout. Defaults to "tabs".
  view?: "tabs" | "all";
}

// The 8 colour sliders for one band. Shared by the tabbed and "all" layouts.
function BandSliders({
  band,
  value,
  onChange,
  onCommit,
}: {
  band: HSLBand;
  value: HSLAdjustments;
  onChange: HSLMixerProps["onChange"];
  onCommit: HSLMixerProps["onCommit"];
}) {
  return (
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
              ariaLabel={`${channel} ${band}`}
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
  );
}

// Controlled 8-band hue/sat/lum mixer. Shared by the global HSL panel and
// per-mask HSL sub-panels; state lives with the caller.
export function HSLMixer({
  value,
  onChange,
  onCommit,
  selectedBand,
  onBandChange,
  view = "tabs",
}: HSLMixerProps) {
  const [internalBand, setInternalBand] = useState<HSLBand>("hue");
  const band = selectedBand ?? internalBand;
  const setBand = onBandChange ?? setInternalBand;

  if (view === "all") {
    return (
      <div className="space-y-3">
        {BANDS.map((b) => (
          <div key={b.key}>
            <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-text-muted">
              {b.key}
            </div>
            <BandSliders
              band={b.key}
              value={value}
              onChange={onChange}
              onCommit={onCommit}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    <>
      <div className="mb-2 flex rounded bg-surface-2" role="group" aria-label="HSL band">
        {BANDS.map((b) => (
          <button
            key={b.key}
            onClick={() => setBand(b.key)}
            aria-pressed={band === b.key}
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

      <BandSliders
        band={band}
        value={value}
        onChange={onChange}
        onCommit={onCommit}
      />
    </>
  );
}
