// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Server addresses the person allows an extension to reach (api.network). A
// manifest's permissions.network can only name fixed HTTPS origins, and the
// page's CSP is built from them at launch; a self-hosted server is any address,
// often plain http on the LAN, which the secure app page could not reach even
// if the CSP allowed it (mixed content). So an extension that declares
// permissions.userOrigins asks for the address it was given, the person is
// asked in a native dialog, the answer is kept per extension and address, and
// the requests are made here, never by the page. Cookies and redirects to
// another address never apply. The renderer reaches this through the
// privileged bridge only (src/native/privileged.ts), which core claims at boot
// and wraps with the asking extension's own id.
//
// The https origins an extension's own manifest declares in permissions.network
// are reached the same way, without asking: the person saw them at install and
// the page's CSP already allows them, but a server that never answers CORS
// (some content hosts) can only be read from here.

const path = require("node:path");
const fs = require("node:fs");
const { isIP } = require("node:net");
const { VALID_CONNECT_ORIGIN } = require("./extension-origins.cjs");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
/** The largest answer handed back: a big RAW, with room to spare. */
const MAX_BODY_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
/** Headers a redirect to another origin doesn't carry on, as fetch drops them. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization"]);
/** Headers the request never takes from the page. */
const DROPPED_HEADERS = new Set(["host", "cookie", "cookie2", "connection", "content-length", "transfer-encoding", "origin", "referer"]);

/** The http(s) origin of `url`, or null for anything else (another scheme, a
 *  user name or password in it, no address at all). */
function originOf(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.origin;
}

/** Whether the https `origin` is one that the permissions.network entry
 *  `pattern` names, read as the CSP reads it: "https://*.example.com" matches
 *  every subdomain at any depth but not example.com itself, and an entry
 *  without a port matches the default port only. A wildcard over a single
 *  label ("https://*.com") names nothing here, though the CSP takes it: read
 *  from outside the page, it would open every site under it without CORS. A
 *  wildcard never matches an IP address, as in the CSP. wss entries and
 *  malformed ones name nothing here either. */
function declaredOriginMatches(pattern, origin) {
  const entry = String(pattern || "").trim();
  if (!VALID_CONNECT_ORIGIN.test(entry) || !/^https:/i.test(entry)) return false;
  let u;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const [, wildcard, host, port] = /^https:\/\/(\*\.)?([^:]+)(?::(\d+))?$/i.exec(entry);
  if ((u.port || "443") !== (port && port !== "443" ? port : "443")) return false;
  const want = host.toLowerCase();
  if (wildcard && (!want.includes(".") || isIP(u.hostname.replace(/^\[|\]$/g, "")))) return false;
  return wildcard ? u.hostname.endsWith(`.${want}`) : u.hostname === want;
}

function failure(kind, message) {
  return { error: { kind, message } };
}

/** Why a request failed, in a few words: the network error and its errno. */
function networkMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && error.cause && typeof error.cause.code === "string" ? error.cause.code : null;
  return code ? `${message} (${code})` : message;
}

/** The answer's bytes, or null once they pass `limit`. A server need not say
 *  how long its answer is, so the limit is kept while reading. A declared
 *  length that fits is trusted only as the size of the first buffer. */
async function readWithin(res, limit) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const declared = Number(res.headers.get("content-length"));
  let filled = Number.isInteger(declared) && declared >= 0 && declared <= limit ? new Uint8Array(declared) : null;
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (filled && total + value.byteLength <= filled.byteLength) filled.set(value, total);
    else {
      if (filled) {
        parts.push(filled.subarray(0, total));
        filled = null;
      }
      parts.push(value);
    }
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
  }
  // A copy when the body came up short of its content-length: a view would carry
  // the whole preallocated buffer across IPC.
  if (filled) return total === filled.length ? filled : filled.slice(0, total);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.byteLength;
  }
  return bytes;
}

/**
 * @param {{
 *   userData: () => string,
 *   fileWriter: { write: (p: string, bytes: Uint8Array) => Promise<void> },
 *   findManifest: (id: string) => Promise<{ id: string, name: string, permissions?: { userOrigins?: boolean, network?: string[] } } | null>,
 *   showConsent: (event: unknown, ask: { name: string, origin: string, plain: boolean }) => Promise<boolean>,
 *   fetchImpl?: typeof fetch,
 *   maxBodyBytes?: number,
 * }} deps
 */
