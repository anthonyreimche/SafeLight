import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ipcChannels } from "./ipc/index.cjs";
import {
  readDisabled,
  writeDescriptors,
  writeDisabled,
  writeSharedSettings,
} from "./extension-state.cjs";

let userData: string;
const writer = {
  async write(file: string, bytes: Uint8Array) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, bytes);
  },
};

beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "slu-ext-state-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const descriptors = (id: string, extVersion: string) => ({
  version: 1 as const,
  id,
  extVersion,
  name: "Thing",
  writtenAt: 1,
  stages: [],
  uniforms: [],
  panels: [],
  hasCatalogHooks: false,
});

describe("the disabled list", () => {
  it("is null before any file exists", async () => {
    expect(await readDisabled(userData)).toBeNull();
  });

  it("round-trips ids", async () => {
    await writeDisabled(userData, ["a.b", "c.d"], writer);
    expect(await readDisabled(userData)).toEqual(["a.b", "c.d"]);
    expect(JSON.parse(await readFile(join(userData, "extension-state.json"), "utf8"))).toEqual({
      version: 1,
      disabled: ["a.b", "c.d"],
    });
  });

  it("keeps only string ids when writing", async () => {
    await writeDisabled(userData, ["a", 3, null, "b"] as unknown as string[], writer);
    expect(await readDisabled(userData)).toEqual(["a", "b"]);
  });

  it("reads a corrupt or foreign file as no list", async () => {
    await writeFile(join(userData, "extension-state.json"), "{nope");
    expect(await readDisabled(userData)).toBeNull();
    await writeFile(join(userData, "extension-state.json"), JSON.stringify({ version: 2, disabled: [] }));
    expect(await readDisabled(userData)).toBeNull();
  });
});

describe("mirror files", () => {
  it("writes shared settings to shared-settings.json", async () => {
    const doc = { version: 1, appVersion: "3.3.0", writtenAt: 5, guiPid: 9, recentProjects: [], storage: {} };
    await writeSharedSettings(userData, doc, writer);
    expect(JSON.parse(await readFile(join(userData, "shared-settings.json"), "utf8"))).toEqual(doc);
  });

  it("writes descriptors as <id>@<version>.json", async () => {
    const doc = descriptors("safelight.basic", "1.2.3-beta.1");
    await writeDescriptors(userData, doc, writer);
    const file = join(userData, "extension-descriptors", "safelight.basic@1.2.3-beta.1.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(doc);
  });

  it.each([
    ["../x", "1.0.0"],
    ["a/b", "1.0.0"],
    ["a\\b", "1.0.0"],
    ["ok", "../1"],
    ["ok", "1/2"],
    ["", "1.0.0"],
    ["ok", ""],
    [".hidden", "1.0.0"],
  ])("rejects id %j version %j", async (id, version) => {
    await expect(writeDescriptors(userData, descriptors(id, version), writer)).rejects.toThrow();
    await expect(readdir(join(userData, "extension-descriptors"))).rejects.toThrow();
  });

  it("rejects a descriptor whose extVersion is missing", async () => {
    await expect(
      writeDescriptors(userData, { ...descriptors("ok", "1"), extVersion: undefined } as never, writer),
    ).rejects.toThrow();
  });
});

describe("the IPC channels", () => {
  const channels = () =>
    ipcChannels({ userData: () => userData, fileWriter: writer } as unknown as Parameters<typeof ipcChannels>[0]);
  const call = (name: string, ...args: unknown[]) => {
    const hit = channels().find((c) => c.channel === name);
    expect(hit, name).toBeDefined();
    expect(hit!.privileged).toBe(true);
    return hit!.handler({} as never, ...args);
  };

  it("reads and writes the disabled list", async () => {
    expect(await call("plugins:readDisabled")).toBeNull();
    await call("plugins:writeDisabled", ["x.y"]);
    expect(await call("plugins:readDisabled")).toEqual(["x.y"]);
  });

  it("writes the mirror documents", async () => {
    await call("mirror:writeSharedSettings", { version: 1, appVersion: "1", writtenAt: 1, guiPid: null, recentProjects: [], storage: {} });
    await call("mirror:writeDescriptors", descriptors("a.b", "1.0.0"));
    expect((await readdir(userData)).sort()).toEqual(["extension-descriptors", "shared-settings.json"]);
  });

  it("refuses a malformed disabled list", async () => {
    await expect(call("plugins:writeDisabled", "nope")).rejects.toThrow();
  });
});
