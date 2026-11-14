// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Native file bridge. Lets the renderer read/write the open project folder by
// absolute path instead of through File System Access handles. Paths don't
// expire across sessions the way FSA permissions do, so the originals reconnect
// on launch with no user gesture (Lightroom-style). Trust scope: windows only
// ever hold the app's own index (window-policy.cjs), and every fs:* call is
// refused unless it comes from such a document's top frame, so every channel
// here is privileged.

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { readFileRange } = require("../file-range.cjs");
const { createKeptFolders } = require("../kept-folders.cjs");

// Base directory for "separate" catalogues: the user's override if set, else a
// stable folder under the app's userData. Shared by the resolve + list handlers
// so they always agree on where catalogues live.
function externalCatalogBase(userDataDir, baseOverride) {
  return baseOverride && String(baseOverride).trim()
    ? path.resolve(String(baseOverride))
    : path.join(userDataDir, "external-catalogs");
}

// Where the per-source "spillover pointer" lives: a tiny file recording which
// separate catalogue a read-only source spilled into. Kept under the app-data
// DEFAULT (never the user's chosen base) and keyed by a hash of the source path,
// so a later writeable open finds the spillover to fold back regardless of which
// "Separate catalogue location" is configured at that time. One file per source →
// no shared-index contention; writes are atomic (temp + rename).
function spilloverPointerPath(userDataDir, rootPath) {
  const src = path.resolve(String(rootPath));
  const tag = crypto.createHash("sha1").update(src).digest("hex");
  return path.join(userDataDir, "external-catalogs", ".pointers", `${tag}.json`);
}

// The "<leaf>-<tag>" a source's separate catalogues are named by (see
// fs:externalCatalogDir).
function catalogStem(src) {
  const tag = crypto.createHash("sha1").update(src).digest("hex").slice(0, 8);
  const leaf = path.basename(src).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "folder";
  return `${leaf}-${tag}`;
}

// Whether a scan walking into the folder `link` resolves to would find what it
// finds anyway: the folder is `dir` or one above it (it would come back round
// forever), or lies inside the project folder `root` (its photos twice), by real
// path. A link out of the project, to a NAS share or another drive, is followed.
async function walkedAnyway(dir, link, root) {
  const target = await fs.promises.realpath(link).catch(() => null);
  if (target === null) return false;
  if (root) {
    const inside = await fs.promises.realpath(root).catch(() => null);
    if (inside !== null && target.startsWith(inside.endsWith(path.sep) ? inside : inside + path.sep))
      return true;
  }
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    if ((await fs.promises.realpath(at).catch(() => null)) === target) return true;
    if (path.dirname(at) === at) return false;
  }
}

// One listing entry. A link (a symlink, or a junction on Windows) is listed as what
// it points to; a broken one as a folder, whose own listing then fails, so the scan
// marks it unreadable instead of dropping what it held. A folder link the walk
// would find anyway is left out (walkedAnyway). With `withSizes`, files carry their
// size, for telling a photo's file from another of the same name; it costs a stat
// per file, a round trip each on a network share, so only the scan asks.
async function listEntry(dir, d, root, withSizes) {
  const full = path.join(dir, d.name);
  if (d.isDirectory()) return { name: d.name, kind: "directory" };
  if (d.isFile() && !withSizes) return { name: d.name, kind: "file" };
  let st;
  try {
    st = await fs.promises.stat(full);
  } catch {
    return d.isSymbolicLink() ? { name: d.name, kind: "directory" } : { name: d.name, kind: "file" };
  }
  if (!st.isDirectory()) return withSizes ? { name: d.name, kind: "file", size: st.size } : { name: d.name, kind: "file" };
  return (await walkedAnyway(dir, full, root)) ? null : { name: d.name, kind: "directory" };
}

// How many entries of one listing are looked at a time: a folder of thousands of
// photos on a network share would otherwise open thousands of stats at once.
const LIST_CONCURRENCY = 16;

