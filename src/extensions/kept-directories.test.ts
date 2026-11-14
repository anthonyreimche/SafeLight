// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.project's kept folders: on the desktop the main process keeps the record
// (electron/kept-folders.cjs) and core names the asking extension; in the
// browser a picked folder is kept until the page loads again.

import { describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "./api/native-bridge";
import { keptDirectoriesAPI } from "./kept-directories";

type Kept = Required<Pick<NativeFsBridge, "pickKeptFolder" | "keptFolder" | "forgetKeptFolder">>;

const handleFor = (path: string) => ({ kind: "directory", name: path, path }) as unknown as FileSystemDirectoryHandle;

function desktop(kept: Partial<Kept> = {}) {
  const bridge = {
    pickKeptFolder: vi.fn<Kept["pickKeptFolder"]>(async () => ({ token: "t1", path: "D:\\Out" })),
    keptFolder: vi.fn<Kept["keptFolder"]>(async () => ({ path: "D:\\Out" })),
    forgetKeptFolder: vi.fn<Kept["forgetKeptFolder"]>(async () => undefined),
    ...kept,
  };
  const pickBrowser = vi.fn(async () => null);
  const api = keptDirectoriesAPI("ext.recipes", {
    bridge: () => bridge as unknown as NativeFsBridge,
    handleFor,
    pickBrowser,
  });
  return { api, bridge, pickBrowser };
}

describe("a kept folder on the desktop", () => {
  it("is picked in the native dialog for the asking extension, at the folder it replaces", async () => {
    const { api, bridge, pickBrowser } = desktop();
    const picked = await api.pickKeptDirectory("recipe-1", "t0");
    expect(bridge.pickKeptFolder).toHaveBeenCalledWith("ext.recipes", "t0");
    expect(picked).toEqual({ token: "t1", folder: handleFor("D:\\Out") });
    expect(pickBrowser).not.toHaveBeenCalled();

    await api.pickKeptDirectory("recipe-1");
    expect(bridge.pickKeptFolder).toHaveBeenLastCalledWith("ext.recipes", null);
  });

  it("is nothing when the dialog is cancelled", async () => {
    const { api } = desktop({ pickKeptFolder: async () => null });
    expect(await api.pickKeptDirectory("recipe-1")).toBeNull();
  });

  it("opens by its token for the asking extension", async () => {
    const { api, bridge } = desktop();
    expect(await api.openKeptDirectory("t1")).toEqual({ folder: handleFor("D:\\Out") });
    expect(bridge.keptFolder).toHaveBeenCalledWith("ext.recipes", "t1");
  });

  it.each(["gone", "unwritable", "unknown"] as const)("says when it is %s", async (error) => {
    const { api } = desktop({ keptFolder: async () => ({ error }) });
    expect(await api.openKeptDirectory("t1")).toEqual({ problem: error });
  });

  it("is forgotten for the asking extension", async () => {
    const { api, bridge } = desktop();
    await api.forgetKeptDirectory("t1");
    expect(bridge.forgetKeptFolder).toHaveBeenCalledWith("ext.recipes", "t1");
  });
});

describe("a kept folder in the browser", () => {
  function browser(extensionId = "ext.recipes", folder: FileSystemDirectoryHandle | null = handleFor("Out")) {
    const pickBrowser = vi.fn(async () => folder);
    const api = keptDirectoriesAPI(extensionId, { bridge: () => null, handleFor, pickBrowser });
    return { api, pickBrowser };
  }

  it("is picked with the browser's picker and opens by its token until the page loads again", async () => {
    const { api, pickBrowser } = browser();
    const picked = await api.pickKeptDirectory("recipe-1");
    expect(pickBrowser).toHaveBeenCalledWith("recipe-1");
    expect(picked?.folder).toEqual(handleFor("Out"));
    expect(await api.openKeptDirectory(picked!.token)).toEqual({ folder: handleFor("Out") });
  });

  it("opens only for the extension that picked it, and not once forgotten", async () => {
    const { api } = browser();
    const { token } = (await api.pickKeptDirectory("recipe-1"))!;
    expect(await browser("ext.other").api.openKeptDirectory(token)).toEqual({ problem: "unknown" });
    await browser("ext.other").api.forgetKeptDirectory(token);
    expect(await api.openKeptDirectory(token)).toEqual({ folder: handleFor("Out") });
    await api.forgetKeptDirectory(token);
    expect(await api.openKeptDirectory(token)).toEqual({ problem: "unknown" });
  });

  it("is nothing when the picker is cancelled", async () => {
    expect(await browser("ext.recipes", null).api.pickKeptDirectory("recipe-1")).toBeNull();
  });
});