function createNetAccess({
  userData,
  fileWriter,
  findManifest,
  showConsent,
  fetchImpl = globalThis.fetch,
  maxBodyBytes = MAX_BODY_BYTES,
}) {
  const file = () => path.join(userData(), "network-grants.json");
  /** extension id → the origins allowed for it. */
  let grants = null;
  const running = new Map();
  /** The record on disk couldn't be made sense of: it is moved aside before the
   *  first write, so nothing in it is lost without a trace. */
  let damaged = false;

  // A read refused for a moment (antivirus or backup holding the file on
  // Windows) throws and caches nothing, so the next call reads again and no
  // write ever replaces a record that wasn't read.
  function load() {
    if (grants) return grants;
    let text;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch (e) {
      if (e && e.code === "ENOENT") return (grants = new Map());
      throw e;
    }
    const read = new Map();
    let saved = null;
    try {
      saved = JSON.parse(text);
    } catch {
      /* damaged, below */
    }
    if (saved && saved.version === 1 && saved.grants && typeof saved.grants === "object") {
      for (const [id, origins] of Object.entries(saved.grants))
        if (Array.isArray(origins)) read.set(id, new Set(origins.filter((o) => originOf(o) === o)));
    } else damaged = true;
    return (grants = read);
  }

  async function save() {
    const out = { version: 1, grants: Object.fromEntries([...load()].map(([id, set]) => [id, [...set]])) };
    if (damaged) {
      await fs.promises.rename(file(), `${file()}.bad`);
      damaged = false;
    }
    await fileWriter.write(file(), new TextEncoder().encode(JSON.stringify(out)));
  }

  const granted = (id, origin) => load().get(String(id))?.has(origin) ?? false;

  /** extension id → its manifest's permissions.network, read at its first
   *  request and kept until it is uninstalled: like the CSP, an update's new
   *  origins apply from the next launch. */
  const declaredLists = new Map();

  /** Whether extension `id`'s own manifest declares `origin`. */
  async function declared(id, origin) {
    let network = declaredLists.get(String(id));
    if (!network) {
      const manifest = await findManifest(String(id));
      if (!manifest) return false;
      const listed = manifest.permissions && manifest.permissions.network;
      network = Array.isArray(listed) ? listed.map(String) : [];
      declaredLists.set(String(id), network);
    }
    return network.some((entry) => declaredOriginMatches(entry, origin));
  }

  const reachable = async (id, origin) => granted(id, origin) || (await declared(id, origin));

  async function declares(id) {
    const manifest = await findManifest(String(id));
    return manifest && manifest.permissions && manifest.permissions.userOrigins === true ? manifest : null;
  }

  /** Ask the person whether extension `id` may reach `url`'s address, unless it
   *  already may. Resolves with whether it may now. */
  async function request(event, id, url) {
    const origin = originOf(url);
    if (!origin) return false;
    if (await declared(id, origin)) return true;
    const manifest = await declares(id);
    if (!manifest) return false;
    if (granted(id, origin)) return true;
    const yes = await showConsent(event, { name: String(manifest.name), origin, plain: origin.startsWith("http:") });
    if (!yes) return false;
    const set = load().get(String(id)) ?? new Set();
    set.add(origin);
    load().set(String(id), set);
    await save();
    return true;
  }

  async function has(id, url) {
    const origin = originOf(url);
    return !!origin && (await reachable(id, origin));
  }

  async function revoke(id, url) {
    const origin = originOf(url);
    const set = origin && load().get(String(id));
    if (!set || !set.delete(origin)) return;
    if (set.size === 0) load().delete(String(id));
    await save();
  }

  /** Forget every address extension `id` was allowed: it was uninstalled, and
   *  another extension installed later under its id must ask again. */
  async function forget(id) {
    declaredLists.delete(String(id));
    if (!load().delete(String(id))) return;
    await save();
  }

  function cleanHeaders(headers) {
    const out = {};
    if (headers && typeof headers === "object")
      for (const [name, value] of Object.entries(headers))
        if (typeof value === "string" && !DROPPED_HEADERS.has(name.toLowerCase())) out[name] = value;
    return out;
  }

  /** Make one request for extension `id`. Resolves with `{ status, statusText,
   *  headers, body }` or `{ error: { kind, message } }`, kind being "refused",
   *  "timeout", "aborted", "too-large" or "network"; it never rejects. */
  async function send(id, requestId, url, init = {}) {
    const origin = originOf(url);
    const refused = () => failure("refused", `Safelight hasn't been allowed to connect to ${origin ?? String(url)}`);
    if (!origin) return refused();
    let method = typeof init.method === "string" ? init.method.toUpperCase() : "GET";
    if (!METHODS.has(method)) return failure("refused", `the method ${method} isn't allowed`);
    let body = typeof init.body === "string" || init.body instanceof Uint8Array ? init.body : undefined;
    const headers = cleanHeaders(init.headers);
    const timeout = Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(init.timeoutMs) || DEFAULT_TIMEOUT_MS));
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeout);
    if (requestId != null) running.set(String(requestId), ac);
    try {
      if (!(await reachable(id, origin))) return refused();
      if (ac.signal.aborted) throw ac.signal.reason;
      let target = String(url);
      let sent = headers;
      for (let hop = 0; ; hop++) {
        const res = await fetchImpl(target, { method, headers: sent, body, redirect: "manual", signal: ac.signal });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          const next = new URL(location, target);
          if (next.origin !== origin && !(await declared(id, next.origin)))
            return failure("refused", `the server redirected to another address (${next.origin})`);
          if (hop >= MAX_REDIRECTS) return failure("refused", "the server redirected too many times");
          if (res.status === 303) {
            method = "GET";
            body = undefined;
          }
          if (next.origin !== new URL(target).origin)
            sent = Object.fromEntries(Object.entries(sent).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())));
          await res.body?.cancel().catch(() => {});
          target = next.href;
          continue;
        }
        const tooLarge = () => failure("too-large", `the answer is larger than ${maxBodyBytes} bytes`);
        if (Number(res.headers.get("content-length")) > maxBodyBytes) {
          ac.abort();
          return tooLarge();
        }
        const bytes = await readWithin(res, maxBodyBytes);
        if (!bytes) {
          ac.abort();
          return tooLarge();
        }
        return { status: res.status, statusText: res.statusText, headers: [...res.headers], body: bytes };
      }
    } catch (error) {
      if (timedOut) return failure("timeout", `no answer within ${Math.round(timeout / 1000)} s`);
      if (ac.signal.aborted) return failure("aborted", "the request was stopped");
      return failure("network", networkMessage(error));
    } finally {
      clearTimeout(timer);
      if (requestId != null) running.delete(String(requestId));
    }
  }

  function abort(requestId) {
    running.get(String(requestId))?.abort();
  }

  return { request, has, revoke, forget, fetch: send, abort };
}

module.exports = { createNetAccess, originOf, declaredOriginMatches };
