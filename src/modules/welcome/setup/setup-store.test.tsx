// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The setup store: the once-per-launch first-run decision, how closing is
// recorded, and loading the kits with the trust list and what's installed.
// The seam is the Electron bridge (window.safelightNative).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rememberSource } from "@/extensions/sources";
import { useTrust } from "@/extensions/trust";
import { SETUP_RECORD_KEY } from "./first-run";
import { waitingRow } from "./install-queue";
import {
  closeSetup,
  initFirstRun,
  openSetup,
  resetSetupForTests,
  retrySetupInstall,
  setupPending,
  startSetupInstalls,
  toggleSetupExtension,
  toggleSetupKit,
  useSetupStore,
} from "./setup-store";
import {
  EMPTY_TRUST,
  manifestFor,
  ONE,
  stubBridge,
  THREE,
  trustList,
  TWO,
  type FakeBridge,
} from "./setup.test-support";

const FRESH = {
  countRecentProjects: async () => 0,
  countInstalledExtensions: async () => 0,
  hasSavedPreferences: () => false,
};
const record = () => JSON.parse(localStorage.getItem(SETUP_RECORD_KEY) ?? "null");
const writeRecord = (outcome: string) =>
  localStorage.setItem(
    SETUP_RECORD_KEY,
    JSON.stringify({ outcome, at: 1, appVersion: "3.0.0" }),
  );
const kitsReady = () =>
  vi.waitFor(() => expect(useSetupStore.getState().kits.status).toBe("ready"));

let bridge: FakeBridge;

