// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for preset serialization and the import-side sanitizer.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DevelopParams } from "@/catalog/types";
import { exportPreset, parseSafelightPreset } from "./preset-io.ts";

interface AnchorStub {
  href: string;
  download: string;
  click: () => void;
}

// exportPreset writes through a download anchor, the one part of this module
// that needs a DOM. Stub the two globals it touches and keep the Blob it hands
// to createObjectURL — that Blob is the preset file.
let anchor: AnchorStub;
let written: Blob[];

beforeEach(() => {
  anchor = { href: "", download: "", click: () => {} };
  written = [];
  vi.stubGlobal("document", { createElement: (): AnchorStub => anchor });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob: Blob | MediaSource) => {
    written.push(blob as Blob);
    return "blob:preset";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function exportedText(): Promise<string> {
  expect(written).toHaveLength(1);
  return written[0].text();
}

async function exportedJSON(): Promise<Record<string, unknown>> {
  return JSON.parse(await exportedText()) as Record<string, unknown>;
}

async function exportedFile(): Promise<File> {
  return new File([written[0]], anchor.download, { type: "application/json" });
}

const presetFile = (json: string, name = "preset.safelight.json"): File =>
  new File([json], name, { type: "application/json" });

describe("exportPreset", () => {
  it("writes a versioned SafeLight preset carrying only the given params", async () => {
    exportPreset("Warm Portrait", { exposure: 0.5, contrast: 20 });
    const data = await exportedJSON();
    expect(data.format).toBe("safelight-preset");
    expect(data.version).toBe(1);
    expect(data.name).toBe("Warm Portrait");
    expect(data.params).toEqual({ exposure: 0.5, contrast: 20 });
  });

  it("names the download from a slugged preset name", async () => {
    exportPreset("Warm Portrait", {});
    expect(anchor.download).toBe("warm-portrait.safelight.json");
    expect(anchor.href).toBe("blob:preset");
  });

  it("falls back to a placeholder slug when the name is empty", async () => {
    exportPreset("", {});
    expect(anchor.download).toBe("preset.safelight.json");
  });

  it("falls back to a placeholder slug when the name has nothing sluggable", async () => {
    for (const name of ["///", "   ", "!!!", "-_-"]) {
      written = [];
      exportPreset(name, {});
      expect(anchor.download).toBe("preset.safelight.json");
    }
  });

  it("keeps a trimmed group and a non-empty paramBag", async () => {
    exportPreset("P", { clarity: 5 }, "  Portraits  ", { "film.grain": 30 });
    const data = await exportedJSON();
    expect(data.group).toBe("Portraits");
    expect(data.paramBag).toEqual({ "film.grain": 30 });
  });

  it("omits a blank group and an empty paramBag", async () => {
    exportPreset("P", { clarity: 5 }, "   ", {});
    const text = await exportedText();
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual([
      "format",
      "version",
      "name",
      "params",
    ]);
  });

  it("emits indented JSON so the file stays hand-editable", async () => {
    exportPreset("P", { clarity: 5 });
    expect(await exportedText()).toContain('\n  "format"');
  });
});

describe("parseSafelightPreset", () => {
  it("round-trips name, group, params and paramBag", async () => {
    const params: Partial<DevelopParams> = {
      exposure: -0.75,
      saturation: 12,
      crop: { x: 0.1, y: 0.2, width: 0.5, height: 0.4 },
    };
    exportPreset("Warm Portrait", params, "Portraits", { "film.grain": 30 });

    const parsed = await parseSafelightPreset(await exportedFile());
    expect(parsed).toEqual({
      name: "Warm Portrait",
      group: "Portraits",
      params,
      paramBag: { "film.grain": 30 },
    });
  });

  it("reports no group or bag when the file carries neither", async () => {
    exportPreset("Plain", { contrast: 4 });
    const parsed = await parseSafelightPreset(await exportedFile());
    expect(parsed?.group).toBeUndefined();
    expect(parsed?.paramBag).toBeUndefined();
  });

  it("falls back to the filename when the name is missing or blank", async () => {
    const bare = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","version":1,"params":{}}', "Sunset.safelight.json"),
    );
    expect(bare?.name).toBe("Sunset");

    const blank = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","name":"   ","params":{}}', "Fallback.json"),
    );
    expect(blank?.name).toBe("Fallback");
  });
});

