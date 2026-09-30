// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The manifests the main process reads at launch for the renderer's
// content-security policy (extension-origins.cjs): installed extensions and
// the Developer Tools dev folder must be read the same way, and only
// well-formed HTTPS origins may ever reach the policy. Runs against temp
// folders; main.cjs only supplies the real paths.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  declaredConnectHosts,
  listDevManifests,
  listInstalledManifests,
  pendingConnectHosts,
  readDevFolder,
  writeDevFolder,
} from "./extension-origins.cjs";

let root: string;

const manifest = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  version: "1.0.0",
  main: "index.js",
  ...extra,
});
const network = (...origins: string[]) => ({ permissions: { network: origins } });
const writeExt = (dir: string, m: unknown) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "safelight.json"), typeof m === "string" ? m : JSON.stringify(m));
};
const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sl-ext-origins-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("listInstalledManifests", () => {
  it("reads each plugins/<id>/safelight.json whose id names its folder", () => {
    writeExt(path.join(root, "acme.a"), manifest("acme.a"));
    writeExt(path.join(root, "acme.b"), manifest("acme.b"));
    expect(ids(listInstalledManifests(root)).sort()).toEqual(["acme.a", "acme.b"]);
  });

  it("skips a manifest whose id differs from its folder, a broken one, and plain files", () => {
    writeExt(path.join(root, "renamed"), manifest("acme.a"));
    writeExt(path.join(root, "broken"), "{ not json");
    writeExt(path.join(root, "partial"), { id: "partial", name: "Partial" });
    fs.writeFileSync(path.join(root, "safelight.json"), JSON.stringify(manifest("loose")));
    expect(listInstalledManifests(root)).toEqual([]);
  });

  it("is empty when the folder does not exist", () => {
    expect(listInstalledManifests(path.join(root, "missing"))).toEqual([]);
  });
});

describe("listDevManifests", () => {
  it("treats a folder with a root manifest as that one extension", () => {
    writeExt(root, manifest("solo"));
    writeExt(path.join(root, "nested"), manifest("nested"));
    expect(ids(listDevManifests(root))).toEqual(["solo"]);
  });

  it("otherwise reads each immediate subfolder with a manifest, whatever the folder is called", () => {
    writeExt(path.join(root, "Map"), manifest("map"));
    writeExt(path.join(root, "theme-slate"), manifest("com.example.slate"));
    fs.mkdirSync(path.join(root, "notes"));
    expect(ids(listDevManifests(root)).sort()).toEqual(["com.example.slate", "map"]);
  });

  it("skips invalid manifests and anything nested deeper", () => {
    writeExt(path.join(root, "broken"), "{");
    writeExt(path.join(root, "partial"), { id: "partial", main: "index.js" });
    writeExt(path.join(root, "group", "deep"), manifest("deep"));
    expect(listDevManifests(root)).toEqual([]);
  });

  it("is empty for no folder or a missing one", () => {
    expect(listDevManifests(null)).toEqual([]);
    expect(listDevManifests(path.join(root, "missing"))).toEqual([]);
  });
});

describe("declaredConnectHosts", () => {
  it("collects declared https origins once each, in manifest order", () => {
    const hosts = declaredConnectHosts([
      manifest("a", network("https://tiles.openfreemap.org", "https://api.example.com")),
      manifest("b", network("https://api.example.com", "https://cdn.example.com")),
    ]);
    expect(hosts).toEqual(["https://tiles.openfreemap.org", "https://api.example.com", "https://cdn.example.com"]);
  });

  it("drops anything that is not a plain https origin", () => {
    const hosts = declaredConnectHosts([
      manifest(
        "a",
        network(
          "http://insecure.example.com",
          "'unsafe-eval'",
          "*",
          "data:",
          "https://api.example.com/path",
          "https://api.example.com https://evil.example.com",
          " https://spaced.example.com ",
        ),
      ),
    ]);
    expect(hosts).toEqual(["https://spaced.example.com"]);
  });

  it("accepts a leading-label wildcard and a port", () => {
    expect(declaredConnectHosts([manifest("a", network("https://*.workers.dev", "https://localhost:8787"))])).toEqual([
      "https://*.workers.dev",
      "https://localhost:8787",
    ]);
  });

  it("ignores manifests without a network list", () => {
    expect(
      declaredConnectHosts([manifest("a"), manifest("b", { permissions: { reason: "none" } }), manifest("c", { permissions: { network: "https://x.example.com" } })]),
    ).toEqual([]);
  });
});

describe("pendingConnectHosts", () => {
  it("lists the declared origins the launch policy does not allow", () => {
    expect(pendingConnectHosts(["https://a.example.com", "https://b.example.com"], ["https://b.example.com", "https://c.example.com"])).toEqual([
      "https://a.example.com",
    ]);
  });
});

describe("the recorded dev folder", () => {
  it("round-trips a folder and is cleared with null", () => {
    const file = path.join(root, "dev-folder.json");
    writeDevFolder(file, "D:\\Repositories\\Extensions");
    expect(readDevFolder(file)).toBe("D:\\Repositories\\Extensions");
    writeDevFolder(file, null);
    expect(fs.existsSync(file)).toBe(false);
    expect(readDevFolder(file)).toBeNull();
  });

  it("reads null from a missing, malformed or empty record", () => {
    const file = path.join(root, "dev-folder.json");
    expect(readDevFolder(file)).toBeNull();
    fs.writeFileSync(file, "nope");
    expect(readDevFolder(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ folder: "" }));
    expect(readDevFolder(file)).toBeNull();
  });
});
