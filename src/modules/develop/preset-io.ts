import type { DevelopParams } from "@/catalog/types";
import { normalizeParams } from "@/catalog/types";

const PRESET_FORMAT = "safelight-preset";
const PRESET_VERSION = 1;

interface PresetFile {
  format: string;
  version: number;
  name: string;
  params: DevelopParams;
}

// Export the given params as an open, human-readable JSON preset file.
export function exportPreset(name: string, params: DevelopParams) {
  const data: PresetFile = {
    format: PRESET_FORMAT,
    version: PRESET_VERSION,
    name,
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

// Read a preset JSON file chosen by the user. Returns name + normalized params.
export async function importPreset(): Promise<{
  name: string;
  params: DevelopParams;
} | null> {
  const file = await pickJsonFile();
  if (!file) return null;

  const text = await file.text();
  const parsed = JSON.parse(text) as Partial<PresetFile>;

  return {
    name: parsed.name ?? file.name.replace(/\.(safelight\.)?json$/i, ""),
    params: normalizeParams(parsed.params),
  };
}

function pickJsonFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
}

function sanitize(name: string): string {
  return name.replace(/[^a-z0-9-_]+/gi, "-").toLowerCase() || "preset";
}
