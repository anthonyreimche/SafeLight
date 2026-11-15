// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Live connections (WebSockets) the person allows an extension to open to an
// address they typed in (api.sockets), such as a studio's own sync relay. A
// manifest's permissions.network can name only fixed origins, and requests made
// for an extension by api.network (net-access.cjs) can't hold a socket open,
// so the page opens the socket itself and the address must be in the page's
// connect-src. The extension declares permissions.userSockets; the person is
// asked in a native dialog that names the extension and the address; the
// answer is kept here per extension; and at the next launch every kept address
// of an installed extension that still declares userSockets joins connect-src,
// checked by the same rule as declared origins (VALID_CONNECT_ORIGIN). The
// restart is the consent point declared origins already use: a page can never
// widen the policy it is running under. Only wss: is taken.

const path = require("node:path");
const fs = require("node:fs");
const { VALID_CONNECT_ORIGIN } = require("./extension-origins.cjs");

const GRANTS_FILE = "socket-grants.json";

/** The wss origin of `url`, or null for anything the page's policy shouldn't
 *  take: another scheme, a user name or password, a wildcard, an IPv6
 *  literal, anything VALID_CONNECT_ORIGIN refuses. */
function socketOriginOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "wss:" || u.username || u.password || !u.hostname) return null;
  const origin = `wss://${u.host}`;
  return VALID_CONNECT_ORIGIN.test(origin) && !origin.includes("*") ? origin : null;
}

/** The grants a record holds, or null when it isn't one this build reads. */
function grantsOf(saved) {
  if (!saved || saved.version !== 1 || !saved.grants || typeof saved.grants !== "object") return null;
  const grants = new Map();
  for (const [id, origins] of Object.entries(saved.grants))
    if (Array.isArray(origins)) grants.set(id, new Set(origins.filter((o) => socketOriginOf(o) === o)));
  return grants;
}

/** The kept origins of the extensions in `manifests` that declare
 *  userSockets, once each: what this launch's connect-src takes from
 *  `file`. A missing or damaged record gives none. */
async function readSocketGrantOrigins(file, manifests) {
  let grants = null;
  try {
    grants = grantsOf(JSON.parse(await fs.promises.readFile(file, "utf8")));
  } catch {
    return [];
  }
  if (!grants) return [];
  const out = new Set();
  for (const m of manifests) {
    if (!m || !m.permissions || m.permissions.userSockets !== true) continue;
    for (const origin of grants.get(m.id) ?? []) out.add(origin);
  }
  return [...out];
}

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   findManifest: (id: string) => Promise<{ id: string, name: string, permissions?: { userSockets?: boolean } } | null>,
 *   showConsent: (event: unknown, ask: { name: string, origin: string }) => Promise<boolean>,
 *   launchOrigins: () => string[],
 * }} deps
 */
function createSocketAccess({ userData, fileWriter, findManifest, showConsent, launchOrigins }) {
  const file = () => path.join(userData(), GRANTS_FILE);
  /** extension id → the origins allowed for it. */
  let grants = null;
  /** The record on disk couldn't be read: it is moved aside before the first
   *  write, so nothing in it is lost without a trace. */
  let damaged = false;

  // A read refused for a moment (antivirus or backup holding the file) throws
  // and caches nothing, so no write ever replaces a record that wasn't read.
  function load() {
    if (grants) return grants;
    let text;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return (grants = new Map());
      throw e;
    }
    let read = null;
    try {
      read = grantsOf(JSON.parse(text));
    } catch {
      /* damaged, below */
    }
    if (!read) damaged = true;
    return (grants = read ?? new Map());
  }

  let saving = Promise.resolve();

  /** Change extension `id`'s origins to what `change` makes of a copy of
   *  them, keeping the change only once it is on disk, so a failed write
   *  leaves no grant or revoke that the next launch wouldn't see. Writes run
   *  one at a time. */
  function commit(id, change) {
    const run = saving.then(async () => {
      const next = new Map(load());
      const set = new Set(next.get(id) ?? []);
      change(set);
      if (set.size) next.set(id, set);
      else next.delete(id);
      const out = { version: 1, grants: Object.fromEntries([...next].map(([key, s]) => [key, [...s]])) };
      if (damaged) {
        await fs.promises.rename(file(), `${file()}.bad`);
        damaged = false;
      }
      await fileWriter.write(file(), new TextEncoder().encode(JSON.stringify(out)));
      grants = next;
    });
    saving = run.catch(() => {});
    return run;
  }

  const granted = (id, origin) => load().get(String(id))?.has(origin) ?? false;
  /** Extensions with a consent dialogue open now. */
  const asking = new Set();

  /** "allowed" when this launch's policy holds the origin, "after-restart"
   *  when it is kept but the policy was built without it. */
  const statusOf = (id, origin) =>
    !granted(id, origin) ? "not-allowed" : launchOrigins().includes(origin) ? "allowed" : "after-restart";

  async function declares(id) {
    const manifest = await findManifest(String(id));
    return manifest && manifest.permissions && manifest.permissions.userSockets === true ? manifest : null;
  }

  /** Ask the person whether extension `id` may open live connections to
   *  `url`'s address, unless it already may. */
  async function request(event, id, url) {
    const key = String(id);
    const origin = socketOriginOf(url);
    if (!origin) return "not-allowed";
    const manifest = await declares(key);
    if (!manifest) return "not-allowed";
    if (!granted(key, origin)) {
      // One dialogue per extension at a time: asking again while one is open
      // is turned down rather than stacked.
      if (asking.has(key)) return "not-allowed";
      asking.add(key);
      try {
        if (!(await showConsent(event, { name: String(manifest.name), origin }))) return "not-allowed";
        await commit(key, (set) => set.add(origin));
      } finally {
        asking.delete(key);
      }
    }
    return statusOf(key, origin);
  }

  async function status(id, url) {
    const origin = socketOriginOf(url);
    if (!origin || !(await declares(id))) return "not-allowed";
    return statusOf(id, origin);
  }

  async function list(id) {
    return [...(load().get(String(id)) ?? [])];
  }

  async function revoke(id, url) {
    const origin = socketOriginOf(url);
    if (!origin || !granted(id, origin)) return;
    await commit(String(id), (set) => set.delete(origin));
  }

  /** Forget every address extension `id` was allowed: it was uninstalled. */
  async function forget(id) {
    if (!load().has(String(id))) return;
    await commit(String(id), (set) => set.clear());
  }

  return { request, status, list, revoke, forget };
}

module.exports = { createSocketAccess, readSocketGrantOrigins, socketOriginOf, GRANTS_FILE };
