// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Starter kits in the store: the shelf leaves out unverified members and kits
// with nothing left to install; Install all runs setup's queue over what's
// missing and keeps each row's progress in the store.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { kitPending, loadStoreKits, runKitInstall, shelfKits } from "./store-kits";
import { useExtStoreUI } from "./store-ui";
import type { InstallDeps } from "@/modules/welcome/setup/install-queue";
import type { KitExtension, StarterKit } from "@/modules/welcome/setup/kits";
import type { ExtensionManifest, TrustList } from "./types";

const kit = (id: string, repos: string[]): StarterKit => ({
  id,
  name: `Kit ${id}`,
  description: "",
  icon: null,
  extensions: repos.map((repo) => ({ repo, name: repo.split("/")[1], summary: "" })),
});
const trust = (verified: string[]): TrustList => ({ verified, reviewed: {}, repos: [], owners: [], reason: {} });
const manifest = (repo: string): ExtensionManifest => ({
  id: repo.replace("/", "."),
  name: repo,
  version: "1.0.0",
  main: "index.js",
});
const deps = (patch: Partial<InstallDeps> = {}): InstallDeps => ({
  bannedReason: () => null,
  isVerified: () => true,
  checkReview: async () => ({ verified: true, reviewedVersion: null, stale: false, confirmed: true }),
  install: vi.fn(async (repo: string) => manifest(repo)),
  rememberSource: vi.fn(),
  timeoutMs: 1_000,
  where: "its page",
  ...patch,
});

beforeEach(() => {
  vi.unstubAllGlobals();
  useExtStoreUI.setState({ kits: null, kit: null, kitRuns: {}, kitRunning: null });
});

const held = () => {
  let finish!: (m: ExtensionManifest) => void;
  const install = vi.fn(
    () =>
      new Promise<ExtensionManifest>((resolve) => {
        finish = resolve;
      }),
  );
  return { install, finish: (m: ExtensionManifest) => finish(m) };
};

describe("shelfKits and kitPending", () => {
  it("drops unverified members and kits with nothing left to install", () => {
    const kits = [kit("film", ["acme/a", "acme/b"]), kit("done", ["acme/c"]), kit("shady", ["evil/x"])];
    expect(shelfKits(kits, trust(["acme/a", "acme/b", "acme/c"]), new Set(["acme/c"])).map((k) => k.id)).toEqual([
      "film",
    ]);
  });

  it("lists a kit's members that aren't installed", () => {
    expect(kitPending(kit("film", ["acme/a", "acme/b"]), new Set(["acme/a"])).map((e) => e.repo)).toEqual(["acme/b"]);
  });
});

describe("runKitInstall", () => {
  it("installs only what's missing and records every row", async () => {
    const d = deps();
    const done = await runKitInstall(kit("film", ["acme/a", "acme/b"]), new Set(["acme/a"]), d);
    expect(done.map((r) => [r.repo, r.status])).toEqual([["acme/b", "installed"]]);
    expect(useExtStoreUI.getState().kitRuns.film).toEqual(done);
    expect(d.install).toHaveBeenCalledTimes(1);
  });

  it("skips a stale review with the store's wording", async () => {
    const done = await runKitInstall(
      kit("film", ["acme/a"]),
      new Set(),
      deps({ checkReview: async () => ({ verified: true, reviewedVersion: "1.0.0", stale: true, confirmed: true }) }),
    );
    expect(done[0].status).toBe("skipped");
    expect(done[0].detail).toMatch(/install it from its page\.$/);
  });

  it("shows progress while it runs", async () => {
    let finish!: (m: ExtensionManifest) => void;
    const install = vi.fn(
      () =>
        new Promise<ExtensionManifest>((resolve) => {
          finish = resolve;
        }),
    );
    const run = runKitInstall(kit("film", ["acme/a"]), new Set(), deps({ install }));
    // The row reads "installing" before the review check settles; wait for the
    // download itself so `finish` is assigned.
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(useExtStoreUI.getState().kitRuns.film?.[0].status).toBe("installing");
    finish(manifest("acme/a"));
    await run;
    expect(useExtStoreUI.getState().kitRuns.film?.[0].status).toBe("installed");
  });

  it("starts no second run of a kit that is still running", async () => {
    const { install, finish } = held();
    const d = deps({ install });
    const first = runKitInstall(kit("film", ["acme/a"]), new Set(), d);
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    const second = await runKitInstall(kit("film", ["acme/a"]), new Set(), d);
    expect(install).toHaveBeenCalledTimes(1);
    expect(second.map((r) => [r.repo, r.status])).toEqual([["acme/a", "installing"]]);
    finish(manifest("acme/a"));
    await first;
  });

  it("marks the kit running until its run settles", async () => {
    const { install, finish } = held();
    const run = runKitInstall(kit("film", ["acme/a"]), new Set(), deps({ install }));
    expect(useExtStoreUI.getState().kitRunning).toBe("film");
    await vi.waitFor(() => expect(install).toHaveBeenCalled());
    expect(useExtStoreUI.getState().kitRunning).toBe("film");
    finish(manifest("acme/a"));
    await run;
    expect(useExtStoreUI.getState().kitRunning).toBeNull();
  });

  it("clears the running mark after a failed install, and after the run itself throws", async () => {
    const failing = deps({
      install: vi.fn(async (): Promise<ExtensionManifest> => {
        throw new Error("offline");
      }),
    });
    const done = await runKitInstall(kit("film", ["acme/a"]), new Set(), failing);
    expect(done[0].status).toBe("failed");
    expect(useExtStoreUI.getState().kitRunning).toBeNull();

    const broken: StarterKit = {
      id: "film",
      name: "Kit film",
      description: "",
      icon: null,
      get extensions(): KitExtension[] {
        throw new Error("boom");
      },
    };
    await expect(runKitInstall(broken, new Set(), deps())).rejects.toThrow("boom");
    expect(useExtStoreUI.getState().kitRunning).toBeNull();
  });
});

describe("loadStoreKits", () => {
  it("reads kits.json through the bridge", async () => {
    vi.stubGlobal("safelightNative", {
      plugins: {
        kits: async () => ({
          schema: 1,
          kits: [
            {
              id: "film",
              name: "Film looks",
              description: "",
              icon: "film",
              extensions: [{ repo: "Acme/A", name: "A", summary: "" }],
            },
          ],
        }),
      },
    });
    await loadStoreKits();
    expect(useExtStoreUI.getState().kits?.[0]).toMatchObject({
      id: "film",
      icon: "film",
      extensions: [{ repo: "acme/a" }],
    });
  });

  it("leaves kits null when the file is unavailable or broken", async () => {
    vi.stubGlobal("safelightNative", {
      plugins: {
        kits: async () => {
          throw new Error("offline");
        },
      },
    });
    await loadStoreKits();
    expect(useExtStoreUI.getState().kits).toBeNull();
    vi.stubGlobal("safelightNative", { plugins: { kits: async () => ({ schema: 2 }) } });
    await loadStoreKits();
    expect(useExtStoreUI.getState().kits).toBeNull();
  });
});
