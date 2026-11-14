// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Folders an extension keeps across launches (api.project.pickKeptDirectory):
// an export recipe's destination, say. A folder is kept only when the person
// picks it in the native dialog shown here; the extension is handed a random
// token for it, and the path stays in this file's record, so page script can
// never name a folder of its own and have it opened. The renderer reaches this
// through the privileged bridge only (src/native/privileged.ts), which core
// claims at boot and wraps with the asking extension's own id.

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

/** Errors that mean the folder is there but may not be used. */
const REFUSED = new Set(["EACCES", "EPERM"]);

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   pickPath: (event: unknown, defaultPath: string | null) => Promise<string | null>,
 * }} deps
 */
function createKeptFolders({ userData, fileWriter, pickPath }) {
  const file = () => path.join(userData(), "kept-folders.json");
  /** token → the extension that kept it and the folder's path. */
  let kept = null;
  /** The record on disk couldn't be made sense of: it is moved aside before the
   *  first write, so nothing in it is lost without a trace. */
  let damaged = false;

  // A read refused for a moment (antivirus or backup holding the file on
  // Windows) throws and caches nothing, so the next call reads again and no
  // write ever replaces a record that wasn't read.
  function load() {
    if (kept) return kept;
    let text;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return (kept = new Map());
      throw e;
    }
    const read = new Map();
    let saved = null;
    try {
      saved = JSON.parse(text);
    } catch {
      /* damaged, below */
    }
    if (saved && saved.version === 1 && saved.folders && typeof saved.folders === "object") {
      for (const [token, entry] of Object.entries(saved.folders))
        if (entry && typeof entry.extension === "string" && typeof entry.path === "string" && path.isAbsolute(entry.path))
          read.set(token, { extension: entry.extension, path: entry.path });
    } else damaged = true;
    return (kept = read);
  }

  async function save() {
    const out = { version: 1, folders: Object.fromEntries(load()) };
    if (damaged) {
      await fs.promises.rename(file(), `${file()}.bad`);
      damaged = false;
    }
    await fileWriter.write(file(), new TextEncoder().encode(JSON.stringify(out)));
  }

  /** The entry `token` names, if extension `id` kept it. */
  function owned(id, token) {
    const entry = load().get(String(token));
    return entry && entry.extension === String(id) ? entry : null;
  }

  /** Ask the person for a folder for extension `id` and keep it. The dialog
   *  opens at the folder `replacing` names, when that is one of the
   *  extension's. Resolves with `{ token, path }`, or null when cancelled. */
  async function pick(event, id, replacing) {
    // A record that can't be read fails the pick before the dialog asks anything.
    load();
    const previous = replacing == null ? null : owned(id, replacing);
    const chosen = await pickPath(event, previous ? previous.path : null);
    if (!chosen) return null;
    const token = crypto.randomUUID();
    load().set(token, { extension: String(id), path: chosen });
    await save();
    return { token, path: chosen };
  }

  /** The kept folder `token` names for extension `id`: `{ path }`, or `{ error }`:
   *  "unknown" (not kept for it), "gone" (no such folder, or its drive or
   *  share isn't connected) or "unwritable". Nothing is written to find that
   *  out, and libuv's access(W_OK) passes any folder on Windows, so there a
   *  folder whose permissions refuse writes reads as usable: the first write
   *  into it reports it. Rejects, caching nothing, when the record can't be
   *  read just now. */
  async function open(id, token) {
    const entry = owned(id, token);
    if (!entry) return { error: "unknown" };
    let stat;
    try {
      stat = await fs.promises.stat(entry.path);
    } catch (e) {
      return { error: e && REFUSED.has(e.code) ? "unwritable" : "gone" };
    }
    if (!stat.isDirectory()) return { error: "gone" };
    try {
      await fs.promises.access(entry.path, fs.constants.W_OK);
    } catch {
      return { error: "unwritable" };
    }
    return { path: entry.path };
  }

  async function forget(id, token) {
    if (!owned(id, token)) return;
    load().delete(String(token));
    await save();
  }

  /** Forget every folder extension `id` kept: it was uninstalled, and another
   *  extension installed later under its id must not inherit them. */
  async function forgetExtension(id) {
    const all = load();
    const tokens = [...all].filter(([, entry]) => entry.extension === String(id)).map(([token]) => token);
    if (tokens.length === 0) return;
    for (const token of tokens) all.delete(token);
    await save();
  }

  return { pick, open, forget, forgetExtension };
}

module.exports = { createKeptFolders };
