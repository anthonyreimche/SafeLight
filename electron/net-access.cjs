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

const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
/** The largest answer handed back: a big RAW, with room to spare. */
const MAX_BODY_BYTES = 1024 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
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
 *  how long its answer is, so the limit is kept while reading. */
async function readWithin(res, limit) {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
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
 *   findManifest: (id: string) => Promise<{ id: string, name: string, permissions?: { userOrigins?: boolean } } | null>,
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

  async function declares(id) {
    const manifest = await findManifest(String(id));
    return manifest && manifest.permissions && manifest.permissions.userOrigins === true ? manifest : null;
  }

  /** Ask the person whether extension `id` may reach `url`'s address, unless it
   *  already may. Resolves with whether it may now. */
  async function request(event, id, url) {
    const origin = originOf(url);
    if (!origin) return false;
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
    return !!origin && granted(id, origin);
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
    if (!origin || !granted(id, origin))
      return failure("refused", `Safelight hasn't been allowed to connect to ${origin ?? String(url)}`);
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
      let target = String(url);
      for (let hop = 0; ; hop++) {
        const res = await fetchImpl(target, { method, headers, body, redirect: "manual", signal: ac.signal });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          const next = new URL(location, target);
          if (next.origin !== origin) return failure("refused", `the server redirected to another address (${next.origin})`);
          if (hop >= MAX_REDIRECTS) return failure("refused", "the server redirected too many times");
          if (res.status === 303) {
            method = "GET";
            body = undefined;
          }
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

module.exports = { createNetAccess, originOf };
