// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Memory cards: the mounted volumes that hold a DCIM folder, the folder every
// camera writes its photos into. Found by looking, with no native module or
// shell: the drive letters on Windows, /Volumes on macOS, the media folders on
// Linux. Every look is a file system call on the libuv pool, which a stalled
// drive (a dropped network share) can hold for minutes, so the looks go one at
// a time, each given a second, and a volume that stalls is left alone for a
// minute. The pages ask through fs:listCards; scans are shared and kept for two
// seconds, however many windows ask.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const TIMEOUT_MS = 1000;
const SKIP_MS = 60_000;
const FRESH_MS = 2000;

const TIMED_OUT = Symbol("timed out");

/** The DCIM folder's birth time and file id, or null when there is none. */
async function probeDcim(dir) {
  try {
    const st = await fs.promises.stat(dir);
    return st.isDirectory() ? { birthtimeMs: st.birthtimeMs, ino: st.ino } : null;
  } catch {
    return null;
  }
}

/**
 * @param {{
 *   platform?: NodeJS.Platform,
 *   probe?: (dcim: string) => Promise<{ birthtimeMs: number, ino: number } | null>,
 *   readdir?: (dir: string) => Promise<string[]>,
 *   realpath?: (p: string) => Promise<string>,
 *   systemDrive?: string,
 *   username?: string,
 *   now?: () => number,
 *   timeoutMs?: number,
 * }} [deps]
 */
function createCardScanner(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const probe = deps.probe ?? probeDcim;
  const readdir = deps.readdir ?? ((dir) => fs.promises.readdir(dir));
  const realpath = deps.realpath ?? ((p) => fs.promises.realpath(p));
  const systemDrive = (deps.systemDrive ?? process.env.SystemDrive ?? "C:").slice(0, 2).toUpperCase();
  const username = deps.username ?? safeUsername();
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? TIMEOUT_MS;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const join = (...parts) => paths.join(...parts);

  /** When each stalled volume may be looked at again. */
  const skipUntil = new Map();
  let last = null;
  let inFlight = null;

  /** `fn()`, or TIMED_OUT once `timeoutMs` passes. */
  function timed(fn) {
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    });
    return Promise.race([Promise.resolve().then(fn), late]).finally(() => clearTimeout(timer));
  }

  async function children(dir) {
    const names = await timed(() => readdir(dir)).catch(() => []);
    return names === TIMED_OUT ? [] : names.map((name) => join(dir, name));
  }

  /** The folders a card could be mounted at, in the order they are listed. */
  async function mountPoints() {
    if (platform === "win32") {
      const letters = [];
      for (let c = 65; c <= 90; c++) {
        const drive = `${String.fromCharCode(c)}:`;
        if (drive !== systemDrive) letters.push(`${drive}\\`);
      }
      return letters;
    }
    if (platform === "darwin") {
      const out = [];
      for (const volume of await children("/Volumes")) {
        const real = await timed(() => realpath(volume)).catch(() => volume);
        if (real !== "/") out.push(volume);
      }
      return out;
    }
    if (platform === "linux") {
      const own = username ? [`/media/${username}`, `/run/media/${username}`] : [];
      const out = [];
      for (const dir of own) out.push(...(await children(dir)));
      for (const mount of await children("/media")) if (!own.includes(mount)) out.push(mount);
      return out;
    }
    return [];
  }

  function nameOf(mount) {
    return platform === "win32" ? mount.slice(0, 2) : path.posix.basename(mount);
  }

  async function scan() {
    const cards = [];
    for (const mount of await mountPoints()) {
      if ((skipUntil.get(mount) ?? 0) > now()) continue;
      const found = await timed(() => probe(join(mount, "DCIM"))).catch(() => null);
      if (found === TIMED_OUT) {
        skipUntil.set(mount, now() + SKIP_MS);
        continue;
      }
      skipUntil.delete(mount);
      if (!found) continue;
      const print = crypto
        .createHash("sha256")
        .update(`${mount}\0${found.birthtimeMs}\0${found.ino}`)
        .digest("hex")
        .slice(0, 16);
      cards.push({ id: print, name: nameOf(mount), path: mount });
    }
    return cards;
  }

  return {
    /** The cards mounted now: `{ id, name, path }` each, `id` new for each card. */
    list() {
      if (last && now() - last.at < FRESH_MS) return Promise.resolve(last.cards);
      if (!inFlight) {
        inFlight = scan()
          .then((cards) => {
            last = { at: now(), cards };
            return cards;
          })
          .finally(() => {
            inFlight = null;
          });
      }
      return inFlight;
    },
  };
}

function safeUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return process.env.USER ?? "";
  }
}

module.exports = { createCardScanner };
