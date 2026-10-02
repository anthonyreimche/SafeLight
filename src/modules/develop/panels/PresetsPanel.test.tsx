// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Presets panel import feedback: a file nothing can read must say why in the
// panel rather than doing nothing, and a missing importer points at the
// Extensions store. The seams are the file picker (the hidden input's click)
// and the Electron bridge the store reads; the importer registry is real.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The develop store's mutations broadcast to sibling windows; that side effect
// is not under test and needs no BroadcastChannel here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams } from "@/catalog/types";
import { registerPresetImporter, unregisterExtension } from "@/extensions/registry";
import { useExtStoreUI } from "@/extensions/store-ui";
import type { PresetImporterContribution } from "@/extensions/types";
import { useDevelopStore } from "@/state/develop-store";
import { usePresetsStore } from "@/state/presets-store";
import { closeExtensions, ExtensionsDialog } from "@/ui/components/ExtensionsDialog";
import { PresetsPanel } from "./PresetsPanel";

const IMPORTER_EXT = "test.lightroom";
const NO_XMP_IMPORTER = "No installed extension can import .xmp presets.";

const xmp = (name = "Warm Matte.xmp") =>
  new File(["<x:xmpmeta/>"], name, { type: "application/rdf+xml" });

// pickPresetFile clicks a detached file input; jsdom opens no dialog, so answer
// the click as the OS picker would: set the chosen file and fire change.
function choosing(file: File) {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (
    this: HTMLInputElement,
  ) {
    Object.defineProperty(this, "files", { value: [file], configurable: true });
    this.dispatchEvent(new Event("change"));
  });
}

function installImporter(parse: PresetImporterContribution["parse"]) {
  registerPresetImporter(IMPORTER_EXT, {
    id: `${IMPORTER_EXT}.xmp`,
    label: "Lightroom preset (.xmp)",
    extensions: [".xmp"],
    parse,
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sl_panel_Presets", "1");
  const params = normalizeParams(undefined);
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
  });
  usePresetsStore.setState({ presets: [] });
  useExtStoreUI.setState({ category: "All" });
  vi.stubGlobal("safelightNative", { plugins: { list: async () => [] } });
});

afterEach(() => {
  closeExtensions();
  unregisterExtension(IMPORTER_EXT);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const importFile = async (user: ReturnType<typeof userEvent.setup>, file: File) => {
  choosing(file);
  await user.click(screen.getByRole("button", { name: "Import" }));
};

describe("PresetsPanel import feedback", () => {
  it("explains a file type no extension imports and opens the store on Presets", async () => {
    const user = userEvent.setup();
    render(
      <>
        <PresetsPanel />
        <ExtensionsDialog />
      </>,
    );
    await importFile(user, xmp());

    await screen.findByText(NO_XMP_IMPORTER);
    await user.click(screen.getByRole("button", { name: "Browse importers" }));

    const store = await screen.findByRole("dialog", { name: "Extensions" });
    const chip = within(store).getByRole("button", { name: "Presets" });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
  });

  it("says so when the importer finds no develop settings, saving nothing", async () => {
    installImporter(async () => null);
    const user = userEvent.setup();
    render(<PresetsPanel />);
    await importFile(user, xmp());

    await screen.findByText("Couldn't find any develop settings in “Warm Matte.xmp”.");
    expect(usePresetsStore.getState().presets).toEqual([]);
  });

  it("says so when a .json file isn't a Safelight preset", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    await importFile(user, new File(["{}"], "look.json", { type: "application/json" }));

    await screen.findByText("“look.json” isn't a Safelight preset this version can read.");
  });

  it("clears the message once an import succeeds", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    await importFile(user, xmp());
    await screen.findByText(NO_XMP_IMPORTER);

    installImporter(async () => ({ name: "Warm Matte", params: { exposure: 0.35 } }));
    await importFile(user, xmp());

    await screen.findByRole("button", { name: "Warm Matte" });
    expect(screen.queryByText(NO_XMP_IMPORTER)).toBeNull();
    expect(useDevelopStore.getState().params.exposure).toBe(0.35);
  });

  it("dismisses the message", async () => {
    const user = userEvent.setup();
    render(<PresetsPanel />);
    await importFile(user, xmp());

    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(NO_XMP_IMPORTER)).toBeNull();
  });
});
