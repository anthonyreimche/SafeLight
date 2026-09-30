// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A dev-folder extension's declared network origins reach the app's
// content-security policy the way an installed extension's do: the main
// process reads the folder's manifests at launch, so the renderer must record
// the folder with it and tell the developer which origins wait on a restart.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { initDevFolder, setDevFolder, teardownDevFolder, useDevFolder } from "./dev-folder";
import { DevFolderControls } from "./DevFolderControls";

const FOLDER = "D:\\Repositories\\Extensions";
const TILES = "https://tiles.openfreemap.org";

const sync = vi.fn<(folder: string | null) => Promise<{ pending: string[] }>>();
// privileged.ts claims the bridge once per module instance, so the same fake
// filesystem serves every test here; a scan of it finds no extensions.
const fakeFs = {
  exists: vi.fn(async () => false),
  list: vi.fn(async () => []),
  read: vi.fn(),
  pickDirectory: vi.fn(),
};

const stubNative = (devtools: object) =>
  vi.stubGlobal("safelightNative", {
    claimPrivileged: () => ({ fs: fakeFs, updates: {} }),
    devtools,
  });

beforeEach(() => {
  localStorage.clear();
  sync.mockReset();
  sync.mockResolvedValue({ pending: [] });
  stubNative({ syncDevFolder: sync });
  useDevFolder.setState({ folder: null, items: [], scanning: false, error: null, pendingOrigins: [] });
});

afterEach(() => {
  teardownDevFolder();
  cleanup();
  vi.unstubAllGlobals();
});

describe("dev folder network origins", () => {
  it("records the configured folder at start and shows the origins a restart would allow", async () => {
    sync.mockResolvedValue({ pending: [TILES] });
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(useDevFolder.getState().pendingOrigins).toEqual([TILES]));
    expect(sync).toHaveBeenCalledWith(FOLDER);
  });

  it("records a change of folder and clears the notice once nothing is pending", async () => {
    sync.mockResolvedValue({ pending: [TILES] });
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(useDevFolder.getState().pendingOrigins).toEqual([TILES]));
    sync.mockResolvedValue({ pending: [] });
    setDevFolder(null);
    await vi.waitFor(() => expect(sync).toHaveBeenLastCalledWith(null));
    await vi.waitFor(() => expect(useDevFolder.getState().pendingOrigins).toEqual([]));
  });

  it("records no folder at start when none is configured", async () => {
    initDevFolder();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith(null));
  });

  it("drops the folder from the policy when Developer Tools is disabled", async () => {
    sync.mockResolvedValue({ pending: [TILES] });
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(useDevFolder.getState().pendingOrigins).toEqual([TILES]));
    teardownDevFolder();
    expect(sync).toHaveBeenLastCalledWith(null);
    expect(useDevFolder.getState().pendingOrigins).toEqual([]);
  });

  it("leaves an older desktop build without the bridge alone", async () => {
    stubNative({});
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(useDevFolder.getState().scanning).toBe(false));
    expect(useDevFolder.getState().pendingOrigins).toEqual([]);
  });
});

describe("DevFolderControls", () => {
  it.each(["tab", "settings"] as const)("says which origins wait on a restart (%s)", (variant) => {
    useDevFolder.setState({ folder: FOLDER, pendingOrigins: [TILES, "https://api.example.com"] });
    render(<DevFolderControls variant={variant} />);
    expect(screen.getByRole("status").textContent).toBe(
      "Restart Safelight to allow network access to https://tiles.openfreemap.org, https://api.example.com.",
    );
  });

  it("shows no notice while nothing is pending", () => {
    useDevFolder.setState({ folder: FOLDER, pendingOrigins: [] });
    render(<DevFolderControls variant="tab" />);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
