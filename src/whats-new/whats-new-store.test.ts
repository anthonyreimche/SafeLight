import { beforeEach, describe, expect, test } from "vitest";
import { WHATS_NEW_KEY } from "./decide";
import { closeWhatsNew, initWhatsNew, openWhatsNew, useWhatsNew } from "./whats-new-store";

const SOURCE = [
  "## [Unreleased]",
  "",
  "### Planned",
  "- Later",
  "",
  "## [3.2.7] - 2026-11-24",
  "",
  "### Added",
  "- **Lens Blur** — new.",
  "",
  "## [3.2.6] - 2026-11-19",
  "",
  "### Fixed",
  "- A crash.",
].join("\n");

function memoryStore(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data };
}

const shown = () => useWhatsNew.getState().releases?.map((r) => r.version) ?? null;

beforeEach(() => closeWhatsNew());

describe("on launch", () => {
  test("an update opens the notes since the version last seen, and remembers this one", () => {
    const store = memoryStore({ [WHATS_NEW_KEY]: "3.2.5" });
    initWhatsNew({ store, current: "3.2.7", newInstall: false, source: SOURCE });
    expect(shown()).toEqual(["3.2.7", "3.2.6"]);
    expect(store.data.get(WHATS_NEW_KEY)).toBe("3.2.7");
  });

  test("a new install stays closed but starts counting from this version", () => {
    const store = memoryStore();
    initWhatsNew({ store, current: "3.2.7", newInstall: true, source: SOURCE });
    expect(shown()).toBeNull();
    expect(store.data.get(WHATS_NEW_KEY)).toBe("3.2.7");
  });

  test("the same version again stays closed", () => {
    const store = memoryStore({ [WHATS_NEW_KEY]: "3.2.7" });
    initWhatsNew({ store, current: "3.2.7", newInstall: false, source: SOURCE });
    expect(shown()).toBeNull();
  });

  test("an update with no notes stays closed and is still remembered", () => {
    const store = memoryStore({ [WHATS_NEW_KEY]: "3.2.7" });
    initWhatsNew({ store, current: "3.2.8", newInstall: false, source: SOURCE });
    expect(shown()).toBeNull();
    expect(store.data.get(WHATS_NEW_KEY)).toBe("3.2.8");
  });
});

describe("from the About section", () => {
  test("opens the running version's notes, and closes", () => {
    openWhatsNew({ current: "3.2.6", source: SOURCE });
    expect(shown()).toEqual(["3.2.6"]);
    closeWhatsNew();
    expect(shown()).toBeNull();
  });

  test("a version without notes opens the newest release's notes instead", () => {
    openWhatsNew({ current: "3.2.8", source: SOURCE });
    expect(shown()).toEqual(["3.2.7"]);
  });
});
