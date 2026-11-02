// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the OS hands the app when a photo or folder is opened with it: command
// line paths (Windows, Linux, a second launch) or macOS's open-file event.
// main.cjs owns the events and the IPC; these are the pure halves.

const path = require("node:path");
const fsp = require("node:fs/promises");
const { fileURLToPath } = require("node:url");

const photoTypes = require("./photo-types.json");

const PHOTO_EXTENSIONS = new Set([
  ...Object.keys(photoTypes.standard),
  ...Object.keys(photoTypes.raw),
]);

/** A command line argument as a path: Linux file managers pass file:// URIs.
 *  Null for a URI that names no local path. */
function argPath(arg, cwd) {
  if (!arg.startsWith("file:")) return path.resolve(cwd, arg);
  try {
    return fileURLToPath(arg);
  } catch {
    return null;
  }
}

/** The absolute paths in a command line, each once. Flags are left out, as is
 *  the executable, and in development the app folder electron is started with. */
function argvPaths(argv, { defaultApp, cwd }) {
  const paths = argv
    .slice(defaultApp ? 2 : 1)
    .filter((arg) => arg !== "" && !arg.startsWith("-"))
    .map((arg) => argPath(arg, cwd))
    .filter((p) => p !== null);
  return [...new Set(paths)];
}

/** `argv` without its path arguments, for a relaunch that must not reopen what
 *  the OS first asked for. */
function withoutPaths(argv, { defaultApp }) {
  const kept = defaultApp ? 2 : 1;
  return argv.filter((arg, i) => i < kept || arg.startsWith("-"));
}

/** The folder to open as the project for the first of `paths` that is a folder
 *  or a photo, and for a photo the name to select in it. Null when none is. */
async function openTargetFor(paths) {
  for (const p of paths) {
    try {
      const stat = await fsp.stat(p);
      if (stat.isDirectory()) return { folder: p, file: null };
      if (PHOTO_EXTENSIONS.has(path.extname(p).toLowerCase())) {
        return { folder: path.dirname(p), file: path.basename(p) };
      }
    } catch {
      /* gone, or not readable: try the next */
    }
  }
  return null;
}

/** Puts requests in order when each is resolved asynchronously. The returned
 *  function is called as a request arrives and returns another to call once it
 *  is resolved: true when the request may land, false when a later one already has. */
function createRequestOrder() {
  let issued = 0;
  let landed = 0;
  return () => {
    const mine = ++issued;
    return () => {
      if (mine < landed) return false;
      landed = mine;
      return true;
    };
  };
}

module.exports = { argvPaths, createRequestOrder, openTargetFor, withoutPaths };
