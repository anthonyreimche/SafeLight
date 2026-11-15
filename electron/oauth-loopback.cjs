// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Signing in to a web service for an extension (api.network.authorizeInBrowser).
// Desktop OAuth clients get their answer by redirect to the loopback interface:
// providers no longer accept custom schemes or copy-paste codes. So the main
// process listens on 127.0.0.1 at a free port for exactly one request to "/"
// carrying `code` or `error`, answers with a fixed page that reflects nothing,
// and closes. The provider's page opens in the system browser, where the
// person's own sign-in lives. A request naming any Host but the listener's own
// address is refused, so a web page can't reach it through DNS rebinding. The
// page must be opened with a `state`, and only an answer carrying it, after
// the page was opened, ends the wait, so another page or program can't end
// the sign-in with a forged answer. The extension still checks `state` itself, and PKCE binds the code
// to it.

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 15 * 60_000;

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Safelight</title>
<style>body{font:15px/1.5 system-ui,sans-serif;background:#1a1a1a;color:#e6e6e6;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body><p>You can close this tab and return to Safelight.</p></body></html>`;

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  Connection: "close",
};

const failure = (kind, message) => ({ error: { kind, message } });

/**
 * @param {{
 *   openExternal: (url: string) => Promise<void>,
 *   createServer?: typeof http.createServer,
 * }} deps
 */
function createLoopbackAuth({ openExternal, createServer = http.createServer }) {
  /** session id → { id, server, timer, settle, done } */
  const sessions = new Map();

  const clampTimeout = (ms) =>
    Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Number(ms) || DEFAULT_TIMEOUT_MS));

  function end(session, outcome) {
    if (!sessions.has(session.key)) return;
    sessions.delete(session.key);
    clearTimeout(session.timer);
    session.server.close();
    session.server.closeAllConnections?.();
    session.settle(outcome);
  }

  /** Start listening for extension `id`, ending its earlier sign-in if one is
   *  still waiting. Resolves with the session and its redirect address. */
  async function listen(id, timeoutMs) {
    const owner = String(id);
    for (const s of [...sessions.values()]) if (s.id === owner) end(s, failure("aborted", "another sign-in started"));

    let settle = () => {};
    const done = new Promise((resolve) => (settle = resolve));
    const session = { key: crypto.randomUUID(), id: owner, server: null, timer: null, settle, done, state: null };
    const refuse = (res, status) => {
      res.writeHead(status, { "Cache-Control": "no-store", Connection: "close" });
      res.end();
    };
    let host = "";

    session.server = createServer((req, res) => {
      if (req.headers.host !== host) return refuse(res, 421);
      let url;
      try {
        url = new URL(req.url || "/", `http://${host}`);
      } catch {
        return refuse(res, 400);
      }
      const answered = url.searchParams.has("code") || url.searchParams.has("error");
      const expected = session.state !== null && url.searchParams.get("state") === session.state;
      if (req.method !== "GET" || url.pathname !== "/" || !answered || !expected) return refuse(res, 404);
      res.writeHead(200, PAGE_HEADERS);
      res.end(PAGE, () => end(session, { params: [...url.searchParams] }));
    });

    await new Promise((resolve, reject) => {
      session.server.once("error", reject);
      session.server.listen(0, "127.0.0.1", resolve);
    });
    host = `127.0.0.1:${session.server.address().port}`;
    sessions.set(session.key, session);
    session.timer = setTimeout(() => end(session, failure("timeout", "no answer came back from the browser")), clampTimeout(timeoutMs));
    session.timer.unref?.();
    return { session: session.key, redirectUri: `http://${host}` };
  }

  /** Open `url` in the system browser for session `key` of extension `id`, and
   *  resolve with what the browser came back with: `{ params }`, or
   *  `{ error: { kind, message } }`, kind being "refused", "timeout",
   *  "aborted" or "network". Never rejects. */
  async function open(id, key, url) {
    const session = sessions.get(String(key));
    if (!session || session.id !== String(id)) return failure("refused", "this sign-in isn't waiting");
    let target;
    try {
      target = new URL(String(url));
    } catch {
      target = null;
    }
    if (!target || target.protocol !== "https:") {
      end(session, failure("refused", "the sign-in page must be an https address"));
      return session.done;
    }
    const state = target.searchParams.get("state");
    if (!state) {
      end(session, failure("refused", "the sign-in page's address must carry a state"));
      return session.done;
    }
    session.state = state;
    try {
      await openExternal(target.href);
    } catch (e) {
      end(session, failure("network", `the browser couldn't be opened: ${e instanceof Error ? e.message : String(e)}`));
    }
    return session.done;
  }

  /** Stop waiting for session `key` of extension `id`. */
  function cancel(id, key) {
    const session = sessions.get(String(key));
    if (session && session.id === String(id)) end(session, failure("aborted", "signing in was stopped"));
  }

  return { listen, open, cancel, clampTimeout };
}

module.exports = { createLoopbackAuth };
