// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { updateSettings, useSettings } from "@/state/settings-store";
import { COLOR_SPACES } from "@/rendering/color-space";
import { ResolutionControl } from "@/modules/export/ResolutionControl";
import { Select } from "@/ui/components/Select";
import { Field, OptionRow, SliderField, ToggleField } from "@/ui/preferences/fields";
import { settings, type PrefSection } from "@/ui/preferences/section-model";

export function ExportSection() {
  const s = useSettings();
  return (
    <div className="flex flex-col gap-4">
      <Field label="Default format">
        <OptionRow
          value={s.exportFormat}
          options={[
            { value: "image/jpeg", label: "JPEG" },
            { value: "image/png", label: "PNG" },
            { value: "image/webp", label: "WebP" },
            { value: "image/tiff", label: "TIFF" },
          ]}
          onChange={(v) =>
            updateSettings({
              exportFormat: v as typeof s.exportFormat,
            })
          }
        />
      </Field>
      <Field
        label="TIFF bit depth"
        hint="16-bit preserves the full editing precision (best for further work or print); 8-bit is smaller and universally compatible."
      >
        <OptionRow
          value={s.exportTiffBitDepth}
          options={[
            { value: 8, label: "8-bit" },
            { value: 16, label: "16-bit" },
          ]}
          onChange={(v) =>
            updateSettings({ exportTiffBitDepth: v as 8 | 16 })
          }
        />
      </Field>
      <Field
        label="PNG bit depth"
        hint="16-bit keeps the full editing precision, but the files are large and slow to encode, and most viewers show them as 8-bit."
      >
        <OptionRow
          value={s.exportPngBitDepth}
          options={[
            { value: 8, label: "8-bit" },
            { value: 16, label: "16-bit" },
          ]}
          onChange={(v) =>
            updateSettings({ exportPngBitDepth: v as 8 | 16 })
          }
        />
      </Field>

      <SliderField
        label="Default quality"
        value={s.exportQuality}
        min={10}
        max={100}
        step={1}
        format={(v) => String(v)}
        onChange={(v) => updateSettings({ exportQuality: v })}
      />
      <Field label="Default resolution">
        <ResolutionControl
          variant="preferences"
          value={s.exportLongEdge}
          onChange={(v) => updateSettings({ exportLongEdge: v })}
        />
      </Field>
      <Field
        label="Color space"
        hint="Output profile. Pixels are converted and the matching ICC profile is embedded so other apps read the colors correctly. sRGB suits the web; Adobe RGB / ProPhoto keep a wider gamut for print."
      >
        <Select
          value={s.exportColorSpace}
          onChange={(v) =>
            updateSettings({ exportColorSpace: v as typeof s.exportColorSpace })
          }
          ariaLabel="Color space"
          className="w-full"
          options={COLOR_SPACES.map((c) => ({ value: c.value, label: c.label }))}
        />
      </Field>
      <ToggleField
        label="Include metadata"
        hint="Copy the photo's EXIF (camera, lens, exposure, capture date) into exported files so other apps can read it."
        checked={s.exportIncludeMetadata}
        onChange={(v) => updateSettings({ exportIncludeMetadata: v })}
      />
      {s.exportIncludeMetadata && (
        <ToggleField
          label="Include location (GPS)"
          hint="Keep GPS position tags in exports. Off strips location so shared photos don't reveal where they were taken."
          checked={s.exportIncludeLocation}
          onChange={(v) => updateSettings({ exportIncludeLocation: v })}
        />
      )}
      <ToggleField
        label="Bundle multiple photos as ZIP"
        checked={s.exportBundle}
        onChange={(v) => updateSettings({ exportBundle: v })}
      />
      <p className="text-[10px] leading-relaxed text-text-muted">
        These set the Export panel's starting values; you can still change them
        per export.
      </p>
    </div>
  );
}

export const exportSection: PrefSection = {
  id: "Export",
  label: "Export",
  group: "General",
  items: settings(
    "Default format",
    "TIFF bit depth",
    "PNG bit depth",
    "Default quality",
    "Default resolution",
    "Color space",
    "Bundle multiple photos as ZIP",
  ),
  keywords: ["tiff", "png"],
  render: () => <ExportSection />,
};
