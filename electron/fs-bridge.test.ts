// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The fs bridge `slu` and the Electron channels share (fs-bridge.cjs), against temp folders.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFsBridge } from "./fs-bridge.cjs";

let root: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-bridge-"));
  userData = path.join(root, "userData");
  fs.mkdirSync(userData);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const writer = {
  write: async (file: string, data: Uint8Array) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
  },
};

const bridge = (baseOverride?: () => string) => createFsBridge({ userData, writer, baseOverride });

describe("read, write and list", () => {
  it("round-trips a file and reads a byte range", async () => {
    const b = bridge();
    const file = path.join(root, "a.bin");
    await b.write(file, new Uint8Array([1, 2, 3, 4, 5]));
    const whole = await b.read(file);
    expect([...whole.data]).toEqual([1, 2, 3, 4, 5]);
    expect(whole.size).toBe(5);
    expect([...(await b.read(file, { start: 1, end: 3 })).data]).toEqual([2, 3]);
    expect([...(await b.readFileSlice(file, 3, 99)).data]).toEqual([4, 5]);
  });

  it("refuses a relative write path", async () => {
    await expect(bridge().write("rel/a.bin", new Uint8Array([1]))).rejects.toThrow(/absolute/);
  });

  it("lists a folder, files with sizes when asked, a missing folder as empty", async () => {
    const b = bridge();
    fs.writeFileSync(path.join(root, "a.jpg"), "12345");
    fs.mkdirSync(path.join(root, "sub"));
    const listed = await b.list(root, undefined, true);
    expect(listed.filter((e) => e.name !== "userData").sort((x, y) => x.name.localeCompare(y.name))).toEqual([
      { name: "a.jpg", kind: "file", size: 5 },
      { name: "sub", kind: "directory" },
    ]);
    await expect(b.list(path.join(root, "gone"))).resolves.toEqual([]);
  });

  it("makes, moves, tests for and removes", async () => {
    const b = bridge();
    const dir = path.join(root, "x", "y");
    await b.mkdir(dir);
    expect(await b.exists(dir)).toBe(true);
    await b.move(dir, path.join(root, "z", "y"));
    expect(await b.exists(dir)).toBe(false);
    await b.remove(path.join(root, "z"));
    expect(await b.exists(path.join(root, "z"))).toBe(false);
  });
});

describe("separate catalogue naming", () => {
  it("names a source's catalogue by the sha1 stem the Electron channel always used", async () => {
    const src = path.resolve("E:\\");
    const tag = crypto.createHash("sha1").update(src).digest("hex").slice(0, 8);
    const leaf = path.basename(src).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "folder";
    const dir = await bridge().externalCatalogDir("E:\\", null, true);
    expect(dir).toBe(path.join(userData, "external-catalogs", `${leaf}-${tag}`, ".safelight"));
    expect(fs.existsSync(path.join(path.dirname(dir!), "source.json"))).toBe(true);
  });

  it("uses the factory's base when a call names none, and the call's when it does", async () => {
    const base = path.join(root, "base");
    const b = bridge(() => base);
    expect(await b.externalCatalogDir("D:/card", null, true)).toContain(base);
    const other = path.join(root, "other");
    expect(await b.externalCatalogDir("D:/card", other, true)).toContain(other);
  });

  it("lists variants and stored catalogues, and keeps spillover pointers", async () => {
    const b = bridge();
    for (const n of [1, 2]) fs.writeFileSync(path.join((await b.externalCatalogDir("E:\\", null, true, n))!, "catalog.json"), "{}");
    await expect(b.externalCatalogVariants("E:\\")).resolves.toEqual([1, 2]);
    expect(await b.listExternalCatalogs()).toHaveLength(2);
    await b.setSpilloverPointer("D:/card", "D:/x/.safelight");
    await expect(b.getSpilloverPointer("D:/card")).resolves.toBe("D:/x/.safelight");
    await b.clearSpilloverPointer("D:/card");
    await expect(b.getSpilloverPointer("D:/card")).resolves.toBeNull();
  });
});

describe("project locks", () => {
  it("creates writer.lock in the working directory and refuses a second holder", async () => {
    const b = bridge();
    const dir = path.join(root, ".safelight");
    const got = await b.lockProject(dir, "slu");
    expect(got.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "writer.lock"))).toBe(true);
    await expect(b.lockProject(dir, "safelight")).resolves.toMatchObject({ ok: false, heldBy: { app: "slu" } });
    const token = (got as { token: string }).token;
    await expect(b.refreshProjectLock(dir, token)).resolves.toBe(true);
    await b.releaseProjectLock(dir, "wrong");
    expect(fs.existsSync(path.join(dir, "writer.lock"))).toBe(true);
    await b.releaseProjectLock(dir, token);
    expect(fs.existsSync(path.join(dir, "writer.lock"))).toBe(false);
  });

  it("refuses a relative working directory and an unknown owner", async () => {
    const b = bridge();
    await expect(b.lockProject("rel", "slu")).rejects.toThrow(/absolute/);
    await expect(b.lockProject(root, "other" as never)).rejects.toThrow(/owner/);
  });
});
