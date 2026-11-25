import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getParamDescriptor, isComputedParam, normalizeParamBag, unregisterExtensionParams } from "@/extensions/param-registry";
import type { ExtensionDescriptors } from "@/state/shared-settings";
import { guiHeartbeatAt, readDescriptors, readSharedSettings, seedParamRegistry } from "./mirror";

let userData: string;
beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), "slu-mirror-"));
});
afterEach(() => {
  unregisterExtensionParams("demo.ext");
  rmSync(userData, { recursive: true, force: true });
});

const descriptors: ExtensionDescriptors = {
  version: 1,
  id: "demo.ext",
  extVersion: "1.0.0",
  name: "Demo",
  writtenAt: 1,
  stages: [{ id: "demo.stage", phase: "colour" }],
  uniforms: [
    { key: "demo.stage.amount", glslType: "float", default: 0, range: { min: -1, max: 1 } },
    { key: "flag", glslType: "bool", default: false },
  ],
  panels: [],
  hasCatalogHooks: false,
};

describe("readSharedSettings", () => {
  it("is null for a missing or corrupt file", () => {
    expect(readSharedSettings(userData)).toBeNull();
    writeFileSync(join(userData, "shared-settings.json"), "{nope");
    expect(readSharedSettings(userData)).toBeNull();
  });

  it("reads a valid file and drops non-string storage values", () => {
    writeFileSync(
      join(userData, "shared-settings.json"),
      JSON.stringify({ version: 1, appVersion: "3.3.0", writtenAt: 5, guiPid: 9, recentProjects: ["D:\a", 3], storage: { k: "v", bad: 1 } }),
    );
    expect(readSharedSettings(userData)).toEqual({
      version: 1, appVersion: "3.3.0", writtenAt: 5, guiPid: 9, recentProjects: ["D:\a"], storage: { k: "v" },
    });
  });

  it("dates the settings by the app's heartbeat, which is newer while the settings stay the same", () => {
    writeFileSync(
      join(userData, "shared-settings.json"),
      JSON.stringify({ version: 1, appVersion: "3.3.0", writtenAt: 5, guiPid: null, recentProjects: [], storage: {} }),
    );
    writeFileSync(join(userData, "gui-heartbeat.json"), JSON.stringify({ version: 1, writtenAt: 900 }));
    expect(guiHeartbeatAt(userData)).toBe(900);
    expect(readSharedSettings(userData)?.writtenAt).toBe(900);
    writeFileSync(join(userData, "gui-heartbeat.json"), JSON.stringify({ version: 1, writtenAt: 3 }));
    expect(readSharedSettings(userData)?.writtenAt).toBe(5);
  });
});

describe("readDescriptors", () => {
  it("reads installed extensions' files and skips the missing, corrupt and mismatched", () => {
    const dir = join(userData, "extension-descriptors");
    mkdirSync(dir);
    writeFileSync(join(dir, "demo.ext@1.0.0.json"), JSON.stringify(descriptors));
    writeFileSync(join(dir, "bad.ext@1.0.0.json"), "{");
    writeFileSync(join(dir, "other.ext@1.0.0.json"), JSON.stringify(descriptors));
    const found = readDescriptors(userData, [
      { id: "demo.ext", version: "1.0.0" },
      { id: "bad.ext", version: "1.0.0" },
      { id: "other.ext", version: "1.0.0" },
      { id: "gone.ext", version: "1.0.0" },
    ]);
    expect([...found.keys()]).toEqual(["demo.ext"]);
  });
});

describe("seedParamRegistry", () => {
  it("registers uniforms so normalizeParamBag drops a wrong-typed key and keeps an unknown one", () => {
    seedParamRegistry([descriptors]);
    expect(getParamDescriptor("demo.stage.amount")?.range).toEqual({ min: -1, max: 1 });
    expect(getParamDescriptor("demo.stage.flag")?.glslType).toBe("bool");
    expect(normalizeParamBag({ "demo.stage.amount": "x", "demo.stage.flag": true, "other.key": 3 })).toEqual({
      "demo.stage.flag": true,
      "other.key": 3,
    });
  });

  // `slu` pastes and copies as the app does, so it knows which values the
  // extension computes for each photo.
  it("marks the values the extension computes for each photo", () => {
    seedParamRegistry([{ ...descriptors, computed: ["demo.stage.k1"] }]);
    expect(isComputedParam("demo.stage.k1")).toBe(true);
    expect(isComputedParam("demo.stage.amount")).toBe(false);
  });

  it("keeps a scalar array uniform's length, so its array values survive normalizing", () => {
    seedParamRegistry([
      { ...descriptors, uniforms: [{ key: "demo.stage.gains", glslType: "float", length: 3, default: [0, 0, 0] }] },
    ]);
    expect(normalizeParamBag({ "demo.stage.gains": [0.2, 0.3, 0.5] })).toEqual({ "demo.stage.gains": [0.2, 0.3, 0.5] });
  });
});
