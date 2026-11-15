// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Advisory lock files shared by the app and `slu`: <project>/.safelight/writer.lock
// and <userData>/plugins.lock. A lock is taken by creating the file exclusively and
// holds JSON naming its holder plus a token only that holder knows. A holder
// refreshes the file's mtime every REFRESH_MS. The next acquirer takes a lock over
// once its holder on this machine has exited, or, for a holder elsewhere (a project
// on a shared drive), once nobody has refreshed it for STALE_MS. The app's writer
// lock refresh (project-storage.ts LOCK_REFRESH_MS) keeps to REFRESH_MS.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const STALE_MS = 15 * 60_000;
const REFRESH_MS = 5 * 60_000;

// Windows answers EPERM or EACCES, not EEXIST, while a lock file another process
// deleted is still being let go of.
const HELD_CODES = new Set(["EEXIST", "EPERM", "EACCES"]);

/** @typedef {{ app: "safelight" | "slu", pid: number, host: string, since: number, refreshedAt: number }} LockInfo */

/** The holder's details, without the token that would let a reader release it. */
function infoOf(doc, mtimeMs) {
  const num = (v, fallback) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  return {
    app: doc && doc.app === "slu" ? "slu" : "safelight",
    pid: num(doc && doc.pid, 0),
    host: doc && typeof doc.host === "string" ? doc.host : "",
    since: num(doc && doc.since, mtimeMs),
    refreshedAt: num(doc && doc.refreshedAt, mtimeMs),
  };
}

/** The lock file's parsed content and mtime, or null when there is none. An
 *  unreadable body still counts as a lock: its mtime decides when it goes stale. */
async function load(file) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return null;
  }
  let doc = null;
  try {
    doc = JSON.parse(await fs.promises.readFile(file, "utf8"));
  } catch {
    /* half-written or corrupt */
  }
  return { doc, mtimeMs: st.mtimeMs };
}

/** Whether the holder has exited. Only a process on this machine can be asked; a
 *  pid from another one means nothing here. */
function holderGone(heldBy) {
  if (heldBy.host !== os.hostname() || !(heldBy.pid > 0)) return false;
  try {
    process.kill(heldBy.pid, 0);
    return false;
  } catch (e) {
    return !!e && e.code === "ESRCH";
  }
}

/** Who holds the lock, or null when nobody does. */
async function readLock(file) {
  const held = await load(file);
  return held ? infoOf(held.doc, held.mtimeMs) : null;
}

/**
 * Take the lock. `{ ok: true, token }` on success, with `tookOverStale` when it
 * replaced a lock nobody had refreshed for `staleMs`, or whose holder on this machine
 * had exited; `{ ok: false, heldBy }` when
 * someone else holds it.
 * @param {string} file
 * @param {"safelight" | "slu"} owner
 * @param {{ staleMs?: number, now?: () => number }} [options]
 */
async function acquireLock(file, owner, { staleMs = STALE_MS, now = Date.now } = {}) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  let tookOverStale;
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = crypto.randomBytes(16).toString("hex");
    const at = now();
    const body = { app: owner, pid: process.pid, host: os.hostname(), since: at, refreshedAt: at, token };
    try {
      await fs.promises.writeFile(file, JSON.stringify(body), { flag: "wx" });
      return tookOverStale ? { ok: true, token, tookOverStale } : { ok: true, token };
    } catch (e) {
      if (!e || !HELD_CODES.has(e.code)) throw e;
    }
    const held = await load(file);
    if (!held) continue;
    const heldBy = infoOf(held.doc, held.mtimeMs);
    if (now() - held.mtimeMs <= staleMs && !holderGone(heldBy)) return { ok: false, heldBy };
    // Two acquirers can both find it stale, and the other may already have put a
    // fresh lock in its place. The file is moved aside and checked before it is
    // deleted: a fresh one goes back, and the exclusive create above settles which
    // acquirer wins once the stale one is gone.
    const aside = `${file}.stale-${token}`;
    try {
      await fs.promises.rename(file, aside);
    } catch (e) {
      if (e && e.code === "ENOENT") continue;
      throw e;
    }
    const moved = await load(aside);
    const sameLock = moved && moved.mtimeMs === held.mtimeMs && (moved.doc && moved.doc.token) === (held.doc && held.doc.token);
    if (sameLock) tookOverStale = heldBy;
    else await fs.promises.link(aside, file).catch(() => {});
    await fs.promises.rm(aside, { force: true });
  }
  // A lock being deleted can't be read either; it counts as held, holder unknown.
  return { ok: false, heldBy: (await readLock(file)) ?? infoOf(null, now()) };
}

/** Touch the lock so it isn't taken as stale. False when the token isn't the holder's.
 *  The file is read and rewritten through one handle that never creates it, so a
 *  release landing meanwhile is not undone by this write. */
async function refreshLock(file, token) {
  let fh;
  try {
    fh = await fs.promises.open(file, "r+");
  } catch (e) {
    if (e && e.code === "ENOENT") return false;
    throw e;
  }
  try {
    let doc = null;
    try {
      doc = JSON.parse(await fh.readFile("utf8"));
    } catch {
      /* half-written or corrupt */
    }
    if (!doc || doc.token !== token) return false;
    // Written over the old body in place, then cut to length: never an empty file
    // that a release reading it meanwhile would take for someone else's.
    const body = Buffer.from(JSON.stringify({ ...doc, refreshedAt: Date.now() }), "utf8");
    await fh.write(body, 0, body.length, 0);
    await fh.truncate(body.length);
    return true;
  } finally {
    await fh.close();
  }
}

/** Give the lock up. Only the holder's token releases it; false when it isn't theirs. */
async function releaseLock(file, token) {
  const held = await load(file);
  if (!held || !held.doc || held.doc.token !== token) return false;
  await fs.promises.rm(file, { force: true });
  return true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` holding the lock, waiting up to `waitMs` for another holder to let go.
 * Rejects when it can't be taken in that time. The lock is kept fresh while `fn`
 * runs, and always released.
 * @param {string} file
 * @param {"safelight" | "slu"} owner
 * @param {() => Promise<T>} fn
 * @param {{ waitMs?: number, pollMs?: number, staleMs?: number, refreshMs?: number }} [options]
 * @template T
 */
async function withLock(file, owner, fn, { waitMs = 0, pollMs = 100, staleMs, refreshMs = REFRESH_MS } = {}) {
  const deadline = Date.now() + waitMs;
  let got = await acquireLock(file, owner, { staleMs });
  while (!got.ok) {
    if (Date.now() >= deadline) {
      const err = new Error(`${file} is held by ${got.heldBy.app} (pid ${got.heldBy.pid})`);
      err.code = "ELOCKED";
      err.heldBy = got.heldBy;
      throw err;
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
    got = await acquireLock(file, owner, { staleMs });
  }
  const { token } = got;
  const keepFresh = setInterval(() => void refreshLock(file, token).catch(() => {}), refreshMs);
  keepFresh.unref();
  try {
    return await fn();
  } finally {
    clearInterval(keepFresh);
    await releaseLock(file, token).catch(() => {});
  }
}

module.exports = { STALE_MS, REFRESH_MS, acquireLock, refreshLock, releaseLock, readLock, withLock };
