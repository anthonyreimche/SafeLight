// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Installing an extension whose id only differs in case from an installed one
// must not land on top of it: Windows and macOS folder names fold case.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstaller } from "./install.cjs";

let root: string;
let pluginsDir: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-install-"));
  pluginsDir = path.join(root, "plugins");
  fs.mkdirSync(pluginsDir);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

type Trust = { repos: string[]; owners: string[]; reason: Record<string, string>; unchecked?: boolean };

function installerFor(id: string, trust: Trust = { repos: [], owners: [], reason: {} }) {
  const manifest = { id, name: "Thing", version: "1.0.0", main: "index.js" };
  const files = [
    { name: "safelight.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "index.js", data: Buffer.from("export {};") },
  ];
  return createInstaller({
    pluginsDir: () => pluginsDir,
    pluginWorkDir: () => path.join(root, "work"),
    appVersion: () => "3.0.0",
    fetchTrustList: async () => trust,
    registryVersionsFor: async () => undefined,
    releases: {
      fetchTarballFiles: async () => files,
      fetchBuffer: async () => Buffer.alloc(0),
      releaseLists: { get: async () => [] },
    },
  } as never);
}

describe("installPlugin id case", () => {
  it("refuses an id that only differs in case from an installed folder", async () => {
    fs.mkdirSync(path.join(pluginsDir, "Acme.Tool"));
    await expect(installerFor("acme.tool").installPlugin("o/r#main")).rejects.toThrow(
      /Acme\.Tool/,
    );
    expect(fs.readdirSync(pluginsDir)).toEqual(["Acme.Tool"]);
  });

  it("still installs over the same id", async () => {
    fs.mkdirSync(path.join(pluginsDir, "acme.tool"));
    const manifest = await installerFor("acme.tool").installPlugin("o/r#main");
    expect(manifest.id).toBe("acme.tool");
  });

  it("installs when the plugins folder does not exist yet", async () => {
    fs.rmSync(pluginsDir, { recursive: true });
    const manifest = await installerFor("acme.tool").installPlugin("o/r#main");
    expect(manifest.id).toBe("acme.tool");
  });
});

describe("uninstallPlugin", () => {
  it("also removes an update still waiting to be settled", async () => {
    const installer = installerFor("acme.tool");
    await installer.installPlugin("o/r#main");
    await installer.installPlugin("o/r#main");
    expect(fs.existsSync(path.join(root, "work", "acme.tool", "prev"))).toBe(true);
    await installer.uninstallPlugin("acme.tool");
    expect(fs.existsSync(path.join(pluginsDir, "acme.tool"))).toBe(false);
    expect(fs.existsSync(path.join(root, "work", "acme.tool"))).toBe(false);
  });

  it("refuses a bad id", async () => {
    await expect(installerFor("acme.tool").uninstallPlugin("../x")).rejects.toThrow(
      "Bad extension id",
    );
  });
});

// A first launch that can't reach the trust registry has no blocklist at all,
// so only Safelight's own extensions can be checked without it.
describe("installPlugin before the blocklist was ever fetched", () => {
  const unchecked: Trust = { repos: [], owners: [], reason: {}, unchecked: true };

  it("refuses a third-party repo and writes nothing", async () => {
    await expect(installerFor("acme.tool", unchecked).installPlugin("acme/tool#main")).rejects.toThrow(
      /only official extensions/,
    );
    expect(fs.readdirSync(pluginsDir)).toEqual([]);
  });

  it("installs an official repo, by its name or an alias", async () => {
    expect((await installerFor("acme.tool", unchecked).installPlugin("AnthonyReimche/crop#main")).id).toBe("acme.tool");
    expect(
      (await installerFor("acme.tool", unchecked).installPlugin("anthonyreimche/crop-and-straighten#main")).id,
    ).toBe("acme.tool");
  });

  it("installs a third-party repo once the blocklist is known", async () => {
    expect((await installerFor("acme.tool").installPlugin("acme/tool#main")).id).toBe("acme.tool");
  });
});
