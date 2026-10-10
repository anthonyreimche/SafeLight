// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The setup's installs: the store's checks per item, one download at a time,
// bounded by a timeout, and a breaker so a hung connection can't stall setup
// once per extension.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReviewCheck } from "@/extensions/install-gate";
import type { ExtensionManifest } from "@/extensions/types";
import {
  installOne,
  needsRestart,
  runSetupInstalls,
  waitingRow,
  type InstallDeps,
  type InstallRow,
} from "./install-queue";

const manifest = (id: string, network?: string[]): ExtensionManifest => ({
  id,
  name: id,
  version: "1.0.0",
  main: "index.js",
  ...(network ? { permissions: { network } } : {}),
});
const row = (repo: string): InstallRow =>
  waitingRow({ repo, name: repo.split("/")[1], summary: "" });
const deps = (patch: Partial<InstallDeps> = {}): InstallDeps => ({
  bannedReason: () => null,
  isVerified: () => true,
  checkReview: async () => ({
    verified: true,
    reviewedVersion: null,
    stale: false,
    confirmed: true,
  }),
  install: vi.fn(async (repo: string) => manifest(repo.replace("/", "."))),
  rememberSource: vi.fn(),
  timeoutMs: 1_000,
  ...patch,
});
const never = () => new Promise<ExtensionManifest>(() => {});
const neverReviewed = () => new Promise<ReviewCheck>(() => {});

afterEach(() => {
  vi.useRealTimers();
});

