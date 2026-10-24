// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Export panel's bit depth and its ProPhoto warning. TIFF's depth seeds
// from Preferences; PNG's is picked per session and starts at 8, so no PNG
// turns 16-bit unasked. ProPhoto written at 8 bits can band, so the panel says
// so under the format and offers a 16-bit TIFF, without ever blocking export.

import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSettings, type AppSettings } from "@/state/settings-store";
import { ExportPanel } from "./ExportPanel";

const WARNING = "ProPhoto at 8 bits can band in smooth gradients.";
const SEEDED = useSettings.getState();

afterEach(() => {
  useSettings.setState(SEEDED, true);
});

function renderPanel(prefs: Partial<AppSettings>) {
  useSettings.setState(prefs);
  render(<ExportPanel />);
}

const button = (name: string) => screen.getByRole("button", { name });
const pressed = (name: string) => button(name).getAttribute("aria-pressed");
const warning = () => screen.queryByText(WARNING);

describe("the ProPhoto warning", () => {
  it("shows for a ProPhoto JPEG", () => {
    renderPanel({ exportColorSpace: "prophoto-rgb", exportFormat: "image/jpeg" });
    expect(warning()).not.toBeNull();
  });

  it("hides for a ProPhoto 16-bit TIFF", () => {
    renderPanel({ exportColorSpace: "prophoto-rgb", exportFormat: "image/tiff", exportTiffBitDepth: 16 });
    expect(pressed("16-bit")).toBe("true");
    expect(warning()).toBeNull();
  });

  it("hides for an sRGB JPEG", () => {
    renderPanel({ exportColorSpace: "srgb", exportFormat: "image/jpeg" });
    expect(pressed("JPEG")).toBe("true");
    expect(warning()).toBeNull();
  });

  it("switches the export to a 16-bit TIFF from its button", async () => {
    renderPanel({ exportColorSpace: "prophoto-rgb", exportFormat: "image/png", exportTiffBitDepth: 8 });
    await userEvent.click(button("Use 16-bit TIFF"));

    expect(pressed("TIFF")).toBe("true");
    expect(pressed("PNG")).toBe("false");
    expect(pressed("16-bit")).toBe("true");
    expect(warning()).toBeNull();
  });
});

describe("the Bit Depth panel", () => {
  it("shows for PNG at 8 bits even when TIFF's Preference is 16", async () => {
    renderPanel({ exportColorSpace: "prophoto-rgb", exportFormat: "image/png", exportTiffBitDepth: 16 });
    expect(pressed("8-bit")).toBe("true");
    expect(warning()).not.toBeNull();

    await userEvent.click(button("16-bit"));
    expect(pressed("16-bit")).toBe("true");
    expect(warning()).toBeNull();
  });

  it("keeps TIFF's depth and PNG's apart", async () => {
    renderPanel({ exportFormat: "image/tiff", exportTiffBitDepth: 16 });
    expect(pressed("16-bit")).toBe("true");

    await userEvent.click(button("PNG"));
    expect(pressed("8-bit")).toBe("true");

    await userEvent.click(button("JPEG"));
    expect(screen.queryByRole("button", { name: "8-bit" })).toBeNull();

    await userEvent.click(button("TIFF"));
    expect(pressed("16-bit")).toBe("true");
  });
});
