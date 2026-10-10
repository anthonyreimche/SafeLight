// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The manifests the main process reads at launch for the renderer's
// content-security policy (extension-origins.cjs): installed extensions and
// the Developer Tools dev folder must be read the same way, and only
// well-formed HTTPS origins may ever reach the policy. An extension under a
// reserved id ("core", "core.*") is no valid manifest at all: it is neither
// installed, listed nor read for origins. Runs against temp folders; main.cjs
// only supplies the real paths.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  declaredConnectHosts,
  isReservedExtensionId,
  listDevManifests,
  listInstalledManifests,
  pendingConnectHosts,
  readDevFolder,
  validManifest,
  writeDevFolder,
} from "./extension-origins.cjs";
import { isReservedExtensionId as isReservedInRenderer } from "../src/extensions/core-extension";

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

describe("validManifest", () => {
  it.each(["core", "core.x", "CORE", "Core.Tools"])("refuses the reserved id %s", (id) => {
    expect(validManifest(manifest(id))).toBe(false);
  });

  it.each(["corel", "coreutils", "my.core", "acme.core.x"])(
    "accepts %s, which is not under core",
    (id) => {
      expect(validManifest(manifest(id))).toBe(true);
    },
  );
});

// Each runtime states the reserved-id rule once (here, and in the renderer's
// core-extension.ts). The same id must come out the same in both, or one of them
// lets through what the other refuses.
describe("the reserved-id rule", () => {
  it.each([
    "core",
    "core.x",
    "CORE",
    "Core.Tools",
    "core.",
    ".core",
    "core-x",
    "core_x",
    "corel",
    "coreutils",
    "my.core",
    "acme.core.x",
    "cor",
    "",
  ])("is the same in the main process and the renderer for %j", (id) => {
    expect(isReservedExtensionId(id)).toBe(isReservedInRenderer(id));
  });
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

  it("never lists an extension under a reserved id", () => {
    writeExt(path.join(root, "core"), manifest("core"));
    writeExt(path.join(root, "core.hsl"), manifest("core.hsl"));
    writeExt(path.join(root, "acme.a"), manifest("acme.a"));
    expect(ids(listInstalledManifests(root))).toEqual(["acme.a"]);
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

  it("never lists an extension under a reserved id, as the folder itself or inside it", () => {
    writeExt(path.join(root, "solo"), manifest("core.hsl"));
    expect(listDevManifests(path.join(root, "solo"))).toEqual([]);
    writeExt(path.join(root, "parent", "tools"), manifest("core"));
    writeExt(path.join(root, "parent", "ok"), manifest("acme.ok"));
    expect(ids(listDevManifests(path.join(root, "parent")))).toEqual(["acme.ok"]);
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

  it("never come from an extension under a reserved id, installed or in the dev folder", () => {
    writeExt(
      path.join(root, "plugins", "core.tools"),
      manifest("core.tools", network("https://a.example.com")),
    );
    writeExt(path.join(root, "dev", "tools"), manifest("Core", network("https://b.example.com")));
    writeExt(path.join(root, "dev", "ok"), manifest("acme.ok", network("https://c.example.com")));
    const hosts = declaredConnectHosts([
      ...listInstalledManifests(path.join(root, "plugins")),
      ...listDevManifests(path.join(root, "dev")),
    ]);
    expect(hosts).toEqual(["https://c.example.com"]);
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
