// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Covers the Extensions-store UI state: repo-topic → category mapping, the
// update-check cache and its localStorage mirror (the thing that keeps the 6h
// TTL alive across launches), and the fetch-once-per-repo caching in
// loadRepoMeta / loadReadme. Run with `npm test`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATEGORY_ORDER,
  categoryFor,
  loadReadme,
  loadRepoMeta,
  useExtStoreUI,
  type ExtUpdateInfo,
} from "./store-ui.ts";
import type { ExtensionRepoMeta } from "./types.ts";

const LS_UPDATES = "sl_ext_updates";

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
  } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const update = (over: Partial<ExtUpdateInfo> = {}): ExtUpdateInfo => ({
  latestTag: "2.0.0",
  hasUpdate: true,
  checkedAt: 1_700_000_000_000,
  ...over,
});

const repoMeta = (over: Partial<ExtensionRepoMeta> = {}): ExtensionRepoMeta => ({
  fullName: "acme/tool",
  description: "A tool",
  stars: 12,
  openIssues: 1,
  updatedAt: "2026-01-01T00:00:00Z",
  license: "GPL-3.0",
  topics: ["safelight-panel"],
  homepage: null,
  htmlUrl: "https://github.com/acme/tool",
  defaultBranch: "main",
  ownerLogin: "acme",
  ownerAvatarUrl: null,
  hasIssues: true,
  hasDiscussions: false,
  ogImageUrl: "https://example.test/og.png",
  ...over,
});

/** Only the slice of the Electron bridge store-ui.ts reaches for. */
interface GithubBridge {
  repoMeta: (repo: string) => Promise<ExtensionRepoMeta>;
  readme: (repo: string, ref?: string) => Promise<string | null>;
}

