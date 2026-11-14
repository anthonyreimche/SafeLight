// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A folder an extension keeps across launches (an export recipe's destination).
// Only a folder the person picked in the native dialog is ever kept; the
// extension holds a token for it, and the path stays here, in the main process,
// so no page script can name a folder of its own and have it opened.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKeptFolders } from "./kept-folders.cjs";

const temps: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-kept-"));
  temps.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const writer = {
  write: async (p: string, bytes: Uint8Array) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, bytes);
  },
};

/** Kept folders over a fresh app-data folder; the dialog answers with `answers` in turn. */
function rig(answers: (string | null)[] = [], userData = tempDir()) {
  const pickPath = vi.fn(async (_event: unknown, _defaultPath: string | null) => answers.shift() ?? null);
  const kept = createKeptFolders({ userData: () => userData, fileWriter: writer, pickPath });
  return { kept, pickPath, userData };
}

describe("a kept folder", () => {
  it("is one the person picked in the dialog, handed back with a token", async () => {
    const out = tempDir();
    const { kept } = rig([out]);
    const picked = await kept.pick(null, "ext.recipes", null);
    expect(picked).toEqual({ token: expect.stringMatching(/^[0-9a-f-]{36}$/), path: out });
    expect(await kept.open("ext.recipes", picked!.token)).toEqual({ path: out });
  });

  it("is nothing when the dialog is cancelled", async () => {
    const { kept, userData } = rig([null]);
    expect(await kept.pick(null, "ext.recipes", null)).toBeNull();
    expect(fs.existsSync(path.join(userData, "kept-folders.json"))).toBe(false);
  });

  it("opens again after a restart", async () => {
    const out = tempDir();
    const first = rig([out]);
    const { token } = (await first.kept.pick(null, "ext.recipes", null))!;
    const later = rig([], first.userData);
    expect(await later.kept.open("ext.recipes", token)).toEqual({ path: out });
  });

  it("opens only for the extension that picked it", async () => {
    const out = tempDir();
    const { kept } = rig([out]);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    expect(await kept.open("ext.other", token)).toEqual({ error: "unknown" });
    await kept.forget("ext.other", token);
    expect(await kept.open("ext.recipes", token)).toEqual({ path: out });
  });

  it("is unknown for a token never handed out", async () => {
    const { kept } = rig();
    expect(await kept.open("ext.recipes", "D:\\Photos")).toEqual({ error: "unknown" });
    expect(await kept.open("ext.recipes", "constructor")).toEqual({ error: "unknown" });
  });

  it("is forgotten when its extension lets it go, after a restart too", async () => {
    const out = tempDir();
    const { kept, userData } = rig([out]);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    await kept.forget("ext.recipes", token);
    expect(await kept.open("ext.recipes", token)).toEqual({ error: "unknown" });
    expect(await rig([], userData).kept.open("ext.recipes", token)).toEqual({ error: "unknown" });
  });

  it("says a folder that was removed is gone", async () => {
    const out = tempDir();
    const { kept } = rig([out]);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    fs.rmSync(out, { recursive: true });
    expect(await kept.open("ext.recipes", token)).toEqual({ error: "gone" });
  });

  it("says a path that is now a file is gone", async () => {
    const out = tempDir();
    const { kept } = rig([out]);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    fs.rmSync(out, { recursive: true });
    fs.writeFileSync(out, "");
    expect(await kept.open("ext.recipes", token)).toEqual({ error: "gone" });
  });

  it("says a folder it may not write into can't be written", async () => {
    const out = tempDir();
    const { kept } = rig([out]);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    vi.spyOn(fs.promises, "access").mockRejectedValue(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    expect(await kept.open("ext.recipes", token)).toEqual({ error: "unwritable" });
  });

  it("opens the dialog at the folder it replaces, if that one is the extension's", async () => {
    const [a, b] = [tempDir(), tempDir()];
    const { kept, pickPath } = rig([a, b, null]);
    const first = (await kept.pick(null, "ext.recipes", null))!;
    await kept.pick(null, "ext.recipes", first.token);
    await kept.pick(null, "ext.other", first.token);
    expect(pickPath.mock.calls.map(([, at]) => at)).toEqual([null, a, null]);
    expect(await kept.open("ext.recipes", first.token)).toEqual({ path: a });
  });

  it("keeps a new token for each pick, the earlier one still open", async () => {
    const [a, b] = [tempDir(), tempDir()];
    const { kept } = rig([a, b]);
    const first = (await kept.pick(null, "ext.recipes", null))!;
    const second = (await kept.pick(null, "ext.recipes", first.token))!;
    expect(second.token).not.toBe(first.token);
    expect(await kept.open("ext.recipes", second.token)).toEqual({ path: b });
  });

  it("reads past a record file it can't make sense of", async () => {
    const userData = tempDir();
    fs.writeFileSync(path.join(userData, "kept-folders.json"), "{ not json");
    const out = tempDir();
    const { kept } = rig([out], userData);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    expect(await kept.open("ext.recipes", token)).toEqual({ path: out });
  });
});

// Windows hands a file to antivirus or backup for a moment: a read refused then
// must not cost every extension its folders.
describe("the record of kept folders", () => {
  const record = (userData: string) => path.join(userData, "kept-folders.json");
  const busy = () => {
    throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
  };

  /** A record holding one folder for ext.recipes, and its token. */
  async function holding() {
    const out = tempDir();
    const first = rig([out]);
    const { token } = (await first.kept.pick(null, "ext.recipes", null))!;
    return { out, token, userData: first.userData };
  }

  it("is read again after a read that failed, and then opens the folders it holds", async () => {
    const { out, token, userData } = await holding();
    const { kept } = rig([], userData);
    vi.spyOn(fs, "readFileSync").mockImplementationOnce(busy);
    await expect(kept.open("ext.recipes", token)).rejects.toThrow("EBUSY");
    expect(await kept.open("ext.recipes", token)).toEqual({ path: out });
  });

  it("is never written over after a read that failed", async () => {
    const { token, userData } = await holding();
    const before = fs.readFileSync(record(userData), "utf8");
    const other = tempDir();
    const { kept, pickPath } = rig([other], userData);
    vi.spyOn(fs, "readFileSync").mockImplementation(busy);
    await expect(kept.pick(null, "ext.recipes", null)).rejects.toThrow("EBUSY");
    await expect(kept.forget("ext.recipes", token)).rejects.toThrow("EBUSY");
    await expect(kept.forgetExtension("ext.recipes")).rejects.toThrow("EBUSY");
    expect(pickPath).not.toHaveBeenCalled();
    vi.mocked(fs.readFileSync).mockRestore();
    expect(fs.readFileSync(record(userData), "utf8")).toBe(before);
  });

  it("starts empty when there is none yet", async () => {
    const { kept } = rig();
    expect(await kept.open("ext.recipes", "kept-1")).toEqual({ error: "unknown" });
  });

  it.each([
    ["isn't JSON", "{ not json"],
    ["is of a version this copy doesn't know", JSON.stringify({ version: 2, folders: {} })],
  ])("is moved aside before the first write when it %s", async (_, text) => {
    const userData = tempDir();
    fs.writeFileSync(record(userData), text);
    const out = tempDir();
    const { kept } = rig([out], userData);
    expect(await kept.open("ext.recipes", "kept-1")).toEqual({ error: "unknown" });
    expect(fs.readFileSync(record(userData), "utf8")).toBe(text);
    const { token } = (await kept.pick(null, "ext.recipes", null))!;
    expect(fs.readFileSync(`${record(userData)}.bad`, "utf8")).toBe(text);
    expect(await rig([], userData).kept.open("ext.recipes", token)).toEqual({ path: out });
  });
});

// A different extension installed later under the same id must not inherit them.
describe("an extension's kept folders when it is uninstalled", () => {
  it("are all forgotten, after a restart too, and no other extension's", async () => {
    const [a, b, c] = [tempDir(), tempDir(), tempDir()];
    const { kept, userData } = rig([a, b, c]);
    const one = (await kept.pick(null, "ext.recipes", null))!;
    const two = (await kept.pick(null, "ext.recipes", null))!;
    const other = (await kept.pick(null, "ext.other", null))!;
    await kept.forgetExtension("ext.recipes");
    for (const { token } of [one, two]) expect(await kept.open("ext.recipes", token)).toEqual({ error: "unknown" });
    expect(await kept.open("ext.other", other.token)).toEqual({ path: c });
    const later = rig([], userData).kept;
    expect(await later.open("ext.recipes", one.token)).toEqual({ error: "unknown" });
    expect(await later.open("ext.other", other.token)).toEqual({ path: c });
  });

  it("writes nothing for an extension that kept none", async () => {
    const { kept, userData } = rig();
    await kept.forgetExtension("ext.recipes");
    expect(fs.existsSync(path.join(userData, "kept-folders.json"))).toBe(false);
  });
});
