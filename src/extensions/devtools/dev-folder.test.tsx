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
import { prepareEssentialsMigration } from "../essentials-migration";
import { officialExtension } from "../official-extensions";
import { useExtSettings } from "../ext-settings";
import { EXTENSION_TIMEOUT_MS } from "../guard";

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

// What an extension can reach: it must never be the way the folder is recorded.
const publicSync = vi.fn<(folder: string | null) => Promise<{ pending: string[] }>>();

const stubNative = () =>
  vi.stubGlobal("safelightNative", {
    claimPrivileged: () => ({ fs: fakeFs, updates: {}, devtools: { syncDevFolder: sync } }),
    devtools: { syncDevFolder: publicSync },
  });

beforeEach(() => {
  localStorage.clear();
  sync.mockReset();
  sync.mockResolvedValue({ pending: [] });
  fakeFs.exists.mockReset();
  fakeFs.list.mockReset();
  fakeFs.read.mockReset();
  publicSync.mockReset();
  stubNative();
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

  it("records the folder through the privileged bridge only", async () => {
    setDevFolder(FOLDER);
    initDevFolder();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith(FOLDER));
    expect(publicSync).not.toHaveBeenCalled();
  });
});

describe("a dev folder extension's id", () => {
  const reason = (id: string) => `${id}: extension ids under 'core' are reserved for Safelight`;
  const manifestOf = (id: unknown, repository?: string) => ({
    id,
    name: "Tools",
    version: "1.0.0",
    main: "index.js",
    repository,
  });
  const file = (value: unknown) => ({
    data: new TextEncoder().encode(JSON.stringify(value)),
    mtimeMs: 0,
    size: 0,
  });

  /** The folder is one extension: its own safelight.json at the root. */
  function holdOneExtension(id: unknown, repository?: string): void {
    fakeFs.exists.mockImplementation(async (p) => p === `${FOLDER}\\safelight.json`);
    fakeFs.read.mockImplementation(async () => file(manifestOf(id, repository)));
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
    // The default 1 s runs out when the whole suite loads the machine.
    await vi.waitFor(() => expect(useDevFolder.getState().scanning).toBe(false), { timeout: 4000 });
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

  it.each([
    ["no", undefined],
    ["another", "acme/basic-adjustments"],
  ])(
    "under safelight is refused with %s repository, before its bundle is read",
    async (_label, repository) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      holdOneExtension("safelight.basic", repository);

      await scan();

      const reason =
        "safelight.basic: extension ids under 'safelight' are reserved for Safelight's official extensions";
      expect(useDevFolder.getState().items).toMatchObject([{ status: "error", error: reason }]);
      expect(fakeFs.read).toHaveBeenCalledTimes(1); // the manifest, never index.js
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(reason));
    },
  );

  it("under safelight reaches its bundle from the repository its list row names", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    holdOneExtension("safelight.basic", "anthonyreimche/basic-adjustments");

    await scan();

    expect(fakeFs.read).toHaveBeenCalledWith(`${FOLDER}\\index.js`);
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

describe("a dev folder extension that never finishes loading", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("is given up on, and the extensions after it still load", async () => {
    vi.useFakeTimers();
    const manifestFor = (id: string) => ({
      data: new TextEncoder().encode(JSON.stringify({ id, name: id, version: "1.0.0", main: "index.js" })),
      mtimeMs: 0,
      size: 0,
    });
    fakeFs.list.mockResolvedValue([
      { name: "slow", kind: "directory" },
      { name: "quick", kind: "directory" },
    ]);
    const manifests: Record<string, string> = {
      [`${FOLDER}\\slow\\safelight.json`]: "acme.slow",
      [`${FOLDER}\\quick\\safelight.json`]: "acme.quick",
    };
    fakeFs.exists.mockImplementation(async (p) => p in manifests);
    fakeFs.read.mockImplementation((p: string) =>
      p in manifests ? Promise.resolve(manifestFor(manifests[p])) : new Promise(() => {}),
    );

    setDevFolder(FOLDER);
    initDevFolder();
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);
    expect(fakeFs.read).toHaveBeenCalledWith(`${FOLDER}\\quick\\index.js`);
    await vi.advanceTimersByTimeAsync(EXTENSION_TIMEOUT_MS);

    const timedOut = (id: string) => `${id} did not finish within ${EXTENSION_TIMEOUT_MS / 1000} s`;
    expect(useDevFolder.getState()).toMatchObject({
      scanning: false,
      items: [
        { dir: `${FOLDER}\\slow`, status: "error", error: timedOut("acme.slow") },
        { dir: `${FOLDER}\\quick`, status: "error", error: timedOut("acme.quick") },
      ],
    });
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

// The folder is a setting of the Developer Tools extension, safelight.devtools.
// The built-in it replaces kept it under core.devtools, which the essentials
// migration moves across.
describe("the dev folder setting", () => {
  const stored = (id: string): unknown =>
    JSON.parse(localStorage.getItem(`sl_ext_settings_${id}`) ?? "null");

  beforeEach(() => useExtSettings.setState({}, true));

  it("is kept in Developer Tools' own settings", () => {
    setDevFolder(FOLDER);
    expect(stored("safelight.devtools")).toEqual({ devFolder: FOLDER });
    expect(stored("core.devtools")).toBeNull();
  });

  it("survives the move from the built-in's id", async () => {
    const devtools = officialExtension("safelight.devtools");
    if (!devtools) throw new Error("no official row for Developer Tools");
    localStorage.setItem("sl_ext_default_seeded", JSON.stringify(["core.devtools"]));
    localStorage.setItem("sl_ext_settings_core.devtools", JSON.stringify({ devFolder: FOLDER }));

    prepareEssentialsMigration(localStorage, [devtools]);
    initDevFolder();

    expect(useDevFolder.getState().folder).toBe(FOLDER);
    await vi.waitFor(() => expect(sync).toHaveBeenCalledWith(FOLDER));
  });
});