function stubGithub(github?: GithubBridge): void {
  vi.stubGlobal("window", { safelightNative: github ? { github } : {} });
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  useExtStoreUI.setState({
    view: "list",
    selected: null,
    category: "All",
    sort: "popular",
    meta: {},
    readme: {},
    updates: {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("categoryFor", () => {
  it("maps each safelight-* repo topic to its store category", () => {
    expect(categoryFor(["safelight-panel"])).toBe("Panels");
    expect(categoryFor(["safelight-export"])).toBe("Export");
    expect(categoryFor(["safelight-preset"])).toBe("Presets");
    expect(categoryFor(["safelight-color"])).toBe("Color");
    expect(categoryFor(["safelight-theme"])).toBe("Themes");
    expect(categoryFor(["safelight-pipeline"])).toBe("Pipelines");
  });

  it("only ever returns a category the chips can display", () => {
    const topics = [
      "safelight-panel",
      "safelight-export",
      "safelight-preset",
      "safelight-color",
      "safelight-theme",
      "safelight-pipeline",
      "unmapped-topic",
    ];
    for (const t of topics)
      expect(CATEGORY_ORDER).toContain(categoryFor([t]));
  });

  it("falls back to Other for unmapped or missing topics", () => {
    expect(categoryFor()).toBe("Other");
    expect(categoryFor([])).toBe("Other");
    expect(categoryFor(["photography", "webgl"])).toBe("Other");
  });

  it("takes the first mapped topic when a repo carries several", () => {
    expect(categoryFor(["unmapped", "safelight-color", "safelight-theme"])).toBe("Color");
  });

  it("prefers an explicit manifest category over the repo topics", () => {
    expect(categoryFor(["safelight-panel"], ["Export"])).toBe("Export");
  });

  it("ignores manifest categories that are not part of the chip set", () => {
    expect(categoryFor(["safelight-panel"], ["Wizardry"])).toBe("Panels");
    expect(categoryFor(undefined, ["Wizardry"])).toBe("Other");
    expect(categoryFor(["safelight-panel"], ["Wizardry", "Themes"])).toBe("Themes");
  });
});

describe("navigation state", () => {
  it("opens and closes the detail view", () => {
    useExtStoreUI.getState().openDetail("acme/tool");
    expect(useExtStoreUI.getState()).toMatchObject({ view: "detail", selected: "acme/tool" });

    useExtStoreUI.getState().back();
    expect(useExtStoreUI.getState()).toMatchObject({ view: "list", selected: null });
  });

  it("keeps the category and sort filters across a detail round-trip", () => {
    const { setCategory, setSort, openDetail, back } = useExtStoreUI.getState();
    setCategory("Themes");
    setSort("name");
    openDetail("acme/tool");
    back();
    expect(useExtStoreUI.getState()).toMatchObject({ category: "Themes", sort: "name" });
  });
});

describe("update cache", () => {
  it("records a check and mirrors it to localStorage", () => {
    const info = update();
    useExtStoreUI.getState().setUpdate("acme.tool", info);

    expect(useExtStoreUI.getState().updates).toEqual({ "acme.tool": info });
    expect(JSON.parse(storage.getItem(LS_UPDATES) ?? "null")).toEqual({ "acme.tool": info });
  });

  it("overwrites an earlier check for the same extension", () => {
    const { setUpdate } = useExtStoreUI.getState();
    setUpdate("acme.tool", update({ latestTag: "2.0.0" }));
    setUpdate("acme.tool", update({ latestTag: "3.0.0", checkedAt: 1_700_000_001_000 }));

    expect(useExtStoreUI.getState().updates["acme.tool"].latestTag).toBe("3.0.0");
  });

  it("clears one extension's check on uninstall so a reinstall starts cold", () => {
    const { setUpdate, clearUpdate } = useExtStoreUI.getState();
    setUpdate("acme.tool", update());
    setUpdate("other.ext", update());

    clearUpdate("acme.tool");

    expect(Object.keys(useExtStoreUI.getState().updates)).toEqual(["other.ext"]);
    expect(JSON.parse(storage.getItem(LS_UPDATES) ?? "null")).toEqual({
      "other.ext": update(),
    });
  });

  it("leaves the cache untouched when clearing an id that was never checked", () => {
    const before = useExtStoreUI.getState().updates;
    useExtStoreUI.getState().clearUpdate("ghost.ext");

    expect(useExtStoreUI.getState().updates).toBe(before);
    expect(storage.getItem(LS_UPDATES)).toBeNull();
  });

  it("prunes checks for extensions that are no longer installed", () => {
    const { setUpdate, pruneUpdates } = useExtStoreUI.getState();
    setUpdate("kept.ext", update());
    setUpdate("gone.ext", update());

    pruneUpdates(["kept.ext"]);

    expect(Object.keys(useExtStoreUI.getState().updates)).toEqual(["kept.ext"]);
    expect(JSON.parse(storage.getItem(LS_UPDATES) ?? "null")).toEqual({ "kept.ext": update() });
  });

  it("does not rewrite the mirror when pruning drops nothing", () => {
    useExtStoreUI.getState().setUpdate("kept.ext", update());
    const before = useExtStoreUI.getState().updates;

    useExtStoreUI.getState().pruneUpdates(["kept.ext", "not.installed.yet"]);

    expect(useExtStoreUI.getState().updates).toBe(before);
  });
});

describe("update-cache seed from the localStorage mirror", () => {
  async function bootWith(cached: string | null) {
    vi.resetModules();
    vi.stubGlobal(
      "localStorage",
      memoryStorage(cached === null ? {} : { [LS_UPDATES]: cached }),
    );
    return import("./store-ui.ts");
  }

  it("restores well-formed entries so the TTL survives a restart", async () => {
    const info = update();
    const mod = await bootWith(JSON.stringify({ "acme.tool": info }));
    expect(mod.useExtStoreUI.getState().updates).toEqual({ "acme.tool": info });
  });

  it("starts empty when the mirror is missing or unreadable", async () => {
    for (const cached of [null, "{ not json", "null", '"a string"']) {
      const mod = await bootWith(cached);
      expect(mod.useExtStoreUI.getState().updates).toEqual({});
    }
  });

  it("drops entries with no usable timestamp, since the TTL cannot be judged", async () => {
    const mod = await bootWith(
      JSON.stringify({
        good: update(),
        noTimestamp: { latestTag: "2.0.0", hasUpdate: true },
        stringTimestamp: { latestTag: "2.0.0", hasUpdate: true, checkedAt: "yesterday" },
        notAnObject: 7,
      }),
    );
    expect(Object.keys(mod.useExtStoreUI.getState().updates)).toEqual(["good"]);
  });

  it("coerces the stored fields back into shape", async () => {
    const mod = await bootWith(
      JSON.stringify({ "acme.tool": { latestTag: 42, hasUpdate: "yes", checkedAt: 1 } }),
    );
    expect(mod.useExtStoreUI.getState().updates["acme.tool"]).toEqual({
      latestTag: null,
      hasUpdate: true,
      checkedAt: 1,
    });
  });
});

describe("loadRepoMeta", () => {
  it("does nothing without the github bridge", async () => {
    stubGithub();
    await loadRepoMeta("acme/tool");
    expect(useExtStoreUI.getState().meta).toEqual({});
  });

  it("caches the fetched metadata under the repo name", async () => {
    const data = repoMeta();
    stubGithub({ repoMeta: () => Promise.resolve(data), readme: () => Promise.resolve(null) });

    await loadRepoMeta("acme/tool");

    expect(useExtStoreUI.getState().meta["acme/tool"]).toEqual({ status: "ready", data });
  });

  it("fetches each repo once, even when two views ask at the same time", async () => {
    const fetchMeta = vi.fn((repo: string) => Promise.resolve(repoMeta({ fullName: repo })));
    stubGithub({ repoMeta: fetchMeta, readme: () => Promise.resolve(null) });

    await Promise.all([loadRepoMeta("acme/tool"), loadRepoMeta("acme/tool")]);
    await loadRepoMeta("acme/tool");

    expect(fetchMeta).toHaveBeenCalledTimes(1);
  });

  it("records the failure message and allows a later retry", async () => {
    const fetchMeta = vi
      .fn<(repo: string) => Promise<ExtensionRepoMeta>>()
      .mockRejectedValueOnce(new Error("rate limited"))
      .mockResolvedValueOnce(repoMeta());
    stubGithub({ repoMeta: fetchMeta, readme: () => Promise.resolve(null) });

    await loadRepoMeta("acme/tool");
    expect(useExtStoreUI.getState().meta["acme/tool"]).toEqual({
      status: "error",
      error: "rate limited",
    });

    await loadRepoMeta("acme/tool");
    expect(useExtStoreUI.getState().meta["acme/tool"]).toMatchObject({ status: "ready" });
  });

  it("stringifies a non-Error rejection rather than losing it", async () => {
    stubGithub({
      repoMeta: () => Promise.reject("boom"),
      readme: () => Promise.resolve(null),
    });

    await loadRepoMeta("acme/tool");

    expect(useExtStoreUI.getState().meta["acme/tool"]).toEqual({
      status: "error",
      error: "boom",
    });
  });
});

describe("loadReadme", () => {
  it("caches the README against the repo and passes the branch through", async () => {
    const fetchReadme = vi.fn(() => Promise.resolve("# Acme Tool"));
    stubGithub({ repoMeta: () => Promise.resolve(repoMeta()), readme: fetchReadme });

    await loadReadme("acme/tool", "trunk");

    expect(fetchReadme).toHaveBeenCalledWith("acme/tool", "trunk");
    expect(useExtStoreUI.getState().readme["acme/tool"]).toEqual({
      status: "ready",
      data: "# Acme Tool",
    });
  });

  it("caches a missing README so the detail view stops re-asking", async () => {
    const fetchReadme = vi.fn(() => Promise.resolve(null));
    stubGithub({ repoMeta: () => Promise.resolve(repoMeta()), readme: fetchReadme });

    await loadReadme("acme/tool");
    await loadReadme("acme/tool");

    expect(fetchReadme).toHaveBeenCalledTimes(1);
    expect(useExtStoreUI.getState().readme["acme/tool"]).toEqual({ status: "ready", data: null });
  });

  it("does nothing without the github bridge", async () => {
    stubGithub();
    await loadReadme("acme/tool");
    expect(useExtStoreUI.getState().readme).toEqual({});
  });
});
