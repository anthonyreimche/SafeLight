// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opens Report an issue's prefilled GitHub link in the system browser. The
// link carries the whole report (up to ~7.5 KB), but shell.openExternal is
// capped at 2081 characters on Windows, so a long link goes through a one-shot
// redirect on the loopback interface: the browser opens a short local URL and
// follows a 302 to the real one. The server answers only its random token
// path, closes after one redirect or a timeout, and only ever redirects to
// Safelight's own new-issue page.

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const ISSUE_URL_PREFIX = "https://github.com/anthonyreimche/SafeLight/issues/new?";
const DIRECT_MAX = 2000;
const MAX_URL = 65536;

// Printable ASCII only: the renderer builds the link with URLSearchParams, and
// anything else would make writeHead throw inside the main process.
function isIssueUrl(url) {
  return (
    typeof url === "string" &&
    url.length <= MAX_URL &&
    url.startsWith(ISSUE_URL_PREFIX) &&
    /^[!-~]+$/.test(url)
  );
}

async function openIssueLink(
  url,
  { openExternal, timeoutMs = 120_000, createServer = http.createServer } = {},
) {
  if (!isIssueUrl(url)) throw new Error("Not a Safelight new-issue link");
  if (url.length <= DIRECT_MAX) {
    await openExternal(url);
    return;
  }

  const token = crypto.randomBytes(16).toString("hex");
  let timer = null;
  const server = createServer((req, res) => {
    if (req.method !== "GET" || req.url !== `/${token}`) {
      res.writeHead(404, { "Cache-Control": "no-store" });
      res.end();
      return;
    }
    try {
      res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
    } catch {
      res.writeHead(500);
    }
    res.end(close);
  });
  function close() {
    clearTimeout(timer);
    server.close();
    server.closeIdleConnections?.();
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  timer = setTimeout(close, timeoutMs);
  timer.unref?.();

  try {
    await openExternal(`http://127.0.0.1:${server.address().port}/${token}`);
  } catch (e) {
    close();
    throw e;
  }
}

module.exports = { ISSUE_URL_PREFIX, openIssueLink };
