// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Preferences ▸ File formats: each format lists the decoders that read it in the
// order they are tried; the person moves them, and a move that changes what a
// format decodes with rebuilds that format's grid previews.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const h = vi.hoisted(() => ({ rebuilt: [] as string[] }));

vi.mock("@/modules/library/format-rebuild", () => ({
  rebuildFormatPreviews: (formatId: string) => h.rebuilt.push(formatId),
}));

const { dropImageDecoders, registerImageDecoder } = await import("@/catalog/image-decoders");
const { getSettings, updateSettings } = await import("@/state/settings-store");
const { fileFormatsSection } = await import("./FileFormats");
const { setExtensionName } = await import("@/extensions/param-registry");

const decode = () => Promise.resolve(null);

function register(extensionId: string, label: string, extensions: string[]): void {
  act(() => registerImageDecoder(extensionId, { id: "d", label, extensions, decode }));
}

const renderSection = () => render(<>{fileFormatsSection.render("")}</>);

const row = (name: string): HTMLElement => screen.getByRole("group", { name });

beforeEach(() => {
  h.rebuilt = [];
  updateSettings({ decoderOrder: {} });
});

afterEach(() => {
  act(() => {
    dropImageDecoders("ext.a");
    dropImageDecoders("ext.b");
  });
});

describe("File formats", () => {
  it("lists every standard format with its extensions and the built-in decoder", () => {
    renderSection();
    for (const name of ["JPEG", "PNG", "WebP", "AVIF", "TIFF", "NetPBM", "HEIC / HEIF"]) {
      expect(within(row(name)).getByText("Built-in")).toBeTruthy();
    }
    expect(within(row("HEIC / HEIF")).getByText(".heic .heif .hif")).toBeTruthy();
  });

  it("explains that decoders are tried top to bottom", () => {
    renderSection();
    expect(screen.getByText(/tried from the top down/i)).toBeTruthy();
  });

  it("shows no controls for a format with one decoder", () => {
    renderSection();
    expect(within(row("PNG")).queryAllByRole("button")).toEqual([]);
  });

  it("leaves RAW formats out while only the built-in decoder reads them", () => {
    renderSection();
    expect(screen.queryByText("RAW")).toBeNull();
    expect(screen.queryByRole("group", { name: "NEF" })).toBeNull();
  });

  it("lists a RAW format an extension claims, under a RAW heading", () => {
    register("ext.a", "Fast NEF", [".nef"]);
    renderSection();
    expect(screen.getByText("RAW")).toBeTruthy();
    expect(within(row("NEF")).getByText("Fast NEF")).toBeTruthy();
    expect(screen.getByText(/other RAW formats use the built-in decoder/i)).toBeTruthy();
  });

  it("marks the first of several decoders and lists them in order", () => {
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    const items = within(row("HEIC / HEIF")).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringMatching(/Built-in.*Tried first/),
      expect.stringMatching(/Ext A/),
    ]);
  });

  it("picks up a decoder that registers while it is open", () => {
    renderSection();
    expect(within(row("HEIC / HEIF")).queryByText("Ext A")).toBeNull();
    register("ext.a", "Ext A", [".heic"]);
    expect(within(row("HEIC / HEIF")).getByText("Ext A")).toBeTruthy();
  });

  it("disables Move up on the first and Move down on the last", () => {
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    const heif = row("HEIC / HEIF");
    expect(within(heif).getByRole("button", { name: "Move Built-in up in HEIC / HEIF" })).toHaveProperty("disabled", true);
    expect(within(heif).getByRole("button", { name: "Move Ext A down in HEIC / HEIF" })).toHaveProperty("disabled", true);
  });

  it("saves the full order on a move, and rebuilds when what the format decodes with changed", async () => {
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    await userEvent.click(within(row("HEIC / HEIF")).getByRole("button", { name: "Move Ext A up in HEIC / HEIF" }));
    expect(getSettings().decoderOrder).toEqual({ heif: ["ext.a/d", "heif"] });
    expect(h.rebuilt).toEqual(["heif"]);
  });

  it("keeps the place of a saved decoder whose extension is off", async () => {
    register("ext.b", "Ext B", [".heic"]);
    updateSettings({ decoderOrder: { heif: ["ext.a/d", "heif", "ext.b/d"] } });
    renderSection();
    await userEvent.click(within(row("HEIC / HEIF")).getByRole("button", { name: "Move Ext B up in HEIC / HEIF" }));
    expect(getSettings().decoderOrder.heif).toEqual(["ext.a/d", "ext.b/d", "heif"]);
  });

  it("names the extension each of its decoders comes from", () => {
    setExtensionName("ext.a", "Speedy HEIC");
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    expect(within(row("HEIC / HEIF")).getByText("Speedy HEIC")).toBeTruthy();
  });

  it("does not rebuild when the move leaves the signature as it was", async () => {
    register("ext.a", "Ext A", [".heic"]);
    register("ext.b", "Ext B", [".heic"]);
    renderSection();
    await userEvent.click(within(row("HEIC / HEIF")).getByRole("button", { name: "Move Ext B up in HEIC / HEIF" }));
    expect(getSettings().decoderOrder.heif).toEqual(["heif", "ext.b/d", "ext.a/d"]);
    expect(h.rebuilt).toEqual([]);
  });

  it("keeps focus on the moved decoder's button", async () => {
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    const heif = row("HEIC / HEIF");
    await userEvent.click(within(heif).getByRole("button", { name: "Move Ext A up in HEIC / HEIF" }));
    expect(document.activeElement).toBe(within(heif).getByRole("button", { name: "Move Ext A down in HEIC / HEIF" }));
  });

  it("resets a saved order, and offers Reset only while one is saved", async () => {
    register("ext.a", "Ext A", [".heic"]);
    renderSection();
    const heif = row("HEIC / HEIF");
    expect(within(heif).queryByRole("button", { name: "Reset HEIC / HEIF order" })).toBeNull();
    await userEvent.click(within(heif).getByRole("button", { name: "Move Ext A up in HEIC / HEIF" }));
    h.rebuilt = [];
    await userEvent.click(within(heif).getByRole("button", { name: "Reset HEIC / HEIF order" }));
    expect(getSettings().decoderOrder).toEqual({});
    expect(h.rebuilt).toEqual(["heif"]);
    expect(within(heif).queryByRole("button", { name: "Reset HEIC / HEIF order" })).toBeNull();
  });

  it("is a section of General that the header search finds", () => {
    expect(fileFormatsSection.group).toBe("General");
    expect(fileFormatsSection.items.map((i) => i.label)).toContain("HEIC / HEIF");
  });
});