describe("parseSafelightPreset: version handling", () => {
  it("reads a preset written by this build or an older one", async () => {
    const missing = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","name":"A","params":{"contrast":10}}'),
    );
    expect(missing?.params).toEqual({ contrast: 10 });

    const current = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","version":1,"name":"A","params":{"contrast":10}}'),
    );
    expect(current?.params).toEqual({ contrast: 10 });
  });

  it("ignores a version that is not a number", async () => {
    const parsed = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","version":"1","name":"A","params":{"contrast":10}}'),
    );
    expect(parsed?.params).toEqual({ contrast: 10 });
  });

  it("returns null for a preset written by a newer build", async () => {
    // A v2 file may spell params differently; parsing it as v1 would silently
    // import the wrong look rather than refusing it.
    expect(
      await parseSafelightPreset(
        presetFile('{"format":"safelight-preset","version":2,"name":"A","params":{"contrast":10}}'),
      ),
    ).toBeNull();
    expect(
      await parseSafelightPreset(
        presetFile('{"format":"safelight-preset","version":99,"name":"A","params":{}}'),
      ),
    ).toBeNull();
  });
});

describe("parseSafelightPreset: rejection", () => {
  it("returns null for malformed JSON", async () => {
    expect(await parseSafelightPreset(presetFile("{ not json"))).toBeNull();
    expect(await parseSafelightPreset(presetFile(""))).toBeNull();
  });

  it("returns null for JSON that is not a preset object", async () => {
    expect(await parseSafelightPreset(presetFile("null"))).toBeNull();
    expect(await parseSafelightPreset(presetFile("[1,2,3]"))).toBeNull();
    expect(await parseSafelightPreset(presetFile('"safelight-preset"'))).toBeNull();
  });

  it("returns null for a foreign format so other importers get a turn", async () => {
    expect(
      await parseSafelightPreset(presetFile('{"format":"lightroom-preset","params":{}}')),
    ).toBeNull();
    expect(await parseSafelightPreset(presetFile('{"name":"A","params":{}}'))).toBeNull();
  });
});

describe("parseSafelightPreset: param sanitizing", () => {
  const parseParams = async (paramsJSON: string): Promise<Partial<DevelopParams>> => {
    const parsed = await parseSafelightPreset(
      presetFile(`{"format":"safelight-preset","name":"A","params":${paramsJSON}}`),
    );
    expect(parsed).not.toBeNull();
    return parsed!.params;
  };

  it("drops unknown keys", async () => {
    expect(await parseParams('{"contrast":10,"exposureEV":1,"nonsense":"x"}')).toEqual({
      contrast: 10,
    });
  });

  it("drops scalars that are not finite numbers", async () => {
    // 1e999 is the only way JSON can smuggle in a non-finite number.
    expect(await parseParams('{"exposure":"1.5","contrast":null,"clarity":1e999}')).toEqual({});
  });

  it("keeps zero and negative scalars", async () => {
    expect(await parseParams('{"contrast":0,"saturation":-40}')).toEqual({
      contrast: 0,
      saturation: -40,
    });
  });

  it("gates complex keys on the container kind, not the contents", async () => {
    expect(await parseParams('{"crop":5,"masks":null,"toneCurve":"edited"}')).toEqual({});
    expect(await parseParams('{"masks":[],"crop":{"x":0}}')).toEqual({
      masks: [],
      crop: { x: 0 },
    });
  });

  it("requires uprightMode to be a string", async () => {
    expect(await parseParams('{"uprightMode":3}')).toEqual({});
    expect(await parseParams('{"uprightMode":"guided"}')).toEqual({ uprightMode: "guided" });
  });

  it("yields an empty partial when params is missing or not an object", async () => {
    expect(await parseParams("null")).toEqual({});
    expect(await parseParams("[1,2]")).toEqual({});
    expect(await parseParams('"contrast"')).toEqual({});
    const noParams = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","name":"A"}'),
    );
    expect(noParams?.params).toEqual({});
  });

  it("ignores a paramBag that is not a plain object", async () => {
    const arrayBag = await parseSafelightPreset(
      presetFile('{"format":"safelight-preset","name":"A","params":{},"paramBag":[1]}'),
    );
    expect(arrayBag?.paramBag).toBeUndefined();
  });
});
