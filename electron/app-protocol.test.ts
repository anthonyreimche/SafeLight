// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What app:// serves (app-protocol.cjs): the app shell with its CSP, every
// response cross-origin isolated, installed extensions under /__plugins__/,
// and nothing outside dist/ or the plugins folder. Runs against temp folders
// with a fake protocol and a file-reading net.fetch.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ISOLATION_HEADERS,
  buildCSP,
  galleryOriginsFrom,
  registerAppScheme,
  serveAppProtocol,
} from "./app-protocol.cjs";

const BASE_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' blob:; worker-src 'self' blob:; " +
  "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; " +
  "object-src 'none'; base-uri 'self'; frame-src 'none'; connect-src 'self' data: blob:";

describe("app shell CSP", () => {
  it("allows Cloudflare Workers unless the environment names other gallery origins", () => {
    expect(galleryOriginsFrom({})).toBe("https://*.workers.dev");
    expect(galleryOriginsFrom({ SAFELIGHT_GALLERY_ORIGINS: "https://galleries.example.com" })).toBe(
      "https://galleries.example.com",
    );
  });

  it("widens only connect-src, by the gallery origins and the declared hosts", () => {
    expect(buildCSP("https://*.workers.dev", [])).toBe(`${BASE_CSP} https://*.workers.dev`);
    expect(buildCSP("https://*.workers.dev", ["https://api.example.com"])).toBe(
      `${BASE_CSP} https://*.workers.dev https://api.example.com`,
    );
  });
});

describe("app scheme", () => {
  it("is standard and secure, so the page gets an origin and SharedArrayBuffer", () => {
    let schemes: unknown;
    registerAppScheme({ registerSchemesAsPrivileged: (s: unknown) => (schemes = s) });
    expect(schemes).toEqual([
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
  });
});

describe("app:// responses", () => {
  let root: string;
  let dist: string;
  let plugins: string;
  let serve: (request: Request) => Promise<Response>;
  const CSP = "default-src 'self'";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sl-app-protocol-"));
    dist = join(root, "dist");
    plugins = join(root, "plugins");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(join(plugins, "demo.ext"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>index");
    writeFileSync(join(dist, "assets", "app.js"), "export {}");
    writeFileSync(join(root, "secret.txt"), "outside");
    writeFileSync(join(plugins, "demo.ext", "index.js"), "export const demo = 1;");
    serveAppProtocol({
      protocol: { handle: (_scheme: string, handler: typeof serve) => (serve = handler) },
      net: { fetch: async (url: string) => new Response(readFileSync(fileURLToPath(url))) },
      dist,
      pluginsDir: () => plugins,
      csp: () => CSP,
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const get = (path: string) => serve(new Request(`app://bundle${path}`));

  const expectIsolated = (res: Response) => {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) expect(res.headers.get(name)).toBe(value);
  };

  it("serves the app shell with its CSP and the isolation headers", async () => {
    const res = await get("/index.html");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
    expectIsolated(res);
    expect(await res.text()).toBe("<!doctype html>index");
  });

  it("answers an SPA route with the app shell", async () => {
    const res = await get("/develop/photo");
    expect(await res.text()).toBe("<!doctype html>index");
    expect(res.headers.get("Content-Security-Policy")).toBe(CSP);
  });

  it("serves a bundle file with its type and no CSP", async () => {
    const res = await get("/assets/app.js");
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expectIsolated(res);
  });

  it("never serves a file above dist", async () => {
    for (const path of ["/assets/%2e%2e/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/assets%2f%2e%2e%2f%2e%2e%2fsecret.txt"]) {
      expect(await (await get(path)).text()).toBe("<!doctype html>index");
    }
  });

  it("serves an installed extension's file under the same origin", async () => {
    const res = await get("/__plugins__/demo.ext/index.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    expect(res.headers.get("Content-Security-Policy")).toBeNull();
    expectIsolated(res);
    expect(await res.text()).toBe("export const demo = 1;");
  });

  it("refuses a missing extension file and a path out of the plugins folder", async () => {
    expect((await get("/__plugins__/demo.ext/missing.js")).status).toBe(404);
    const escape = await get("/__plugins__/%2e%2e%2fsecret.txt");
    expect(escape.status).toBe(404);
    expect(await escape.text()).not.toBe("outside");
  });

  it("refuses the plugins folder and an extension folder rather than listing them", async () => {
    expect((await get("/__plugins__/")).status).toBe(404);
    expect((await get("/__plugins__/demo.ext")).status).toBe(404);
    expect((await get("/__plugins__/demo.ext/")).status).toBe(404);
  });

  it("answers 400 to a path with a malformed escape", async () => {
    expect((await get("/%E0%A4%A")).status).toBe(400);
    expect((await get("/__plugins__/demo.ext/%E0%A4%A.js")).status).toBe(400);
  });
});

// A Developer Tools dev-folder extension builds the same /__plugins__/<id>/
// URLs for its own files (a worker, a wasm runtime) as its installed release.
describe("app:// for a dev-folder extension", () => {
  let root: string;
  let plugins: string;
  let devDir: string;
  let serve: (request: Request) => Promise<Response>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sl-app-protocol-dev-"));
    const dist = join(root, "dist");
    plugins = join(root, "plugins");
    devDir = join(root, "My Extension");
    mkdirSync(dist, { recursive: true });
    mkdirSync(join(plugins, "demo.ext", "dist"), { recursive: true });
    mkdirSync(join(plugins, "installed.only"), { recursive: true });
    mkdirSync(join(devDir, "dist", "ort"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>index");
    writeFileSync(join(root, "secret.txt"), "outside");
    writeFileSync(join(plugins, "demo.ext", "dist", "index.js"), "installed");
    writeFileSync(join(plugins, "installed.only", "index.js"), "installed only");
    writeFileSync(join(devDir, "dist", "index.js"), "dev build");
    writeFileSync(join(devDir, "dist", "ort", "runtime.mjs"), "export const ort = 1;");
    serveAppProtocol({
      protocol: { handle: (_scheme: string, handler: typeof serve) => (serve = handler) },
      net: { fetch: async (url: string) => new Response(readFileSync(fileURLToPath(url))) },
      dist,
      pluginsDir: () => plugins,
      devExtensionDir: async (id: string) => (id === "demo.ext" ? devDir : null),
      csp: () => "default-src 'self'",
    });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const get = (path: string) => serve(new Request(`app://bundle${path}`));

  it("serves the dev copy's files under its id, over an installed copy's", async () => {
    const res = await get("/__plugins__/demo.ext/dist/ort/runtime.mjs?v=1.0.0");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/javascript");
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(await res.text()).toBe("export const ort = 1;");
    expect(await (await get("/__plugins__/demo.ext/dist/index.js")).text()).toBe("dev build");
  });

  it("keeps serving installed extensions the dev folder doesn't hold", async () => {
    expect(await (await get("/__plugins__/installed.only/index.js")).text()).toBe("installed only");
  });

  it("never serves a path out of the dev copy's folder, nor the folder itself", async () => {
    for (const path of ["/__plugins__/demo.ext/%2e%2e/secret.txt", "/__plugins__/demo.ext/..%2f..%2fsecret.txt"]) {
      const res = await get(path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toBe("outside");
    }
    expect((await get("/__plugins__/demo.ext/")).status).toBe(404);
    expect((await get("/__plugins__/demo.ext/dist/missing.js")).status).toBe(404);
  });
});
