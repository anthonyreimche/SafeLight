// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The display profile follows Preferences ▸ Rendering ▸ Display profile: on
// Linux only, it reads the chosen file, re-reads it when the path changes or
// the user picks it again, and says why when it can't use it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildIccProfile } from "./color-space";
import { PROFILE_ERROR } from "./display-profile";
import {
  READ_ERROR,
  activeMonitorTransform,
  initDisplayProfile,
  reloadDisplayProfile,
  useDisplayProfile,
} from "./display-profile-store";
import { resetSettings, updateSettings } from "@/state/settings-store";

const ADOBE = "/home/me/.local/share/icc/adobe.icc";
const P3 = "/home/me/.local/share/icc/p3.icc";
const FILES: Record<string, Uint8Array> = {
  [ADOBE]: buildIccProfile("adobe-rgb"),
  [P3]: buildIccProfile("display-p3"),
};

let read: ReturnType<typeof vi.fn<(path: string) => Promise<Uint8Array>>>;
let stop: () => void;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function onPlatform(platform: string) {
  vi.stubGlobal("safelightNative", { platform });
}

beforeEach(() => {
  localStorage.clear();
  resetSettings();
  onPlatform("linux");
  read = vi.fn((path: string) =>
    path in FILES ? Promise.resolve(FILES[path]) : Promise.reject(new Error("ENOENT")),
  );
  stop = () => undefined;
});

afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

describe("display profile store", () => {
  it("stays off outside Linux, whatever path is stored", async () => {
    onPlatform("win32");
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    await settle();
    expect(useDisplayProfile.getState()).toEqual({ status: "off" });
    expect(read).not.toHaveBeenCalled();
    expect(activeMonitorTransform()).toBeNull();
  });

  it("stays off without a path", async () => {
    stop = initDisplayProfile(read);
    await settle();
    expect(useDisplayProfile.getState()).toEqual({ status: "off" });
    expect(read).not.toHaveBeenCalled();
  });

  it("reads the chosen profile", async () => {
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    expect(useDisplayProfile.getState()).toEqual({ status: "loading", path: ADOBE });
    await settle();
    const state = useDisplayProfile.getState();
    expect(state).toMatchObject({
      status: "active",
      path: ADOBE,
      description: "Adobe RGB (1998) compatible",
    });
    expect(activeMonitorTransform()?.curve).toBe("gamma22");
    expect(read).toHaveBeenCalledWith(ADOBE);
  });

  it("says when it can't read the file", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    updateSettings({ displayProfilePath: "/gone.icc" });
    stop = initDisplayProfile(read);
    await settle();
    expect(useDisplayProfile.getState()).toEqual({
      status: "error",
      path: "/gone.icc",
      error: READ_ERROR,
    });
    expect(activeMonitorTransform()).toBeNull();
  });

  it("says when the file isn't a profile it can use", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    read.mockResolvedValueOnce(new Uint8Array([1, 2, 3]));
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    await settle();
    expect(useDisplayProfile.getState()).toMatchObject({
      status: "error",
      error: PROFILE_ERROR.notIcc,
    });
  });

  it("doesn't stay loading when parsing throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    read.mockResolvedValueOnce(null as unknown as Uint8Array);
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    await settle();
    expect(useDisplayProfile.getState()).toMatchObject({
      status: "error",
      error: PROFILE_ERROR.notIcc,
    });
  });

  it("follows the path when it changes, and turns off when it's cleared", async () => {
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    await settle();
    updateSettings({ displayProfilePath: P3 });
    await settle();
    expect(useDisplayProfile.getState()).toMatchObject({ status: "active", path: P3 });
    expect(activeMonitorTransform()?.curve).toBe("srgb");

    updateSettings({ displayProfilePath: "" });
    await settle();
    expect(useDisplayProfile.getState()).toEqual({ status: "off" });
  });

  it("keeps the newest path when an older read finishes last", async () => {
    let finishAdobe: (bytes: Uint8Array) => void = () => undefined;
    read.mockImplementationOnce(
      () => new Promise<Uint8Array>((resolve) => (finishAdobe = resolve)),
    );
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    updateSettings({ displayProfilePath: P3 });
    await settle();
    finishAdobe(FILES[ADOBE]);
    await settle();
    expect(useDisplayProfile.getState()).toMatchObject({ status: "active", path: P3 });
  });

  it("reads the same file again on reload", async () => {
    updateSettings({ displayProfilePath: ADOBE });
    stop = initDisplayProfile(read);
    await settle();
    await reloadDisplayProfile();
    expect(read.mock.calls).toEqual([[ADOBE], [ADOBE]]);
    expect(useDisplayProfile.getState()).toMatchObject({ status: "active", path: ADOBE });
  });

  it("stops following the path once stopped", async () => {
    stop = initDisplayProfile(read);
    stop();
    updateSettings({ displayProfilePath: ADOBE });
    await settle();
    expect(read).not.toHaveBeenCalled();
  });
});
