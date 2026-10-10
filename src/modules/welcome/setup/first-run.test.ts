// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Setup opens by itself only on a fresh profile, once. An upgrader is never
// interrupted, and a first run abandoned halfway comes back next launch even
// though step 1 already saved a theme.

import { describe, expect, it } from "vitest";
import {
  decideFirstRun,
  gatherProfileSignals,
  readSetupRecord,
  SETUP_RECORD_KEY,
  writeSetupRecord,
  type ProfileSignals,
  type SetupRecord,
} from "./first-run";

const memory = (init: Record<string, string> = {}) => {
  const map = new Map(Object.entries(init));
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  };
};
const FRESH: ProfileSignals = {
  recentProjects: 0,
  installedExtensions: 0,
  savedPreferences: false,
};
const record = (outcome: SetupRecord["outcome"]): SetupRecord => ({
  outcome,
  at: 1,
  appVersion: "3.0.0",
});

describe("setup record", () => {
  it("is absent on a fresh profile", () => {
    expect(readSetupRecord(memory())).toBeNull();
  });

  it.each(["{oops", "null", "[]", '"finished"', '{"outcome":"maybe"}'])(
    "ignores an unreadable record %s",
    (raw) => {
      expect(readSetupRecord(memory({ [SETUP_RECORD_KEY]: raw }))).toBeNull();
    },
  );

  it("reads back what was written", () => {
    const store = memory();
    writeSetupRecord(store, "skipped", "3.0.0", 42);
    expect(JSON.parse(store.map.get(SETUP_RECORD_KEY)!)).toEqual({
      outcome: "skipped",
      at: 42,
      appVersion: "3.0.0",
    });
    expect(readSetupRecord(store)).toEqual({
      outcome: "skipped",
      at: 42,
      appVersion: "3.0.0",
    });
  });

  it("fills in missing fields of an otherwise valid record", () => {
    expect(
      readSetupRecord(memory({ [SETUP_RECORD_KEY]: '{"outcome":"finished"}' })),
    ).toEqual({ outcome: "finished", at: 0, appVersion: "" });
  });

  it("survives storage that refuses reads and writes", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("quota");
      },
    };
    expect(readSetupRecord(broken)).toBeNull();
    expect(() => writeSetupRecord(broken, "finished", "3.0.0")).not.toThrow();
  });
});

describe("decideFirstRun", () => {
  it("reopens setup that was left in progress", () => {
    expect(decideFirstRun(record("in-progress"), null)).toBe("open");
  });

  it.each(["finished", "skipped", "not-needed"] as const)(
    "stays closed after %s",
    (outcome) => {
      expect(decideFirstRun(record(outcome), FRESH)).toBe("closed");
    },
  );

  it("stays closed when the profile couldn't be read in time", () => {
    expect(decideFirstRun(null, null)).toBe("closed");
  });

  it("opens on a fresh profile", () => {
    expect(decideFirstRun(null, FRESH)).toBe("open");
  });

  it.each([
    { recentProjects: 1 },
    { installedExtensions: 2 },
    { savedPreferences: true },
  ])("treats %j as an existing profile", (patch) => {
    expect(decideFirstRun(null, { ...FRESH, ...patch })).toBe("existing-profile");
  });
});

describe("gatherProfileSignals", () => {
  it("counts recents and installed extensions", async () => {
    expect(
      await gatherProfileSignals({
        countRecentProjects: async () => 3,
        countInstalledExtensions: async () => 1,
        hasSavedPreferences: () => true,
      }),
    ).toEqual({ recentProjects: 3, installedExtensions: 1, savedPreferences: true });
  });

  it("counts a source that fails as empty", async () => {
    expect(
      await gatherProfileSignals({
        countRecentProjects: async () => Promise.reject(new Error("idb")),
        countInstalledExtensions: () => {
          throw new Error("sync");
        },
        hasSavedPreferences: () => {
          throw new Error("storage");
        },
      }),
    ).toEqual(FRESH);
  });
});
