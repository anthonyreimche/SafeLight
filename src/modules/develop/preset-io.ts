import type { DevelopParams } from "@/catalog/types";

const PRESET_FORMAT = "safelight-preset";
const PRESET_VERSION = 1;

interface PresetFile {
  format: string;
  version: number;
  name: string;
  /** Optional group/folder this preset belongs to. */
  group?: string;
  /** Only the adjustments the preset carries (partial presets). */
  params: Partial<DevelopParams>;
}

// Export the given params as an open, human-readable JSON preset file.
export function exportPreset(
  name: string,
  params: Partial<DevelopParams>,
  group?: string,
) {
  const data: PresetFile = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name,
    group: group?.trim() || undefined,
    params,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${sanitize(name)}.safelight.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// Open a file picker. `accept` is an input `accept` string (e.g.
// ".json,.xmp"). Returns the chosen file, or null if cancelled.
export function pickPresetFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

// Parse a SafeLight preset JSON file. Returns name + group + the partial params
// it carries, or null if the file isn't a SafeLight preset (so the caller can
// try other importers). Params are kept partial; the caller merges them over the
// photo's current edit when applying.
export async function parseSafelightPreset(file: File): Promise<{
  name: string;
  group?: string;
  params: Partial<DevelopParams>;
} | null> {
  try {
    const parsed = JSON.parse(await file.text()) as Partial<PresetFile>;
    if (parsed.format !== PRESET_FORMAT) return null;
    return {
      name: parsed.name ?? file.name.replace(/\.(safelight\.)?json$/i, ""),
      group: parsed.group,
      params: parsed.params ?? {},
    };
  } catch {
    return null;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "preset";
}
