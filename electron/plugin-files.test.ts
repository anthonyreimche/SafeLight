// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The on-disk half of an extension install/update (plugin-files.cjs): the new
// files must never displace a working install until they are complete, and a
// rollback must put the previous copy back exactly. Runs against temp folders;
// main.cjs only supplies the real paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replacePlugin, settlePlugin, sweepPluginWork, retry } from "./plugin-files.cjs";

const ID = "acme.widget";

let root: string;
let pluginsDir: string;
let workDir: string;

const file = (name: string, text: string) => ({ name, data: Buffer.from(text) });
const manifest = (version: string) =>
  file("safelight.json", JSON.stringify({ id: ID, name: "Widget", version, main: "index.js" }));
const read = (...p: string[]) => fs.readFileSync(path.join(...p), "utf8");
const exists = (...p: string[]) => fs.existsSync(path.join(...p));

const installV1 = () =>
  replacePlugin({ pluginsDir, workDir, id: ID, files: [manifest("1.0.0"), file("index.js", "v1")] });
const installV2 = () =>
  replacePlugin({ pluginsDir, workDir, id: ID, files: [manifest("2.0.0"), file("index.js", "v2")] });

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "sl-plugin-files-"));
  pluginsDir = path.join(root, "plugins");
  workDir = path.join(root, "plugins-update");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("replacePlugin", () => {
  it("writes a fresh install and leaves no work folder behind", async () => {
    await installV1();
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(workDir, ID)).toBe(false);
  });

  it("keeps the version being replaced aside as prev", async () => {
    await installV1();
    await installV2();
    expect(read(pluginsDir, ID, "index.js")).toBe("v2");
    expect(read(workDir, ID, "prev", "index.js")).toBe("v1");
    expect(exists(workDir, ID, "next")).toBe(false);
  });

  it("leaves the current install untouched when a write fails midway", async () => {
    await installV1();
    // "a" lands as a file, then "a/b" needs "a" to be a directory: the write fails
    // after part of the new version is already on disk.
    await expect(
      replacePlugin({
        pluginsDir,
        workDir,
        id: ID,
        files: [manifest("2.0.0"), file("a", "x"), file("a/b", "y")],
      }),
    ).rejects.toThrow();
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(workDir, ID)).toBe(false);
  });

  it("serializes concurrent replacements of the same extension", async () => {
    await Promise.all([installV1(), installV2()]);
    expect(read(pluginsDir, ID, "index.js")).toBe("v2");
    expect(read(workDir, ID, "prev", "index.js")).toBe("v1");
    expect(exists(workDir, ID, "next")).toBe(false);
  });

  it("skips entries that would escape the install folder", async () => {
    await replacePlugin({
      pluginsDir,
      workDir,
      id: ID,
      files: [manifest("1.0.0"), file("index.js", "v1"), file("../escape.txt", "no")],
    });
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(pluginsDir, "escape.txt")).toBe(false);
    expect(exists(workDir, ID, "escape.txt")).toBe(false);
  });
});

describe("settlePlugin", () => {
  it("keep drops the previous copy", async () => {
    await installV1();
    await installV2();
    expect(await settlePlugin({ pluginsDir, workDir, id: ID, outcome: "keep" })).toBeNull();
    expect(exists(workDir, ID)).toBe(false);
    expect(read(pluginsDir, ID, "index.js")).toBe("v2");
  });

  it("rollback restores the previous copy and returns its manifest", async () => {
    await installV1();
    await installV2();
    const restored = await settlePlugin({ pluginsDir, workDir, id: ID, outcome: "rollback" });
    expect(restored).toMatchObject({ id: ID, version: "1.0.0" });
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(workDir, ID)).toBe(false);
  });

  it("rollback with nothing to restore removes the install", async () => {
    await installV1();
    expect(await settlePlugin({ pluginsDir, workDir, id: ID, outcome: "rollback" })).toBeNull();
    expect(exists(pluginsDir, ID)).toBe(false);
    expect(exists(workDir, ID)).toBe(false);
  });
});

describe("sweepPluginWork", () => {
  it("puts back an update that was never settled, then clears the work area", async () => {
    await installV1();
    await installV2();
    sweepPluginWork({ pluginsDir, workDir });
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(workDir)).toBe(false);
  });

  it("restores the previous version when the install itself went missing", async () => {
    await installV1();
    await installV2();
    fs.rmSync(path.join(pluginsDir, ID), { recursive: true, force: true });
    sweepPluginWork({ pluginsDir, workDir });
    expect(read(pluginsDir, ID, "index.js")).toBe("v1");
    expect(exists(workDir)).toBe(false);
  });

  it("leaves a settled install alone", async () => {
    await installV1();
    await installV2();
    await settlePlugin({ pluginsDir, workDir, id: ID, outcome: "keep" });
    sweepPluginWork({ pluginsDir, workDir });
    expect(read(pluginsDir, ID, "index.js")).toBe("v2");
    expect(exists(workDir)).toBe(false);
  });

  it("tolerates a missing work area", () => {
    expect(() =>
      sweepPluginWork({ pluginsDir, workDir: path.join(root, "nope") }),
    ).not.toThrow();
  });
});

describe("retry", () => {
  const busy = () => Object.assign(new Error("busy"), { code: "EBUSY" });

  it("retries transient file-lock errors", async () => {
    const op = vi
      .fn()
      .mockRejectedValueOnce(busy())
      .mockRejectedValueOnce(busy())
      .mockResolvedValue("ok");
    await expect(retry(op, { attempts: 5, delayMs: 1 })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("gives up after the last attempt", async () => {
    const op = vi.fn().mockRejectedValue(busy());
    await expect(retry(op, { attempts: 3, delayMs: 1 })).rejects.toThrow("busy");
    expect(op).toHaveBeenCalledTimes(3);
  });

  it("rethrows other errors at once", async () => {
    const op = vi.fn().mockRejectedValue(Object.assign(new Error("gone"), { code: "ENOENT" }));
    await expect(retry(op, { attempts: 5, delayMs: 1 })).rejects.toThrow("gone");
    expect(op).toHaveBeenCalledTimes(1);
  });
});
