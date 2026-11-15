// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeMirrorBridge } from "@/extensions/types";
import type { SharedSettings } from "./shared-settings";
import { updateSettings } from "./settings-store";
import { applyPipeline } from "@/extensions/pipelines";
import { initSettingsMirror } from "./settings-mirror";

let mirror: NativeMirrorBridge | null = null;
vi.mock("@/native/privileged", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/native/privileged")>()),
  privilegedMirror: () => mirror,
}));

let role = "main";
vi.mock("@/diagnostics/environment", () => ({ windowRole: () => role }));

vi.mock("@/project/recent", () => ({
  listRecentProjects: async () => [
    { id: "b", path: "D:\\Photos\\b", openedAt: 2 },
    { id: "web", path: null, openedAt: 1 },
  ],
}));

let writeSharedSettings: ReturnType<typeof vi.fn<(doc: SharedSettings) => Promise<void>>>;
let stop: () => void = () => {};

const lastDoc = (): SharedSettings => writeSharedSettings.mock.calls.at(-1)![0];

function storageEvent(key: string): void {
  window.dispatchEvent(new StorageEvent("storage", { key }));
}

/** Start the mirror and let its first write land. */
async function start(): Promise<void> {
  stop = initSettingsMirror();
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  role = "main";
  writeSharedSettings = vi.fn(async () => {});
  mirror = { writeSharedSettings };
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("initSettingsMirror", () => {
  it("writes the mirrored keys and recent project paths on start", async () => {
    localStorage.setItem("sl_pipeline", "acme.agx");
    localStorage.setItem("sl_ext_settings_acme.film", '{"grain":1}');
    localStorage.setItem("safelight.inputProfileOwner", "acme.icc");
    localStorage.setItem("sl_keybindings", "{}");
    await start();
    expect(writeSharedSettings).toHaveBeenCalledOnce();
    expect(lastDoc()).toMatchObject({
      version: 1,
      guiPid: null,
      recentProjects: ["D:\\Photos\\b"],
      storage: {
        sl_pipeline: "acme.agx",
        "sl_ext_settings_acme.film": '{"grain":1}',
        "safelight.inputProfileOwner": "acme.icc",
      },
    });
    expect(lastDoc().storage).not.toHaveProperty("sl_keybindings");
    expect(typeof lastDoc().appVersion).toBe("string");
  });

  it("writes once, 500 ms after a burst of changes to mirrored keys", async () => {
    await start();
    writeSharedSettings.mockClear();
    applyPipeline("acme.agx");
    updateSettings({ highBitDepth: true });
    await vi.advanceTimersByTimeAsync(300);
    applyPipeline("acme.filmic");
    await vi.advanceTimersByTimeAsync(499);
    expect(writeSharedSettings).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(writeSharedSettings).toHaveBeenCalledOnce();
    expect(lastDoc().storage.sl_pipeline).toBe("acme.filmic");
    expect(JSON.parse(lastDoc().storage.sl_settings_v1)).toMatchObject({ highBitDepth: true });
  });

  it("follows a change another window made", async () => {
    await start();
    writeSharedSettings.mockClear();
    localStorage.setItem("safelight-presets", "[]");
    storageEvent("safelight-presets");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSharedSettings).toHaveBeenCalledOnce();
    expect(lastDoc().storage["safelight-presets"]).toBe("[]");
  });

  it("writes nothing for a change to a key it does not mirror", async () => {
    await start();
    writeSharedSettings.mockClear();
    localStorage.setItem("sl_keybindings", '{"undo":"Ctrl+Z"}');
    storageEvent("sl_keybindings");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writeSharedSettings).not.toHaveBeenCalled();
  });

  it("rewrites every 60 s as the app's heartbeat", async () => {
    await start();
    const first = lastDoc().writtenAt;
    writeSharedSettings.mockClear();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writeSharedSettings).toHaveBeenCalledOnce();
    expect(lastDoc().writtenAt).toBeGreaterThan(first);
  });

  it("does nothing outside the main window", async () => {
    role = "develop";
    await start();
    applyPipeline("acme.agx");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(writeSharedSettings).not.toHaveBeenCalled();
  });

  it("keeps going when a write fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeSharedSettings.mockRejectedValueOnce(new Error("disk full"));
    await start();
    applyPipeline("acme.agx");
    await vi.advanceTimersByTimeAsync(500);
    expect(writeSharedSettings).toHaveBeenCalledTimes(2);
    expect(lastDoc().storage.sl_pipeline).toBe("acme.agx");
    warn.mockRestore();
  });

  it("does nothing without the bridge", async () => {
    mirror = null;
    await start();
    applyPipeline("acme.agx");
    await vi.advanceTimersByTimeAsync(61_000);
    expect(writeSharedSettings).not.toHaveBeenCalled();
  });
});
