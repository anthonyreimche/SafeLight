// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.export.renderPhotos as extensions get it. Its settings merge over the
// persisted defaults, except that a PNG is 8-bit unless the caller asks: the
// 16-bit path is slow and large, and the extensions that render PNGs decode
// them straight back to 8 bits. In the dom project because host.tsx's import
// graph reaches stores that expect a window.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeScopedAPI } from "./host";
import * as exportImage from "@/modules/export/export-image";
import type { ExportSettings } from "@/modules/export/export-image";
import { updateSettings } from "@/state/settings-store";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

let rendered: ExportSettings[];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
  rendered = [];
  vi.spyOn(exportImage, "renderPhotosToBlobs").mockImplementation(async (_photos, settings) => {
    rendered.push(settings);
    return [];
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function renderWith(settings?: Partial<ExportSettings>): Promise<ExportSettings> {
  await makeScopedAPI("ext.render").export.renderPhotos([], settings);
  // A render that never reached the spy proves nothing about what it was given.
  expect(rendered).toHaveLength(1);
  return rendered[0];
}

describe("api.export.renderPhotos and the PNG bit depth", () => {
  it("renders a PNG at 8 bits when the Preference says 16", async () => {
    updateSettings({ exportPngBitDepth: 16 });
    expect((await renderWith({ format: "image/png" })).pngBitDepth).toBe(8);
  });

  it("renders a PNG at 8 bits when the caller passes no settings and the Preference says 16", async () => {
    updateSettings({ exportFormat: "image/png", exportPngBitDepth: 16 });
    expect((await renderWith()).pngBitDepth).toBe(8);
  });

  it("renders a 16-bit PNG when the caller asks for one", async () => {
    updateSettings({ exportPngBitDepth: 8 });
    expect((await renderWith({ format: "image/png", pngBitDepth: 16 })).pngBitDepth).toBe(16);
  });

  it("lets the caller say 8 explicitly", async () => {
    updateSettings({ exportPngBitDepth: 16 });
    expect((await renderWith({ format: "image/png", pngBitDepth: 8 })).pngBitDepth).toBe(8);
  });

  it("still takes the other settings from the Preferences, a TIFF's depth among them", async () => {
    updateSettings({ exportPngBitDepth: 16, exportTiffBitDepth: 16, exportQuality: 72 });
    const settings = await renderWith({ format: "image/tiff" });
    expect(settings).toMatchObject({ tiffBitDepth: 16, quality: 0.72, pngBitDepth: 8 });
  });

  it("leaves getDefaultSettings on the Preference, for a caller that reads it", () => {
    updateSettings({ exportPngBitDepth: 16 });
    expect(makeScopedAPI("ext.render").export.getDefaultSettings().pngBitDepth).toBe(16);
  });
});
