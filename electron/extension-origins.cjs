// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which network origins extensions may reach. The renderer CSP's connect-src is
// widened only by the origins a manifest declares in permissions.network, read
// from disk when the app starts: the installed extensions under
// <userData>/plugins, and the Developer Tools dev folder, laid out the way the
// renderer's dev-folder scanner (src/extensions/devtools/dev-folder.ts) reads
// it. Both are read the same way, so a build loaded from the dev folder gets
// exactly the policy its installed release will. main.cjs owns the real paths
// and the IPC; this module only reads and writes files, so it runs against temp
// folders in tests.

const fs = require("node:fs");
const path = require("node:path");

// A well-formed HTTPS origin, optionally with a single leading-label wildcard
// and a port. Nothing else may reach the policy, so a manifest can't inject
// 'unsafe-eval', a data: source, or a bare * into it.
const VALID_CONNECT_ORIGIN = /^https:\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i;
const VALID_ID = /^[a-z0-9][a-z0-9._-]*$/i;

function validManifest(m) {
  return (
    m &&
    typeof m.id === "string" &&
    VALID_ID.test(m.id) &&
    typeof m.name === "string" &&
    typeof m.version === "string" &&
    typeof m.main === "string" &&
    !m.main.includes("..")
  );
}

/** The valid manifest in `dir`, or null. */
function readManifest(dir) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, "safelight.json"), "utf8"));
    return validManifest(m) ? m : null;
  } catch {
    return null;
  }
}

function subfolders(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Installed extensions: plugins/<id>/safelight.json, the id naming its folder. */
function listInstalledManifests(pluginsDir) {
  const out = [];
  for (const name of subfolders(pluginsDir)) {
    const m = readManifest(path.join(pluginsDir, name));
    if (m && m.id === name) out.push(m);
  }
  return out;
}

/** Dev-folder extensions. A folder with its own safelight.json is that one
 *  extension (the renderer loads just that one, valid or not); otherwise each
 *  immediate subfolder with a manifest is one, whatever the folder is called. */
function listDevManifests(folder) {
  if (!folder) return [];
  if (fs.existsSync(path.join(folder, "safelight.json"))) {
    const root = readManifest(folder);
    return root ? [root] : [];
  }
  const out = [];
  for (const name of subfolders(folder)) {
    const m = readManifest(path.join(folder, name));
    if (m) out.push(m);
  }
  return out;
}

/** Every well-formed HTTPS origin the manifests declare, once each, in order. */
function declaredConnectHosts(manifests) {
  const hosts = new Set();
  for (const m of manifests) {
    const net =
      m && m.permissions && Array.isArray(m.permissions.network) ? m.permissions.network : [];
    for (const h of net) {
      const v = String(h || "").trim();
      if (VALID_CONNECT_ORIGIN.test(v)) hosts.add(v);
    }
  }
  return [...hosts];
}

/** The declared origins a launch's policy does not allow: what a restart adds. */
function pendingConnectHosts(declared, allowed) {
  const have = new Set(allowed);
  return declared.filter((h) => !have.has(h));
}

/** The dev folder the renderer last recorded in `file`, or null. */
function readDevFolder(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")).folder;
    return typeof v === "string" && v ? v : null;
  } catch {
    return null;
  }
}

/** Record the dev folder in `file`; null removes the record. */
function writeDevFolder(file, folder) {
  if (folder) fs.writeFileSync(file, JSON.stringify({ folder }));
  else fs.rmSync(file, { force: true });
}

module.exports = {
  VALID_CONNECT_ORIGIN,
  validManifest,
  listInstalledManifests,
  listDevManifests,
  declaredConnectHosts,
  pendingConnectHosts,
  readDevFolder,
  writeDevFolder,
};
