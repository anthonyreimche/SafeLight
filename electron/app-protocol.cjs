// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The app:// scheme that serves the built dist/ and the installed extensions.
// libraw-wasm decodes RAW files on shared memory in a Web Worker, which only
// works when the page is cross-origin isolated (COOP/COEP) and served from a
// secure origin, so every response carries the isolation headers and the app
// shell carries its CSP. main.cjs supplies protocol, net and the paths.

const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { contains } = require("./plugin-files.cjs");

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

const ISOLATION_HEADERS = {
  "Cross-Origin-Opener-Policy": "same-origin",
  // `credentialless` (not `require-corp`) keeps the app cross-origin-isolated —
  // crossOriginIsolated stays true, so SharedArrayBuffer / libraw-wasm threads
  // still work — while letting no-cors cross-origin images load without a CORP
  // header. That's what the Extensions store needs: GitHub OG thumbnails, owner
  // avatars, and remote README screenshots/badges are served without
  // Cross-Origin-Resource-Policy, so under require-corp they were blocked and
  // rendered as blank/grey cards.
  "Cross-Origin-Embedder-Policy": "credentialless",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// CSP for the app shell. Everything is same-origin (app://bundle), including
// installed extensions (/__plugins__/...). 'wasm-unsafe-eval' is required for
// libraw-wasm; blob: workers/scripts cover Vite's worker bootstrap; inline
// styles cover React style props + Tailwind.
const CSP_STATIC = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' blob:",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  // https: lets the Extensions store show remote previews: repo thumbnails,
  // owner avatars, and images inside rendered extension READMEs (badges,
  // screenshots), and gallery thumbnails from a backend. Images can't execute
  // code, so this widens display only.
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
];

// Origins extensions may fetch (XHR/fetch). Extensions that talk to a backend —
// e.g. the Web Tools gallery service — need this; without it they can't reach any
// network and have to shell out to a helper process. Cloudflare Workers are
// allowed by default; SAFELIGHT_GALLERY_ORIGINS (space-separated) adds custom
// origins (e.g. a galleries.yourdomain.com Worker route). script-src stays 'self'
// so this widens data egress to these hosts only, never code execution.
function galleryOriginsFrom(env) {
  return env.SAFELIGHT_GALLERY_ORIGINS || "https://*.workers.dev";
}

// connect-src is 'self' + the gallery origins + the HTTPS and wss: (secure
// WebSocket) origins that extensions DECLARE in their manifest's
// permissions.network (main.cjs reads them through extension-origins.cjs).
// Only declared (and therefore user-visible) origins widen the policy, so an
// extension can't silently fetch an arbitrary host — anything not declared is
// blocked by the CSP.
function buildCSP(galleryOrigins, connectHosts) {
  const connect = ["'self'", "data:", "blob:", galleryOrigins, ...connectHosts];
  return [...CSP_STATIC, `connect-src ${connect.join(" ")}`].join("; ");
}

// Must run before app `ready`. `standard` + `secure` gives the scheme a real
// origin and a secure context (required for SharedArrayBuffer); the rest let it
// behave like a normal web server for fetch/streaming/code-cache.
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "app",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
        codeCache: true,
      },
    },
  ]);
}

function resolveRequestPath(dist, urlPath) {
  // Strip query/hash, decode, and join under dist without escaping it.
  const clean = decodeURIComponent(urlPath.split("?")[0].split("#")[0]);
  const rel = path.normalize(clean).replace(/^(\.\.[/\\])+/, "");
  let filePath = path.join(dist, rel);
  if (!contains(dist, filePath)) filePath = path.join(dist, "index.html");
  return filePath;
}

/**
 * @param {{
 *   protocol: { handle(scheme: string, handler: (request: Request) => Promise<Response>): void },
 *   net: { fetch: typeof fetch },
 *   dist: string,
 *   pluginsDir: () => string,
 *   csp: () => string,
 * }} deps
 */
function serveAppProtocol({ protocol, net, dist, pluginsDir, csp }) {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);

    // Installed extensions are served from userData/plugins under the same
    // origin (/__plugins__/<id>/...), so dynamic import works under COOP/COEP
    // without any CORS dance.
    if (url.pathname.startsWith("/__plugins__/")) {
      const rel = path
        .normalize(decodeURIComponent(url.pathname.slice("/__plugins__/".length)))
        .replace(/^([/\\]|\.\.[/\\])+/, "");
      const filePath = path.join(pluginsDir(), rel);
      if (!contains(pluginsDir(), filePath) || !fs.existsSync(filePath)) {
        return new Response("Not found", { status: 404 });
      }
      const res = await net.fetch(pathToFileURL(filePath).toString());
      const headers = new Headers(res.headers);
      const type = MIME[path.extname(filePath).toLowerCase()];
      if (type) headers.set("Content-Type", type);
      for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
      return new Response(res.body, { status: 200, headers });
    }

    let filePath = resolveRequestPath(dist, url.pathname || "/");

    // Directory or missing file: serve index.html so SPA routes resolve.
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) filePath = path.join(filePath, "index.html");
    } catch {
      const hasExt = path.extname(filePath) !== "";
      if (!hasExt) filePath = path.join(dist, "index.html");
    }
    if (!fs.existsSync(filePath)) filePath = path.join(dist, "index.html");

    const res = await net.fetch(pathToFileURL(filePath).toString());
    const headers = new Headers(res.headers);
    const type = MIME[path.extname(filePath).toLowerCase()];
    if (type) headers.set("Content-Type", type);
    if (type === "text/html") headers.set("Content-Security-Policy", csp());
    for (const [k, v] of Object.entries(ISOLATION_HEADERS)) headers.set(k, v);
    return new Response(res.body, { status: 200, headers });
  });
}

module.exports = {
  ISOLATION_HEADERS,
  galleryOriginsFrom,
  buildCSP,
  registerAppScheme,
  serveAppProtocol,
};
