// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Reading the saved catalogue: a damaged one is kept aside, unless the read
// may write nothing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";
import { createFsBridge } from "../../electron/fs-bridge.cjs";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import { readSavedCatalog } from "./catalog-file";
import { nativeDirectoryHandle } from "./native-fs";

let sl: string;

beforeEach(() => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-catalog-file-"));
  sl = path.join(temp, ".safelight");
  fs.mkdirSync(sl);
  const writer = {
    write: async (file: string, data: Uint8Array) => {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, data);
    },
  };
  h.fs = { ...createFsBridge({ userData: path.join(temp, "userData"), writer }), pickDirectory: async () => null, reveal: async () => false };
  fs.writeFileSync(path.join(sl, "catalog.json"), "{ not json");
});

afterEach(() => fs.rmSync(path.dirname(sl), { recursive: true, force: true }));

describe("readSavedCatalog", () => {
  it("keeps a damaged catalogue aside", async () => {
    const saved = await readSavedCatalog(nativeDirectoryHandle(sl));
    expect(saved.recovered).toMatchObject({ from: "rescan" });
    expect(fs.readdirSync(sl).some((n) => n.startsWith("catalog.corrupt-"))).toBe(true);
  });

  it("reads a damaged catalogue read-only without writing a copy", async () => {
    const saved = await readSavedCatalog(nativeDirectoryHandle(sl), { readOnly: true });
    expect(saved).toEqual({ catalog: null, recovered: { from: "rescan", kept: null }, bytes: null });
    expect(fs.readdirSync(sl)).toEqual(["catalog.json"]);
  });
});