// `fn` over `items`, at most `limit` at a time, the results in the items' order.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Recursive size of a directory in bytes. Best-effort: symlinks aren't followed
// (lstat) so it can't loop, and any unreadable entry is skipped. Used on demand
// by the Stored-catalogues manager, never on a hot path.
async function dirSizeBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) total += await dirSizeBytes(p);
      else if (e.isFile()) total += (await fs.promises.lstat(p)).size;
    } catch {
      /* skip unreadable entry */
    }
  }
  return total;
}

// The preload stringifies every path, so a renderer bug that passes undefined
// arrives as "undefined": relative, it would resolve against the main process's
// working directory. Mutating channels take absolute paths only.
function absolutePath(p) {
  if (typeof p !== "string" || p === "" || !path.isAbsolute(p))
    throw new Error(`Refused a path that isn't absolute: ${JSON.stringify(p)}`);
  return p;
}

// A drive, filesystem or network-share root, which no remove or move may take.
function notRoot(p) {
  const at = path.resolve(absolutePath(p));
  if (at === path.parse(at).root) throw new Error(`Refused a filesystem root: ${p}`);
  return p;
}

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: Uint8Array): Promise<void> },
 *   shell: Pick<Electron.Shell, "trashItem" | "openPath" | "showItemInFolder">,
 *   dialog: Pick<Electron.Dialog, "showOpenDialog">,
 *   BrowserWindow: { fromWebContents(contents: Electron.WebContents): Electron.BrowserWindow | null },
 *   onUninstalled?: (forget: (id: string) => Promise<void>) => void,
 * }} deps
 */
