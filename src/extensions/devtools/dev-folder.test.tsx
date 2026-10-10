// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A dev-folder extension's declared network origins reach the app's
// content-security policy the way an installed extension's do: the main
// process reads the folder's manifests at launch, so the renderer must record
// the folder with it and tell the developer which origins wait on a restart.
// An extension under a reserved id ("core", "core.*") is refused before its
// bundle is read.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { initDevFolder, setDevFolder, teardownDevFolder, useDevFolder } from "./dev-folder";
import { DevFolderControls } from "./DevFolderControls";

const FOLDER = "D:\\Repositories\\Extensions";
const TILES = "https://tiles.openfreemap.org";

const sync = vi.fn<(folder: string | null) => Promise<{ pending: string[] }>>();
// privileged.ts claims the bridge once per module instance, so the same fake
// filesystem serves every test here; unless a test says otherwise, a scan of it
// finds no extensions.
const fakeFs = {
  exists: vi.fn<(path: string) => Promise<boolean>>(async () => false),
  list: vi.fn<(path: string) => Promise<{ name: string; kind: "file" | "directory" }[]>>(
    async () => [],
  ),
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
  fakeFs.exists.mockReset();
  fakeFs.list.mockReset();
  fakeFs.read.mockReset();
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

describe("a dev folder extension's id", () => {
  const reason = (id: string) => `${id}: extension ids under 'core' are reserved for Safelight`;
  const manifestOf = (id: unknown) => ({ id, name: "Tools", version: "1.0.0", main: "index.js" });
  const file = (value: unknown) => ({
    data: new TextEncoder().encode(JSON.stringify(value)),
    mtimeMs: 0,
    size: 0,
  });

  /** The folder is one extension: its own safelight.json at the root. */
  function holdOneExtension(id: unknown): void {
    fakeFs.exists.mockImplementation(async (p) => p === `${FOLDER}\\safelight.json`);
    fakeFs.read.mockImplementation(async () => file(manifestOf(id)));
  }

  /** The folder holds each subfolder as one extension, with the manifest id it maps to. */
  function holdExtensions(idByDir: Record<string, string>): void {
    const manifests = new Map(
      Object.entries(idByDir).map(([dir, id]) => [`${FOLDER}\\${dir}\\safelight.json`, id]),
    );
    fakeFs.list.mockResolvedValue(
      Object.keys(idByDir).map((name) => ({ name, kind: "directory" as const })),
    );
    fakeFs.exists.mockImplementation(async (p) => manifests.has(p));
    fakeFs.read.mockImplementation(async (p) => file(manifestOf(manifests.get(p) ?? "")));
  }

  async function scan(): Promise<void> {
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(useDevFolder.getState().scanning).toBe(false));
  }

  afterEach(() => vi.restoreAllMocks());

  it.each(["core.hsl", "core", "Core.Tools"])(
    "under core is refused before its bundle is read, and the log says why (%s)",
    async (id) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      holdOneExtension(id);

      await scan();

      expect(useDevFolder.getState().items).toMatchObject([
        { status: "error", error: reason(id) },
      ]);
      expect(fakeFs.read).toHaveBeenCalledTimes(1); // the manifest, never index.js
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason(id)));
    },
  );

  it("under core is refused in a parent folder, a lookalike id reaches its bundle", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    holdExtensions({ tools: "core.tools", lookalike: "corel" });

    await scan();

    const [tools] = useDevFolder.getState().items;
    expect(tools).toMatchObject({ status: "error", error: reason("core.tools") });
    expect(fakeFs.read).not.toHaveBeenCalledWith(`${FOLDER}\\tools\\index.js`);
    expect(fakeFs.read).toHaveBeenCalledWith(`${FOLDER}\\lookalike\\index.js`);
  });

  // A manifest is untyped JSON: whatever is not text cannot be an id, and the
  // rule that compares ids must never see it.
  it.each([5, true, ["core"], {}])("that is not text counts as missing (%j)", async (id) => {
    holdOneExtension(id);

    await scan();

    expect(useDevFolder.getState().items).toMatchObject([
      { status: "error", error: "safelight.json is missing `id` or `main`" },
    ]);
    expect(fakeFs.read).toHaveBeenCalledTimes(1); // the manifest, never index.js
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
