// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The main-process half of the renderer's fs.write. A write goes to a temp
// sibling, is synced, then renamed over the target, so a crash or a quit midway
// leaves the previous file whole: a truncated catalog.json would look like a
// new folder and trigger a full re-import. Every window shares one writer, so
// writes to one file are queued: one in flight plus the newest waiting, never
// two renames racing onto the same target. main.cjs owns the IPC and the quit
// drain; this module runs against temp folders in tests.

const path = require("node:path");

function createAtomicWriter({ fsp, randomId, retry }) {
  const slots = new Map(); // normalised path -> { next: job | null }
  let idle = [];

  const keyOf = (p) => {
    const abs = path.resolve(p);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };

  async function land(p, bytes) {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${randomId()}`;
    try {
      const fh = await fsp.open(tmp, "w");
      try {
        await fh.writeFile(bytes);
        await fh.sync();
      } finally {
        await fh.close();
      }
      // Windows briefly locks a file the indexer or antivirus is reading.
      await retry(() => fsp.rename(tmp, p));
    } catch (err) {
      await fsp.unlink(tmp).catch(() => {});
      throw err;
    }
  }

  async function pump(key, slot, job) {
    let current = job;
    while (current) {
      try {
        await land(current.path, current.bytes);
        for (const waiter of current.waiters) waiter.resolve();
      } catch (err) {
        for (const waiter of current.waiters) waiter.reject(err);
      }
      current = slot.next;
      slot.next = null;
    }
    slots.delete(key);
    if (slots.size === 0) {
      for (const resolve of idle) resolve();
      idle = [];
    }
  }

  /** Put `bytes` at `p`. With a write to `p` already in flight, this replaces
   *  any write still waiting behind it and resolves once the newest lands. */
  function write(p, bytes) {
    return new Promise((resolve, reject) => {
      const key = keyOf(p);
      const waiter = { resolve, reject };
      const slot = slots.get(key);
      if (!slot) {
        const fresh = { next: null };
        slots.set(key, fresh);
        pump(key, fresh, { path: p, bytes, waiters: [waiter] });
      } else if (slot.next) {
        slot.next.path = p;
        slot.next.bytes = bytes;
        slot.next.waiters.push(waiter);
      } else {
        slot.next = { path: p, bytes, waiters: [waiter] };
      }
    });
  }

  /** Resolves once nothing is in flight or waiting. */
  function drain() {
    if (slots.size === 0) return Promise.resolve();
    return new Promise((resolve) => idle.push(resolve));
  }

  /** How many files have a write in flight. */
  const activePaths = () => slots.size;

  return { write, drain, activePaths };
}

module.exports = { createAtomicWriter };
