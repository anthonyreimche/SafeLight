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
});