beforeEach(() => {
  localStorage.clear();
  resetSetupForTests();
  bridge = stubBridge();
  useTrust.setState({ list: EMPTY_TRUST, loadedAt: 0 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("initFirstRun", () => {
  it("stays closed without the desktop bridge and records nothing", async () => {
    vi.stubGlobal("safelightNative", undefined);
    await initFirstRun(FRESH);
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toBeNull();
  });

  it("opens first-run setup on a fresh profile and marks it in progress", async () => {
    await initFirstRun(FRESH);
    const s = useSetupStore.getState();
    expect([s.phase, s.mode, s.step]).toEqual(["open", "first-run", "look"]);
    expect(record()).toMatchObject({
      outcome: "in-progress",
      appVersion: __APP_VERSION__,
    });
  });

  it("marks an existing profile as not needing setup", async () => {
    await initFirstRun({ ...FRESH, countRecentProjects: async () => 2 });
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toMatchObject({ outcome: "not-needed" });
  });

  it("doesn't look at the profile once setup was finished", async () => {
    writeRecord("finished");
    const countRecentProjects = vi.fn(async () => 0);
    await initFirstRun({ ...FRESH, countRecentProjects });
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(countRecentProjects).not.toHaveBeenCalled();
  });

  it("reopens a first run left in progress", async () => {
    writeRecord("in-progress");
    await initFirstRun({ ...FRESH, countRecentProjects: async () => 5 });
    const s = useSetupStore.getState();
    expect([s.phase, s.mode]).toEqual(["open", "first-run"]);
  });

  it("stays closed for this launch when the profile can't be read in time", async () => {
    vi.useFakeTimers();
    const decided = initFirstRun(
      { ...FRESH, countRecentProjects: () => new Promise<number>(() => {}) },
      3_000,
    );
    await vi.advanceTimersByTimeAsync(3_000);
    await decided;
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toBeNull();
  });

  it.each([
    ["a fresh profile", 0, null],
    ["an existing profile", 2, "not-needed"],
  ])(
    "leaves a setup opened while the decision was pending, on %s",
    async (_label, recentProjects, outcome) => {
      let release!: (count: number) => void;
      const countRecentProjects = vi.fn(
        () => new Promise<number>((r) => (release = r)),
      );
      const decided = initFirstRun({ ...FRESH, countRecentProjects });
      await vi.waitFor(() => expect(countRecentProjects).toHaveBeenCalled());
      openSetup("rerun", "extensions");
      release(recentProjects);
      await decided;
      const s = useSetupStore.getState();
      expect([s.phase, s.mode, s.step]).toEqual(["open", "rerun", "extensions"]);
      expect(record()?.outcome ?? null).toBe(outcome);
    },
  );

  it("decides once per launch", async () => {
    const countRecentProjects = vi.fn(async () => 0);
    await Promise.all([
      initFirstRun({ ...FRESH, countRecentProjects }),
      initFirstRun({ ...FRESH, countRecentProjects }),
    ]);
    expect(countRecentProjects).toHaveBeenCalledTimes(1);
  });
});

describe("closeSetup", () => {
  it("records a finished first run", () => {
    openSetup("first-run");
    closeSetup("finished");
    expect(useSetupStore.getState().phase).toBe("closed");
    expect(record()).toMatchObject({ outcome: "finished" });
  });

  it("records a skipped first run", () => {
    openSetup("first-run");
    closeSetup("skipped");
    expect(record()).toMatchObject({ outcome: "skipped" });
  });

  it("leaves the record alone on a rerun", () => {
    writeRecord("finished");
    openSetup("rerun");
    closeSetup("skipped");
    expect(record()).toMatchObject({ outcome: "finished" });
  });

  it("won't close while installs are running", () => {
    openSetup("first-run");
    useSetupStore.setState({ installing: true });
    closeSetup("skipped");
    expect(useSetupStore.getState().phase).toBe("open");
  });
});

describe("openSetup", () => {
  it("opens a rerun at the requested step with nothing picked", () => {
    useSetupStore.setState({ selected: [ONE], expandedKit: "film" });
    openSetup("rerun", "extensions");
    const s = useSetupStore.getState();
    expect([s.phase, s.mode, s.step]).toEqual(["open", "rerun", "extensions"]);
    expect(s.selected).toEqual([]);
    expect(s.expandedKit).toBeNull();
    expect(s.installs).toBeNull();
  });

  it("does nothing while installs are running", () => {
    openSetup("first-run", "finish");
    const installs = [waitingRow({ repo: ONE, name: "One", summary: "" })];
    useSetupStore.setState({ installs, installing: true });
    bridge.kits.mockClear();
    bridge.list.mockClear();
    openSetup("rerun");
    const s = useSetupStore.getState();
    expect([s.phase, s.mode, s.step]).toEqual(["open", "first-run", "finish"]);
    expect(s.installs).toBe(installs);
    expect(s.installing).toBe(true);
    expect(bridge.kits).not.toHaveBeenCalled();
    expect(bridge.list).not.toHaveBeenCalled();
  });

  it("loads the kits together with the trust list", async () => {
    openSetup("first-run");
    await kitsReady();
    const kits = useSetupStore.getState().kits;
    expect(kits.status === "ready" && kits.kits.map((k) => k.id)).toEqual([
      "film",
      "colour",
    ]);
    expect(useTrust.getState().list.verified).toEqual([ONE, TWO, THREE]);
  });

  it.each([
    ["the bridge returns nothing", (b: FakeBridge) => b.kits.mockResolvedValue(null)],
    ["the bridge fails", (b: FakeBridge) => b.kits.mockRejectedValue(new Error("x"))],
    ["the file lists no kits", (b: FakeBridge) => b.kits.mockResolvedValue({ schema: 1, kits: [] })],
  ])("reports the kits as unavailable when %s", async (_label, arrange) => {
    arrange(bridge);
    openSetup("first-run");
    await vi.waitFor(() =>
      expect(useSetupStore.getState().kits.status).toBe("unavailable"),
    );
  });

  it("reports the kits as unavailable on a bridge without kits", async () => {
    vi.stubGlobal("safelightNative", { plugins: { list: async () => [] } });
    openSetup("first-run");
    await vi.waitFor(() =>
      expect(useSetupStore.getState().kits.status).toBe("unavailable"),
    );
  });

  it("knows which extensions are installed, by recorded source or manifest", async () => {
    rememberSource("acme.two", "Acme/Two");
    bridge.list.mockResolvedValue([
      manifestFor(ONE, { repository: "Acme/One" }),
      manifestFor(TWO),
      manifestFor("acme/local"),
    ]);
    openSetup("first-run");
    await vi.waitFor(() =>
      expect(useSetupStore.getState().installed).toEqual([ONE, TWO]),
    );
  });
});

describe("installs", () => {
  // A row update that throws (here a failing subscriber) must still end the
  // install state, or setup could never be closed.
  const throwOnFirstInstallingRow = () => {
    let thrown = false;
    return useSetupStore.subscribe((s) => {
      if (thrown || !s.installs?.some((r) => r.status === "installing")) return;
      thrown = true;
      throw new Error("subscriber failed");
    });
  };

  it("stops installing when the queue throws", async () => {
    openSetup("first-run", "finish");
    await kitsReady();
    toggleSetupExtension(ONE);
    const unsubscribe = throwOnFirstInstallingRow();
    await expect(startSetupInstalls()).rejects.toThrow("subscriber failed");
    unsubscribe();
    expect(useSetupStore.getState().installing).toBe(false);
  });

  it("stops installing when a retry throws", async () => {
    openSetup("first-run", "finish");
    const failed = waitingRow({ repo: ONE, name: "One", summary: "" });
    useSetupStore.setState({ installs: [{ ...failed, status: "failed" }] });
    const unsubscribe = throwOnFirstInstallingRow();
    await expect(retrySetupInstall(ONE)).rejects.toThrow("subscriber failed");
    unsubscribe();
    expect(useSetupStore.getState().installing).toBe(false);
  });
});

describe("setupPending", () => {
  it("lists picked extensions the trust list still allows", async () => {
    openSetup("first-run");
    await kitsReady();
    const kits = useSetupStore.getState().kits;
    if (kits.status !== "ready") throw new Error("kits not loaded");
    toggleSetupKit(kits.kits[0]);
    const state = useSetupStore.getState();
    expect(setupPending(state).map((e) => e.repo)).toEqual([ONE, TWO]);
    expect(setupPending(state, trustList({ verified: [ONE] })).map((e) => e.repo)).toEqual([ONE]);
  });

  it("is empty until the kits are ready", () => {
    expect(
      setupPending({ kits: { status: "loading" }, selected: [ONE], installed: [] }),
    ).toEqual([]);
  });
});