function fsChannels({ userData, fileWriter, shell, dialog, BrowserWindow, onUninstalled }) {
  const kept = createKeptFolders({
    userData,
    fileWriter,
    pickPath: async (e, defaultPath) => {
      const win = BrowserWindow.fromWebContents(e.sender);
      const { canceled, filePaths } = await dialog.showOpenDialog(win, {
        properties: ["openDirectory"],
        ...(defaultPath ? { defaultPath } : {}),
      });
      return canceled || !filePaths[0] ? null : filePaths[0];
    },
  });
  if (onUninstalled) onUninstalled((id) => kept.forgetExtension(id));
  return [
    // With a range, only those bytes cross (file-range.cjs): the import reads a
    // RAW's head and camera preview, not the whole file.
    {
      channel: "fs:read",
      privileged: true,
      handler: async (_e, p, range) => {
        if (range) return readFileRange(p, range.start, range.end);
        const st = await fs.promises.stat(p);
        const data = await fs.promises.readFile(p); // Buffer → Uint8Array in renderer
        return { data, mtimeMs: st.mtimeMs, size: st.size };
      },
    },
    // Atomic, ordered per file (atomic-write.cjs). The write is queued before the
    // handler returns, so a window's last flush is already pending at will-quit.
    {
      channel: "fs:write",
      privileged: true,
      handler: async (_e, p, data) =>
        fileWriter.write(absolutePath(p), data instanceof Uint8Array ? data : Buffer.from(data)),
    },
    {
      channel: "fs:list",
      privileged: true,
      // `root` is the project folder the listing is for, if any (walkedAnyway).
      // `withSizes` asks for each file's size (listEntry).
      handler: async (_e, p, root, withSizes) => {
        let ents;
        try {
          ents = await fs.promises.readdir(p, { withFileTypes: true });
        } catch (e) {
          // A missing dir lists empty, like FSA; a broken link fails (listEntry).
          if (e && e.code === "ENOENT") {
            const link = await fs.promises.lstat(p).then((st) => st.isSymbolicLink(), () => false);
            if (!link) return [];
          }
          // Only the message crosses IPC; lead it with the errno so the renderer
          // can tell a folder it may not list (EACCES/EPERM) from any other failure.
          if (e && typeof e.code === "string" && !String(e.message).startsWith(`${e.code}:`))
            throw Object.assign(new Error(`${e.code}: ${e.message}`), { code: e.code });
          throw e;
        }
        const listed = await mapLimit(ents, LIST_CONCURRENCY, (d) => listEntry(p, d, root, withSizes === true));
        return listed.filter((entry) => entry !== null);
      },
    },
    {
      channel: "fs:mkdir",
      privileged: true,
      handler: async (_e, p) => {
        await fs.promises.mkdir(absolutePath(p), { recursive: true });
      },
    },
    // Resolve a "separate" .safelight working directory for a project folder — used
    // when the source can't host its own (a read-only memory card) or when the user
    // picked "Separate folder" in Preferences. The catalog/previews/RAW cache live
    // here instead, under `baseOverride` if set, otherwise under the app's userData.
    // Keyed by a hash of the source path so every folder keeps its own stable
    // catalogue and two folders at different paths never collide.
    //   create === false → existence probe: returns the dir iff a catalogue already
    //     lives here (so a redirected source keeps its catalogue instead of being
    //     orphaned when it later becomes writeable), else null. Creates nothing.
    //   create !== false → creates the directory (so a write failure surfaces, e.g.
    //     an unwriteable override) and returns its absolute path. Idempotent: an
    //     existing catalogue is left untouched.
    //   variant > 1 → the source's further catalogues, "<leaf>-<tag>-<n>": what
    //     another card mounted at the same path keeps (see working-dir.ts).
    {
      channel: "fs:externalCatalogDir",
      privileged: true,
      handler: async (_e, rootPath, baseOverride, create, variant) => {
        const src = path.resolve(String(rootPath));
        const base = externalCatalogBase(userData(), baseOverride);
        const suffix = Number.isSafeInteger(variant) && variant > 1 ? `-${variant}` : "";
        const parent = path.join(base, `${catalogStem(src)}${suffix}`);
        const dir = path.join(parent, ".safelight");
        if (create === false) {
          try {
            await fs.promises.access(path.join(dir, "catalog.json"));
            return dir;
          } catch {
            return null;
          }
        }
        await fs.promises.mkdir(dir, { recursive: true });
        // Record the source path (once) so the "Stored catalogues" manager can show
        // which folder an orphaned catalogue belonged to — the tag is a one-way hash.
        const meta = path.join(parent, "source.json");
        try {
          await fs.promises.access(meta);
        } catch {
          await fs.promises
            .writeFile(meta, JSON.stringify({ source: src, createdAt: Date.now() }))
            .catch(() => {});
        }
        return dir;
      },
    },
    // The variants (see fs:externalCatalogDir) of a source's separate catalogues that
    // hold a catalogue, in order: every one, so a variant deleted in the Stored-catalogs
    // manager doesn't hide the ones after it.
    {
      channel: "fs:externalCatalogVariants",
      privileged: true,
      handler: async (_e, rootPath, baseOverride) => {
        const base = externalCatalogBase(userData(), baseOverride);
        const stem = catalogStem(path.resolve(String(rootPath)));
        let names;
        try {
          names = await fs.promises.readdir(base);
        } catch {
          return [];
        }
        const variants = [];
        for (const name of names) {
          if (!name.startsWith(stem)) continue;
          const rest = name.slice(stem.length);
          const variant = rest === "" ? 1 : /^-\d+$/.test(rest) ? Number(rest.slice(1)) : 0;
          if (variant < 1) continue;
          try {
            await fs.promises.access(path.join(base, name, ".safelight", "catalog.json"));
            variants.push(variant);
          } catch {
            /* made, never saved */
          }
        }
        return variants.sort((a, b) => a - b);
      },
    },
    // A library source's .safelight (src/project/library-sources.ts): it has no
    // folder of its own, so its catalogue, previews, listing and originals always
    // live under the app data, one folder per `key` (the extension, its source and
    // the library it shows), named after the source for whoever looks in the folder.
    {
      channel: "fs:sourceCatalogDir",
      privileged: true,
      handler: async (_e, key, name) => {
        const tag = crypto.createHash("sha1").update(String(key)).digest("hex").slice(0, 8);
        const leaf = String(name).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40) || "source";
        const dir = path.join(userData(), "source-catalogs", `${leaf}-${tag}`, ".safelight");
        await fs.promises.mkdir(dir, { recursive: true });
        return dir;
      },
    },
    // Enumerate the "separate" catalogues under `baseOverride` (or the app data dir)
    // for the Preferences manager: each entry is a per-source folder the user can
    // reveal or delete to reclaim disk. Best-effort — unreadable entries are skipped.
    {
      channel: "fs:listExternalCatalogs",
      privileged: true,
      handler: async (_e, baseOverride) => {
        const base = externalCatalogBase(userData(), baseOverride);
        let entries;
        try {
          entries = await fs.promises.readdir(base, { withFileTypes: true });
        } catch {
          return []; // base doesn't exist yet → nothing stored
        }
        const out = [];
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          // Only ever list folders Safelight itself created — a "<slug>-<8 hex>[-<n>]"
          // leaf (see the keying above) that holds a .safelight working dir. Without
          // this, a user who points the base at one of their own directories would see
          // its unrelated subfolders listed as deletable "catalogues", and the delete
          // button (fs:remove → rm -rf) would wipe them. The filter makes that impossible.
          if (!/-[0-9a-f]{8}(-\d+)?$/.test(e.name)) continue;
          const dir = path.join(base, e.name);
          try {
            if (!(await fs.promises.stat(path.join(dir, ".safelight"))).isDirectory()) continue;
          } catch {
            continue; // no .safelight subdir → not one of ours
          }
          let sourcePath = null;
          let createdAt = null;
          // What the source held when last opened (volume-print.ts), so the catalogues
          // of two cards at one path can be told apart.
          let photoCount = null;
          let lastOpenedAt = null;
          let sampleNames = [];
          try {
            const meta = JSON.parse(
              await fs.promises.readFile(path.join(dir, "source.json"), "utf8"),
            );
            sourcePath = typeof meta.source === "string" ? meta.source : null;
            createdAt = typeof meta.createdAt === "number" ? meta.createdAt : null;
            photoCount = typeof meta.photos === "number" ? meta.photos : null;
            lastOpenedAt = typeof meta.openedAt === "number" ? meta.openedAt : null;
            if (Array.isArray(meta.volume))
              sampleNames = meta.volume
                .filter((v) => v && typeof v.relPath === "string")
                .slice(0, 3)
                .map((v) => v.relPath.slice(v.relPath.lastIndexOf("/") + 1));
          } catch {
            /* pre-source.json catalogue, or unreadable meta — leave nulls */
          }
          let mtimeMs = 0;
          try {
            mtimeMs = (await fs.promises.stat(dir)).mtimeMs;
          } catch {
            /* ignore */
          }
          const bytes = await dirSizeBytes(dir).catch(() => 0);
          out.push({
            path: dir,
            name: e.name,
            sourcePath,
            createdAt,
            bytes,
            mtimeMs,
            photoCount,
            lastOpenedAt,
            sampleNames,
          });
        }
        return out;
      },
    },
    // Record where a source's read-only spillover catalogue lives, through the
    // shared atomic writer so it is queued per file and drained at quit.
    {
      channel: "fs:setSpilloverPointer",
      privileged: true,
      handler: async (_e, rootPath, spilloverDir) => {
        const body = JSON.stringify({
          source: path.resolve(String(rootPath)),
          spillover: String(spilloverDir),
        });
        await fileWriter.write(spilloverPointerPath(userData(), rootPath), Buffer.from(body));
      },
    },
    // Look up a source's spillover dir, or null. Verifies the recorded source path
    // matches so a (truncated-hash) collision can't return another source's catalogue.
    {
      channel: "fs:getSpilloverPointer",
      privileged: true,
      handler: async (_e, rootPath) => {
        try {
          const meta = JSON.parse(
            await fs.promises.readFile(spilloverPointerPath(userData(), rootPath), "utf8"),
          );
          if (
            meta &&
            meta.source === path.resolve(String(rootPath)) &&
            typeof meta.spillover === "string"
          )
            return meta.spillover;
        } catch {
          /* no pointer */
        }
        return null;
      },
    },
    {
      channel: "fs:clearSpilloverPointer",
      privileged: true,
      handler: async (_e, rootPath) => {
        await fs.promises.rm(spilloverPointerPath(userData(), rootPath), { force: true });
      },
    },
    {
      channel: "fs:remove",
      privileged: true,
      handler: async (_e, p) => {
        await fs.promises.rm(notRoot(p), { recursive: true, force: true });
      },
    },
    // Recoverable delete: the OS trash (Recycle Bin) instead of rm. Rejects when
    // the platform can't trash the path (e.g. some network mounts) — the renderer
    // reports that per file rather than falling back to a hard delete.
    {
      channel: "fs:trash",
      privileged: true,
      handler: async (_e, p) => {
        await shell.trashItem(path.normalize(notRoot(p)));
      },
    },
    // Move/rename a file or directory. Used by folder-ops for drag-to-reorganize
    // and folder rename; one rename handles a whole subtree atomically.
    {
      channel: "fs:move",
      privileged: true,
      handler: async (_e, src, dest) => {
        notRoot(src);
        notRoot(dest);
        await fs.promises.mkdir(path.dirname(dest), { recursive: true });
        await fs.promises.rename(src, dest);
      },
    },
    {
      channel: "fs:exists",
      privileged: true,
      handler: async (_e, p) => {
        try {
          await fs.promises.access(p);
          return true;
        } catch {
          return false;
        }
      },
    },
    {
      channel: "fs:pickDirectory",
      privileged: true,
      handler: async (e) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          properties: ["openDirectory"],
        });
        return canceled || !filePaths[0] ? null : filePaths[0];
      },
    },
    // Folders an extension keeps across launches (kept-folders.cjs). Core names
    // the asking extension; the page only ever holds a token.
    {
      channel: "fs:pickKeptFolder",
      privileged: true,
      handler: (e, id, replacing) => kept.pick(e, String(id), replacing == null ? null : String(replacing)),
    },
    {
      channel: "fs:keptFolder",
      privileged: true,
      handler: (_e, id, token) => kept.open(String(id), String(token)),
    },
    {
      channel: "fs:forgetKeptFolder",
      privileged: true,
      handler: (_e, id, token) => kept.forget(String(id), String(token)),
    },
    // One file, e.g. the monitor's ICC profile in Preferences. Filters come from
    // the renderer, so only well-formed ones reach the dialogue.
    {
      channel: "fs:pickFile",
      privileged: true,
      handler: async (e, filters) => {
        const win = BrowserWindow.fromWebContents(e.sender);
        const wellFormed = (Array.isArray(filters) ? filters : [])
          .filter((f) => f && typeof f.name === "string" && Array.isArray(f.extensions))
          .map((f) => ({
            name: f.name,
            extensions: f.extensions.filter((x) => typeof x === "string"),
          }));
        const { canceled, filePaths } = await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          filters: wellFormed,
        });
        return canceled || !filePaths[0] ? null : filePaths[0];
      },
    },
    // Reveal a path in the OS file manager: open a directory window, or select a
    // file inside its parent folder. Backs Export's "Open Folder" action.
    {
      channel: "fs:reveal",
      privileged: true,
      handler: async (_e, p) => {
        try {
          const st = await fs.promises.stat(p);
          if (st.isDirectory()) {
            // openPath resolves to "" on success, or an error string otherwise.
            return (await shell.openPath(p)) === "";
          }
          shell.showItemInFolder(p);
          return true;
        } catch {
          return false;
        }
      },
    },
  ];
}

module.exports = { fsChannels };
