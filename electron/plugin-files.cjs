// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// On-disk half of an extension install or update. The new files land in a work
// folder first and the version being replaced is kept aside until the renderer
// has activated the new bundle, so a failed download, an interrupted write, or a
// bundle that won't start never costs the user the copy that was working:
//
//   <userData>/plugins/<id>               the live install (served by app://)
//   <userData>/plugins-update/<id>/next   files being written for this install
//   <userData>/plugins-update/<id>/prev   the version being replaced, until settled
//
// The work area sits beside plugins/, not inside it, so listPlugins and the
// protocol handler's containment check never see it. Operations on one id are
// serialized: a click racing the background poll, or two windows sweeping at
// once, must not interleave rm/rename on the same folders. main.cjs owns the
// real paths and the IPC; this module only moves files, so it runs against temp
// folders in tests.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Windows can hold a just-imported bundle open for a moment; these codes clear
// on their own.
const TRANSIENT = new Set(["EPERM", "EBUSY", "ENOTEMPTY", "EACCES"]);
const RM = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const RM_SYNC = { recursive: true, force: true, maxRetries: 3, retryDelay: 100 };

async function retry(op, { attempts = 5, delayMs = 100 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await op();
    } catch (e) {
      if (attempt >= attempts || !TRANSIENT.has(e && e.code)) throw e;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// True when `child` resolves inside `base`. A path-prefix match is not enough:
// plugins2 must not pass for plugins.
function contains(base, child) {
  const rel = path.relative(base, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function layout(pluginsDir, workDir, id) {
  const work = path.join(workDir, id);
  return {
    install: path.join(pluginsDir, id),
    work,
    next: path.join(work, "next"),
    prev: path.join(work, "prev"),
  };
}

const queues = new Map(); // id -> tail of that id's operation chain

function serialized(id, op) {
  const run = (queues.get(id) ?? Promise.resolve()).catch(() => {}).then(op);
  queues.set(id, run);
  run
    .catch(() => {})
    .finally(() => {
      if (queues.get(id) === run) queues.delete(id);
    });
  return run;
}

async function writeAndSwap({ pluginsDir, workDir, id, files }) {
  const d = layout(pluginsDir, workDir, id);
  await fsp.rm(d.work, RM); // leftovers of an interrupted earlier update
  await fsp.mkdir(d.next, { recursive: true });
  try {
    for (const f of files) {
      const dest = path.join(d.next, f.name);
      if (!contains(d.next, dest)) continue;
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, f.data);
    }
  } catch (e) {
    await fsp.rm(d.work, RM);
    throw e;
  }
  await fsp.mkdir(pluginsDir, { recursive: true });
  const hadPrev = fs.existsSync(d.install);
  if (hadPrev) await retry(() => fsp.rename(d.install, d.prev));
  try {
    await retry(() => fsp.rename(d.next, d.install));
  } catch (e) {
    if (hadPrev) {
      try {
        await retry(() => fsp.rename(d.prev, d.install));
      } catch {
        throw e; // prev stays where it is; sweepPluginWork puts it back at launch
      }
    }
    await fsp.rm(d.work, RM);
    throw e;
  }
  if (!hadPrev) await fsp.rm(d.work, RM); // nothing to settle later
}

/** Put `files` ({ name, data }[]) in place as plugins/<id>, keeping any current
 *  install aside as prev. Throws with the current install untouched if the
 *  files cannot be written or moved into place. */
const replacePlugin = (args) => serialized(args.id, () => writeAndSwap(args));

function readManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "safelight.json"), "utf8"));
  } catch {
    return null;
  }
}

async function finish({ pluginsDir, workDir, id, outcome }) {
  const d = layout(pluginsDir, workDir, id);
  let restored = null;
  if (outcome === "rollback") {
    await fsp.rm(d.install, RM);
    if (fs.existsSync(d.prev)) {
      await retry(() => fsp.rename(d.prev, d.install));
      restored = readManifest(d.install);
    }
  }
  await fsp.rm(d.work, RM);
  return restored;
}

/** Finish an update. "keep" drops prev. "rollback" removes the new install,
 *  puts prev back, and returns its manifest — or null when there was no prev
 *  (a first install that failed to start), in which case nothing remains. */
const settlePlugin = (args) => serialized(args.id, () => finish(args));

/** Startup only, before any renderer exists. A prev still in the work area
 *  belongs to an update that was never settled — the new bundle's activation
 *  was never confirmed — so the previous version goes back and the work area is
 *  cleared. When in doubt, the version that worked wins. */
function sweepPluginWork({ pluginsDir, workDir }) {
  try {
    if (!fs.existsSync(workDir)) return;
    for (const entry of fs.readdirSync(workDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const d = layout(pluginsDir, workDir, entry.name);
      if (!fs.existsSync(d.prev)) continue;
      fs.rmSync(d.install, RM_SYNC);
      fs.renameSync(d.prev, d.install);
    }
    fs.rmSync(workDir, RM_SYNC);
  } catch {
    // A locked leftover is harmless; the next launch tries again.
  }
}

module.exports = { replacePlugin, settlePlugin, sweepPluginWork, retry, contains };
