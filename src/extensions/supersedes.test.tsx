// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension that replaces others names them in its manifest's `supersedes`.
// While it is installed and on, core turns each listed one off once (never
// uninstalls it) and says so; one the user turns back on stays on. The loader
// runs for real through the stubbed Electron bridge, with only the bundle
// import (an app:// URL jsdom can't fetch) substituted.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import "./host";
import type { ExtensionManifest, ExtensionModule, NativePluginsBridge, SafelightAPI } from "./types";
import { useRegistry } from "./registry";
import { importPluginModule } from "./plugin-module";
import { officialExtension } from "./official-extensions";
import {
  installFromGitHub,
  isPluginRunning,
  loadExternalPlugins,
  setExtensionEnabled,
  uninstallPlugin,
  useDisabledExtensions,
} from "./loader";
import {
  MAX_SUPERSEDES,
  dismissSupersededNotes,
  supersededIds,
  useSupersededNotes,
} from "./supersedes";

vi.mock("./plugin-module", () => ({ importPluginModule: vi.fn() }));

let privilegedBridge: NativePluginsBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedPlugins: () => privilegedBridge,
}));

const BORDER = "opg.border";
const PRINT_MAT = "opg.print-mat";
const FRAME = "opg.mat-frame";

const ext = (id: string, name: string, over: Partial<ExtensionManifest> = {}): ExtensionManifest => ({
  id,
  name,
  version: "1.0.0",
  main: "index.js",
  repository: `opg/${id.split(".")[1]}`,
  ...over,
});
const border = ext(BORDER, "Border");
const printMat = ext(PRINT_MAT, "Print Mat");
const frame = ext(FRAME, "Framing / Border", { supersedes: [BORDER, PRINT_MAT] });

const importer = vi.mocked(importPluginModule);
const idOf = (url: string) => url.split("/__plugins__/")[1].split("/")[0];
const bundle = (id: string): ExtensionModule => ({
  activate: (api: SafelightAPI) => api.registerStylesheet({ id: `${id}.css`, css: ".x{}" }),
});

let list: ExtensionManifest[];
let install: Mock;

beforeEach(() => {
  localStorage.clear();
  list = [border, frame];
  install = vi.fn(async () => frame);
  privilegedBridge = { install, uninstall: vi.fn(async () => {}), settleUpdate: vi.fn(async () => null) };
  vi.stubGlobal("safelightNative", { plugins: { list: async () => list } });
  useRegistry.setState({ stylesheets: {}, modules: {} });
  useDisabledExtensions.setState({ ids: [] });
  useSupersededNotes.setState({ notes: [] });
  importer.mockReset();
  importer.mockImplementation(async (url) => bundle(idOf(url)));
});

afterEach(async () => {
  for (const id of [BORDER, PRINT_MAT, FRAME]) await uninstallPlugin(id);
  vi.unstubAllGlobals();
});

const disabled = () => useDisabledExtensions.getState().ids;
const notes = () => useSupersededNotes.getState().notes;

describe("supersededIds", () => {
  it("keeps the ids listed, without blanks, repeats, its own id or anything but strings", () => {
    const m = ext("acme.next", "Next", {
      supersedes: [" acme.old ", "acme.old", "", "acme.next", 7, null, "other.thing"] as unknown as string[],
    });
    expect(supersededIds(m)).toEqual(["acme.old", "other.thing"]);
  });

  it("is empty when the manifest lists none, or not as a list", () => {
    expect(supersededIds(ext("acme.next", "Next"))).toEqual([]);
    expect(
      supersededIds(ext("acme.next", "Next", { supersedes: "acme.old" as unknown as string[] })),
    ).toEqual([]);
  });

  it("never names Safelight's own ids for an extension that isn't official", () => {
    const m = ext("acme.next", "Next", {
      supersedes: ["core", "core.develop", "safelight.basic", "Safelight.Crop", "acme.old"],
    });
    expect(supersededIds(m)).toEqual(["acme.old"]);
  });

  it("lets an official extension replace another official one", () => {
    const row = officialExtension("safelight.basic");
    if (!row) throw new Error("safelight.basic is not in the official list");
    const m = ext("safelight.basic", "Basic", {
      repository: row.repo,
      supersedes: ["safelight.effects", "core.develop"],
    });
    expect(supersededIds(m)).toEqual(["safelight.effects"]);
  });

  it(`names at most ${MAX_SUPERSEDES}`, () => {
    const ids = Array.from({ length: MAX_SUPERSEDES + 4 }, (_, i) => `acme.old${i}`);
    expect(supersededIds(ext("acme.next", "Next", { supersedes: ids }))).toEqual(
      ids.slice(0, MAX_SUPERSEDES),
    );
  });
});

