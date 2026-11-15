// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The lock files the app and `slu` share (file-lock.cjs), against temp folders.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFRESH_MS, STALE_MS, acquireLock, readLock, refreshLock, releaseLock, withLock } from "./file-lock.cjs";

/** The pid of a process that has already exited. */
const deadPid = (): number => spawnSync(process.execPath, ["-e", ""]).pid;

const lockOf = (pid: number, host: string) =>
  JSON.stringify({ app: "safelight", pid, host, since: Date.now(), refreshedAt: Date.now(), token: "theirs" });

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-lock-"));
  file = path.join(dir, "writer.lock");
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("acquireLock", () => {
  it("creates the lock file naming its holder", async () => {
    const got = await acquireLock(file, "slu");
    expect(got.ok).toBe(true);
    const body = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(body).toMatchObject({ app: "slu", pid: process.pid, token: (got as { token: string }).token });
    await expect(readLock(file)).resolves.toMatchObject({ app: "slu", pid: process.pid });
    expect(await readLock(file)).not.toHaveProperty("token");
  });

  it("tells a second acquirer who holds it", async () => {
    await acquireLock(file, "safelight");
    const second = await acquireLock(file, "slu");
    expect(second).toMatchObject({ ok: false, heldBy: { app: "safelight", pid: process.pid } });
  });

  it("makes the folder it lives in", async () => {
    const nested = path.join(dir, "a", "b", "plugins.lock");
    expect((await acquireLock(nested, "slu")).ok).toBe(true);
  });

  it("takes over a lock nobody refreshed within staleMs, and says whose it was", async () => {
    await acquireLock(file, "safelight");
    const later = () => Date.now() + 200_000;
    const taken = await acquireLock(file, "slu", { staleMs: 180_000, now: later });
    expect(taken).toMatchObject({ ok: true, tookOverStale: { app: "safelight" } });
    await expect(readLock(file)).resolves.toMatchObject({ app: "slu" });
  });

  it("doesn't delete a fresh lock another acquirer put in place of the stale one it saw", async () => {
    await acquireLock(file, "safelight");
    let late = 2;
    const now = () => (late-- > 0 ? Date.now() + 200_000 : Date.now());
    let interfered = false;
    const interfere = () => {
      if (interfered) return;
      interfered = true;
      fs.rmSync(file);
      fs.writeFileSync(file, JSON.stringify({ app: "safelight", pid: 1, host: "", since: 1, refreshedAt: 1, token: "fresh" }));
    };
    const realRename = fs.promises.rename.bind(fs.promises);
    const realRm = fs.promises.rm.bind(fs.promises);
    const renameSpy = vi.spyOn(fs.promises, "rename").mockImplementation(async (from, to) => (interfere(), realRename(from, to)));
    const rmSpy = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => (interfere(), realRm(target, options)));
    const second = await acquireLock(file, "slu", { staleMs: 180_000, now });
    renameSpy.mockRestore();
    rmSpy.mockRestore();
    expect(second.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).token).toBe("fresh");
    expect(fs.readdirSync(dir)).toEqual(["writer.lock"]);
  });

  it("leaves a lock inside staleMs alone", async () => {
    await acquireLock(file, "safelight");
    const soon = () => Date.now() + 100_000;
    expect((await acquireLock(file, "slu", { staleMs: 180_000, now: soon })).ok).toBe(false);
  });

  it("treats a corrupt lock file as held until it is stale", async () => {
    fs.writeFileSync(file, "{not json");
    expect((await acquireLock(file, "slu")).ok).toBe(false);
    const later = () => Date.now() + STALE_MS + 1_000;
    expect((await acquireLock(file, "slu", { now: later })).ok).toBe(true);
  });

  it("takes over at once a fresh lock whose holder on this machine has exited", async () => {
    fs.writeFileSync(file, lockOf(deadPid(), os.hostname()));
    expect(await acquireLock(file, "slu")).toMatchObject({ ok: true, tookOverStale: { app: "safelight" } });
  });

  it("leaves a fresh lock alone while its holder on this machine runs", async () => {
    fs.writeFileSync(file, lockOf(process.pid, os.hostname()));
    expect((await acquireLock(file, "slu")).ok).toBe(false);
  });

  it("judges a lock from another machine by its age alone", async () => {
    fs.writeFileSync(file, lockOf(deadPid(), `${os.hostname()}-elsewhere`));
    expect((await acquireLock(file, "slu")).ok).toBe(false);
  });

  it("is refreshed well inside the time another machine waits before taking it over", () => {
    expect(STALE_MS).toBeGreaterThanOrEqual(3 * REFRESH_MS);
  });

  it.each(["EPERM", "EACCES"])("reads %s on create, as Windows gives for a lock being deleted, as held", async (code) => {
    const realWrite = fs.promises.writeFile.bind(fs.promises);
    let failures = 1;
    vi.spyOn(fs.promises, "writeFile").mockImplementation(async (...args: Parameters<typeof realWrite>) => {
      if (failures-- > 0) throw Object.assign(new Error(code), { code });
      return realWrite(...args);
    });
    await expect(withLock(file, "slu", async () => "done", { waitMs: 2000, pollMs: 10 })).resolves.toBe("done");
  });
});

describe("refreshLock and releaseLock", () => {
  it("refresh moves the file's mtime forward for the holder only", async () => {
    const got = await acquireLock(file, "slu");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    expect(await refreshLock(file, "wrong")).toBe(false);
    expect(fs.statSync(file).mtimeMs).toBeLessThan(Date.now() - 100_000);
    expect(await refreshLock(file, (got as { token: string }).token)).toBe(true);
    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(Date.now() - 10_000);
  });

  it("only the token holder releases", async () => {
    const got = await acquireLock(file, "slu");
    expect(await releaseLock(file, "wrong")).toBe(false);
    expect(fs.existsSync(file)).toBe(true);
    expect(await releaseLock(file, (got as { token: string }).token)).toBe(true);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("answers a missing lock with false", async () => {
    expect(await refreshLock(file, "t")).toBe(false);
    expect(await releaseLock(file, "t")).toBe(false);
    expect(await readLock(file)).toBeNull();
  });

  it("never brings back a lock released while a refresh runs", async () => {
    for (let i = 0; i < 20; i++) {
      const got = await acquireLock(file, "slu");
      if (!got.ok) throw new Error("not taken");
      const [released] = await Promise.all([releaseLock(file, got.token), refreshLock(file, got.token)]);
      expect(released).toBe(true);
      expect(await readLock(file)).toBeNull();
    }
  });
});

describe("withLock", () => {
  it("holds the lock while it runs and lets go after, even when it throws", async () => {
    await expect(
      withLock(file, "slu", async () => {
        expect(fs.existsSync(file)).toBe(true);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(file)).toBe(false);
  });

  it("waits for a holder to let go", async () => {
    const held = await acquireLock(file, "safelight");
    setTimeout(() => void releaseLock(file, (held as { token: string }).token), 60);
    await expect(withLock(file, "slu", async () => "done", { waitMs: 2000, pollMs: 10 })).resolves.toBe("done");
  });

  it("gives up after waitMs, naming the holder", async () => {
    await acquireLock(file, "safelight");
    await expect(withLock(file, "slu", async () => "no", { waitMs: 50, pollMs: 10 })).rejects.toMatchObject({
      code: "ELOCKED",
      heldBy: { app: "safelight" },
    });
  });
});
