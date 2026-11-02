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

function installerFor(id: string) {
  const manifest = { id, name: "Thing", version: "1.0.0", main: "index.js" };
  const files = [
    { name: "safelight.json", data: Buffer.from(JSON.stringify(manifest)) },
    { name: "index.js", data: Buffer.from("export {};") },
  ];
  return createInstaller({
    pluginsDir: () => pluginsDir,
    pluginWorkDir: () => path.join(root, "work"),
    appVersion: () => "3.0.0",
    fetchTrustList: async () => ({ repos: [], owners: [], reason: {} }),
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