describe("a successor installed beside what it replaces", () => {
  it("turns the old one off at launch, before it starts, and says so", async () => {
    await loadExternalPlugins();

    expect(disabled()).toContain(BORDER);
    expect(isPluginRunning(BORDER)).toBe(false);
    expect(isPluginRunning(FRAME)).toBe(true);
    expect(importer.mock.calls.map(([url]) => idOf(url))).not.toContain(BORDER);
    expect(notes()).toEqual([{ id: BORDER, name: "Border", by: "Framing / Border" }]);
  });

  it("keeps the old one installed", async () => {
    await loadExternalPlugins();
    expect(privilegedBridge?.uninstall).not.toHaveBeenCalled();
  });

  it("leaves the old one on once the user turns it back on", async () => {
    await loadExternalPlugins();
    await setExtensionEnabled(BORDER, true);
    useSupersededNotes.setState({ notes: [] });

    await loadExternalPlugins();

    expect(disabled()).not.toContain(BORDER);
    expect(isPluginRunning(BORDER)).toBe(true);
    expect(notes()).toEqual([]);
  });

  it("does nothing while the successor is off, and turns the old one off once it is turned on", async () => {
    useDisabledExtensions.setState({ ids: [FRAME] });
    await loadExternalPlugins();
    expect(isPluginRunning(BORDER)).toBe(true);
    expect(notes()).toEqual([]);

    await setExtensionEnabled(FRAME, true);

    expect(disabled()).toContain(BORDER);
    expect(isPluginRunning(BORDER)).toBe(false);
    expect(notes()).toEqual([{ id: BORDER, name: "Border", by: "Framing / Border" }]);
  });

  it("leaves one the user had already turned off alone, with no notice", async () => {
    useDisabledExtensions.setState({ ids: [BORDER] });
    await loadExternalPlugins();
    expect(disabled()).toEqual([BORDER]);
    expect(notes()).toEqual([]);
  });

  it("turns off every listed one installed, in one notice per extension", async () => {
    list = [border, printMat, frame];
    await loadExternalPlugins();
    expect(disabled()).toEqual(expect.arrayContaining([BORDER, PRINT_MAT]));
    expect(notes().map((n) => n.id)).toEqual([BORDER, PRINT_MAT]);
  });
});

describe("installing a successor", () => {
  it("turns off the installed extension it replaces", async () => {
    list = [border];
    await loadExternalPlugins();
    expect(isPluginRunning(BORDER)).toBe(true);

    list = [border, frame];
    await installFromGitHub("opg/mat-frame");

    expect(isPluginRunning(FRAME)).toBe(true);
    expect(isPluginRunning(BORDER)).toBe(false);
    expect(disabled()).toContain(BORDER);
    expect(notes()).toEqual([{ id: BORDER, name: "Border", by: "Framing / Border" }]);
  });

  it("does not turn off one installed after it, which the user chose", async () => {
    list = [frame];
    await loadExternalPlugins();
    list = [frame, border];
    await loadExternalPlugins();
    expect(isPluginRunning(BORDER)).toBe(true);
    expect(notes()).toEqual([]);
  });
});

describe("supersede notices", () => {
  it("are kept for the other windows and the next launch until dismissed", async () => {
    await loadExternalPlugins();
    expect(JSON.parse(localStorage.getItem("sl_ext_superseded_notes") ?? "[]")).toEqual(notes());

    dismissSupersededNotes();

    expect(notes()).toEqual([]);
    expect(JSON.parse(localStorage.getItem("sl_ext_superseded_notes") ?? "[]")).toEqual([]);
  });
});