describe("installOne", () => {
  it("installs a verified extension and remembers its repo", async () => {
    const d = deps();
    expect(await installOne(row("acme/one"), d)).toEqual({
      repo: "acme/one",
      name: "one",
      status: "installed",
      detail: "",
      network: [],
    });
    expect(d.install).toHaveBeenCalledWith("acme/one");
    expect(d.rememberSource).toHaveBeenCalledWith("acme.one", "acme/one");
  });

  it("skips a banned repo without downloading it", async () => {
    const d = deps({ bannedReason: () => "steals tokens" });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "skipped",
      detail: "Blocked: steals tokens.",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("skips a repo that left the verified list", async () => {
    const d = deps({ isVerified: () => false });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "skipped",
      detail: "Not on the verified list any more.",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("skips a repo whose newest version is past the review", async () => {
    const d = deps({
      checkReview: async () => ({
        verified: true,
        reviewedVersion: "1.2.0",
        stale: true,
        confirmed: true,
      }),
    });
    const result = await installOne(row("acme/one"), d);
    expect(result.status).toBe("skipped");
    expect(result.detail).toMatch(/reviewed up to 1\.2\.0/);
    expect(result.detail).toMatch(/install it from Extensions/);
    expect(d.install).not.toHaveBeenCalled();
  });

  it("skips a repo whose review couldn't be confirmed", async () => {
    const d = deps({
      checkReview: async () => ({
        verified: true,
        reviewedVersion: "1.2.0",
        stale: false,
        confirmed: false,
      }),
    });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "skipped",
      detail:
        "Couldn't confirm the reviewed version right now. You can install it from Extensions.",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("times out a review check that never answers, without downloading", async () => {
    vi.useFakeTimers();
    const d = deps({ checkReview: neverReviewed });
    const pending = installOne(row("acme/one"), d);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({
      status: "timed-out",
      detail: "Couldn't confirm the reviewed version in time, so nothing was downloaded.",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("gives the review check and the download one deadline between them", async () => {
    vi.useFakeTimers();
    const after = <T,>(ms: number, value: T) =>
      new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));
    const d = deps({
      checkReview: () =>
        after(600, { verified: true, reviewedVersion: null, stale: false, confirmed: true }),
      install: () => after(600, manifest("acme.one")),
    });
    const pending = installOne(row("acme/one"), d);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe("timed-out");
  });

  it("reports a review check that fails, without downloading", async () => {
    const d = deps({ checkReview: async () => Promise.reject(new Error("rate limited")) });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "failed",
      detail: "rate limited",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("reports a ban check that throws", async () => {
    const d = deps({
      bannedReason: () => {
        throw new Error("trust list unreadable");
      },
    });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "failed",
      detail: "trust list unreadable",
    });
    expect(d.install).not.toHaveBeenCalled();
  });

  it("reports an install that throws before it returns a promise", async () => {
    const d = deps({
      install: () => {
        throw new Error("bridge missing");
      },
    });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "failed",
      detail: "bridge missing",
    });
  });

  it("reports a failed install with its error", async () => {
    const d = deps({
      install: async () => Promise.reject(new Error("GitHub download failed (502)")),
    });
    expect(await installOne(row("acme/one"), d)).toMatchObject({
      status: "failed",
      detail: "GitHub download failed (502)",
    });
    expect(d.rememberSource).not.toHaveBeenCalled();
  });

  it("records the network access an extension declares", async () => {
    const d = deps({ install: async () => manifest("acme.map", ["https://tiles.example"]) });
    expect((await installOne(row("acme/map"), d)).network).toEqual([
      "https://tiles.example",
    ]);
  });

  it("times out a download that never settles", async () => {
    vi.useFakeTimers();
    const pending = installOne(row("acme/slow"), deps({ install: never }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({
      status: "timed-out",
      detail: "Still downloading. It may finish in the background; check Extensions later.",
    });
  });

  it("still remembers a download that lands after its timeout", async () => {
    vi.useFakeTimers();
    const d = deps({
      install: () =>
        new Promise((resolve) => setTimeout(() => resolve(manifest("acme.slow")), 2_000)),
    });
    const pending = installOne(row("acme/slow"), d);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).status).toBe("timed-out");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(d.rememberSource).toHaveBeenCalledWith("acme.slow", "acme/slow");
  });

  it("swallows a download that fails after its timeout", async () => {
    vi.useFakeTimers();
    const d = deps({
      install: () =>
        new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 2_000)),
    });
    const pending = installOne(row("acme/slow"), d);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await pending).status).toBe("timed-out");
  });
});

describe("runSetupInstalls", () => {
  it("installs in order and reports every step", async () => {
    const d = deps();
    const seen: string[] = [];
    const done = await runSetupInstalls([row("acme/one"), row("acme/two")], d, (r) =>
      seen.push(`${r.repo} ${r.status}`),
    );
    expect(seen).toEqual([
      "acme/one installing",
      "acme/one installed",
      "acme/two installing",
      "acme/two installed",
    ]);
    expect(done.map((r) => r.status)).toEqual(["installed", "installed"]);
  });

  it("keeps going after a failure", async () => {
    const install = vi
      .fn<(repo: string) => Promise<ExtensionManifest>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(manifest("acme.two"));
    const done = await runSetupInstalls([row("acme/one"), row("acme/two")], deps({ install }), () => {});
    expect(done.map((r) => r.status)).toEqual(["failed", "installed"]);
  });

  it("skips the rest after two timeouts in a row", async () => {
    vi.useFakeTimers();
    const install = vi.fn(never);
    const run = runSetupInstalls(
      [row("acme/a"), row("acme/b"), row("acme/c"), row("acme/d")],
      deps({ install }),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const done = await run;
    expect(done.map((r) => r.status)).toEqual(["timed-out", "timed-out", "skipped", "skipped"]);
    expect(done[2].detail).toBe("GitHub isn't responding. Try again from Extensions.");
    expect(install).toHaveBeenCalledTimes(2);
  });

  it("counts a review check that timed out towards the two", async () => {
    vi.useFakeTimers();
    const checkReview = vi.fn(neverReviewed);
    const d = deps({ checkReview });
    const run = runSetupInstalls(
      [row("acme/a"), row("acme/b"), row("acme/c")],
      d,
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await run).map((r) => r.status)).toEqual([
      "timed-out",
      "timed-out",
      "skipped",
    ]);
    expect(checkReview).toHaveBeenCalledTimes(2);
    expect(d.install).not.toHaveBeenCalled();
  });

  it("starts counting again after a download that answers", async () => {
    vi.useFakeTimers();
    const install = vi
      .fn<(repo: string) => Promise<ExtensionManifest>>()
      .mockImplementationOnce(never)
      .mockResolvedValueOnce(manifest("acme.b"))
      .mockImplementationOnce(never)
      .mockResolvedValueOnce(manifest("acme.d"));
    const run = runSetupInstalls(
      [row("acme/a"), row("acme/b"), row("acme/c"), row("acme/d")],
      deps({ install }),
      () => {},
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await run).map((r) => r.status)).toEqual([
      "timed-out",
      "installed",
      "timed-out",
      "installed",
    ]);
  });
});

describe("needsRestart", () => {
  it("names installed extensions that declared network access", () => {
    const rows: InstallRow[] = [
      { ...row("acme/map"), status: "installed", network: ["https://tiles.example"] },
      { ...row("acme/plain"), status: "installed" },
      { ...row("acme/broken"), status: "failed", network: ["https://x.example"] },
    ];
    expect(needsRestart(rows)).toEqual(["map"]);
  });
});
