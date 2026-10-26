// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ Export keeps a default bit depth for each format that has one,
// TIFF's and PNG's, in the same 8/16 buttons. Each seeds the Export panel
// whenever its format is picked there, so both show whatever the default
// format is, and a search for either finds it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { updateSettings, useSettings, type AppSettings } from "@/state/settings-store";
import { openPreferences, PreferencesDialog } from "./PreferencesDialog";

class SilentChannel {
  postMessage(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("BroadcastChannel", SilentChannel);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function showExport(prefs: Partial<AppSettings>) {
  updateSettings(prefs);
  render(<PreferencesDialog />);
  act(() => openPreferences("Export"));
}

// A field's controls: its label's parent holds the label, the buttons and the hint.
const field = (label: string) => within(screen.getByText(label).parentElement as HTMLElement);
const pressed = (label: string, depth: string) =>
  field(label).getByRole("button", { name: depth }).getAttribute("aria-pressed");

describe("Preferences ▸ Export bit depth", () => {
  it.each([
    ["JPEG", "image/jpeg"],
    ["WebP", "image/webp"],
    ["PNG", "image/png"],
    ["TIFF", "image/tiff"],
  ] as const)("shows both defaults when %s is the default format", (_name, exportFormat) => {
    showExport({ exportFormat });
    expect(screen.queryByText("TIFF bit depth")).not.toBeNull();
    expect(screen.queryByText("PNG bit depth")).not.toBeNull();
  });

  it("shows each format's stored depth, whatever the default format is", () => {
    showExport({ exportFormat: "image/jpeg", exportPngBitDepth: 8, exportTiffBitDepth: 16 });
    expect(pressed("PNG bit depth", "8-bit")).toBe("true");
    expect(pressed("PNG bit depth", "16-bit")).toBe("false");
    expect(pressed("TIFF bit depth", "8-bit")).toBe("false");
    expect(pressed("TIFF bit depth", "16-bit")).toBe("true");
  });

  it("saves a 16-bit PNG default without touching TIFF's", async () => {
    showExport({ exportFormat: "image/jpeg", exportPngBitDepth: 8, exportTiffBitDepth: 16 });
    await userEvent.click(field("PNG bit depth").getByRole("button", { name: "16-bit" }));

    expect(useSettings.getState().exportPngBitDepth).toBe(16);
    expect(useSettings.getState().exportTiffBitDepth).toBe(16);

    await userEvent.click(field("PNG bit depth").getByRole("button", { name: "8-bit" }));
    expect(useSettings.getState().exportPngBitDepth).toBe(8);
    expect(useSettings.getState().exportTiffBitDepth).toBe(16);
  });

  it("saves an 8-bit TIFF default without touching PNG's", async () => {
    showExport({ exportFormat: "image/png", exportPngBitDepth: 16, exportTiffBitDepth: 16 });
    await userEvent.click(field("TIFF bit depth").getByRole("button", { name: "8-bit" }));

    expect(useSettings.getState().exportTiffBitDepth).toBe(8);
    expect(useSettings.getState().exportPngBitDepth).toBe(16);
  });

  it("finds the PNG default by search when the default format is JPEG", async () => {
    showExport({ exportFormat: "image/jpeg" });
    await userEvent.type(screen.getByRole("textbox", { name: "Search settings" }), "png");
    expect(screen.queryByText("PNG bit depth")).not.toBeNull();
  });

  it("says why 16-bit is not the default for a PNG", () => {
    showExport({ exportFormat: "image/png" });
    expect(screen.getByText(/large and slow to encode/)).not.toBeNull();
  });
});
