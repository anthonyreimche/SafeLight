// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CliError } from "../types";
import { CSP, startLiveServer, type FrameQuery, type LiveServer, type LiveSource } from "./server";

const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3);
const ASSETS = { html: "<!doctype html><title>live</title>", js: "export {};", css: "body{}" };

interface Reply { status: number; headers: IncomingHttpHeaders; body: Buffer }

function call(port: number, path: string, options: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: options.method ?? "GET", headers: { host: options.host ?? `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Reads an event stream until `count` events came, then lets it go. */
function events(port: number, path: string, count: number, onOpen?: () => void): Promise<{ events: string[]; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `localhost:${port}` } }, (res) => {
      let text = "";
      onOpen?.();
      res.on("data", (c: Buffer) => {
        text += c.toString("utf8");
        const got = text.split("\n\n").filter((block) => block.includes("event: state"));
        if (got.length >= count) {
          req.destroy();
          resolve({ events: got.map((b) => b.trim()), headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function fakeSource(over: Partial<LiveSource> = {}) {
  let rev = 3;
  const listeners = new Set<(rev: number) => void>();
  const frames: FrameQuery[] = [];
  const commands: string[] = [];
  const source: LiveSource = {
    state: () => ({ slu: 1, rev }),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    async frame(query) {
      frames.push(query);
      return PNG;
    },
    async command(action) {
      commands.push(action);
      return action !== "next";
    },
    ...over,
  };
  const bump = () => {
    rev++;
    for (const l of listeners) l(rev);
  };
  return { source, frames, commands, bump, listeners };
}

let server: LiveServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(source: LiveSource, heartbeatMs?: number): Promise<LiveServer> {
  server = await startLiveServer({ port: 0, source, assets: ASSETS, ...(heartbeatMs !== undefined && { heartbeatMs }) });
  return server;
}

describe("the live view server: who it answers", () => {
  it("listens on 127.0.0.1 behind a random 32-hex token", async () => {
    const live = await start(fakeSource().source);
    expect(live.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:${live.port}/v/[0-9a-f]{32}/$`));
    const other = await startLiveServer({ port: 0, source: fakeSource().source, assets: ASSETS });
    expect(other.token).not.toBe(live.token);
    await other.close();
  });

  it("answers nothing outside the token path", async () => {
    const live = await start(fakeSource().source);
    for (const path of ["/", "/state", "/v/", `/v/${live.token}`, `/v/${"0".repeat(32)}/state`, `/v/${live.token}x/state`, `/v/${live.token}/nope`]) {
      const reply = await call(live.port, path);
      expect(reply.status, path).toBe(404);
      expect(reply.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("refuses a Host that isn't 127.0.0.1 or localhost on its own port", async () => {
    const live = await start(fakeSource().source);
    const state = `/v/${live.token}/state`;
    for (const host of ["evil.example", `evil.example:${live.port}`, "127.0.0.1", `127.0.0.1:${live.port + 1}`, `localhost.evil:${live.port}`]) {
      expect((await call(live.port, state, { host })).status, host).toBe(403);
    }
    expect((await call(live.port, state, { host: `localhost:${live.port}` })).status).toBe(200);
    expect((await call(live.port, state, { host: `127.0.0.1:${live.port}` })).status).toBe(200);
  });
});

describe("the live view server: endpoints", () => {
  it("serves the page with the CSP, and its script and style", async () => {
    const live = await start(fakeSource().source);
    const page = await call(live.port, `/v/${live.token}/`);
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
    expect(page.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).toBe("default-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.body.toString()).toBe(ASSETS.html);

    const js = await call(live.port, `/v/${live.token}/app.js`);
    expect(js.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(js.body.toString()).toBe(ASSETS.js);
    const css = await call(live.port, `/v/${live.token}/app.css`);
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect(css.body.toString()).toBe(ASSETS.css);
  });

  it("answers /state with the source's state as JSON", async () => {
    const live = await start(fakeSource().source);
    const reply = await call(live.port, `/v/${live.token}/state`);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(JSON.parse(reply.body.toString())).toEqual({ slu: 1, rev: 3 });
  });

  it("answers /frame with the image, and passes the size, region and before on", async () => {
    const fake = fakeSource();
    const live = await start(fake.source);
    const whole = await call(live.port, `/v/${live.token}/frame?rev=3&w=1200&h=800&before=0`);
    expect(whole.status).toBe(200);
    expect(whole.headers["content-type"]).toBe("image/png");
    expect(whole.headers["cache-control"]).toBe("no-store");
    expect([...whole.body]).toEqual([...PNG]);

    await call(live.port, `/v/${live.token}/frame?rev=3&w=640&h=480&x=0.25&y=0.5&zw=0.5&zh=0.25&before=1`);
    expect(fake.frames).toEqual([
      { width: 1200, height: 800, region: null, before: false },
      { width: 640, height: 480, region: { x: 0.25, y: 0.5, w: 0.5, h: 0.25 }, before: true },
    ]);
  });

  it("refuses a frame query it can't read", async () => {
    const fake = fakeSource();
    const live = await start(fake.source);
    for (const query of ["w=0&h=10", "w=10&h=abc", "w=10&h=10&x=0.1", "w=10&h=10&x=0.1&y=0.1&zw=0&zh=0.5", "w=10&h=10&x=-1&y=0&zw=0.5&zh=0.5", "w=10&h=10&before=yes"]) {
      expect((await call(live.port, `/v/${live.token}/frame?${query}`)).status, query).toBe(400);
    }
    expect(fake.frames).toEqual([]);
  });

  it("says no content for a frame a newer ask replaced, and why a frame failed", async () => {
    let answer: Uint8Array | null | Error = null;
    const live = await start(fakeSource({
      async frame() {
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }).source);
    expect((await call(live.port, `/v/${live.token}/frame?w=10&h=10`)).status).toBe(204);
    answer = new CliError(3, "The engine stopped.");
    const failed = await call(live.port, `/v/${live.token}/frame?w=10&h=10`);
    expect(failed.status).toBe(503);
    expect(failed.body.toString()).toBe("The engine stopped.");
  });

  it("takes next, prev and before from the page, and nothing else", async () => {
    const fake = fakeSource();
    const live = await start(fake.source);
    const cmd = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
      call(live.port, `/v/${live.token}/cmd`, { method: "POST", body, headers });

    expect((await cmd('{"action":"prev"}')).status).toBe(200);
    expect((await cmd('{"action":"before"}')).status).toBe(200);
    expect((await cmd('{"action":"next"}')).status).toBe(400);
    expect((await cmd('{"action":"set","key":"exposure","value":2}')).status).toBe(400);
    expect((await cmd("not json")).status).toBe(400);
    expect((await cmd('{"action":"prev"}', { "content-type": "text/plain" })).status).toBe(415);
    expect((await cmd('{"action":"prev"}', { "content-type": "application/json", origin: "http://evil.example" })).status).toBe(403);
    expect((await call(live.port, `/v/${live.token}/cmd`)).status).toBe(405);
    expect((await call(live.port, `/v/${live.token}/state`, { method: "POST", body: "{}" })).status).toBe(405);
    expect(fake.commands).toEqual(["prev", "before", "next"]);
  });
});

describe("the live view server: events", () => {
  it("sends the rev at once, then a rev event on each change, with heartbeats between", async () => {
    const fake = fakeSource();
    const live = await start(fake.source, 20);
    const got = await events(live.port, `/v/${live.token}/events`, 3, () => {
      setTimeout(() => { fake.bump(); fake.bump(); }, 30);
    });
    expect(got.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(got.events[0]).toBe('event: state\ndata: {"rev":3}');
    expect(got.events.slice(1).map((e) => e.split("\n").filter((l) => !l.startsWith(":")).join("\n"))).toEqual([
      'event: state\ndata: {"rev":4}',
      'event: state\ndata: {"rev":5}',
    ]);
  });

  it("closes its event streams and stops listening when it stops", async () => {
    const fake = fakeSource();
    const live = await start(fake.source);
    const ended = new Promise<void>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: live.port, path: `/v/${live.token}/events`, headers: { host: `127.0.0.1:${live.port}` } }, (res) => {
        res.on("data", () => {});
        res.on("end", resolve);
        res.on("error", resolve);
        res.on("close", resolve);
        void live.close();
      });
      req.on("error", reject);
      req.end();
    });
    await ended;
    server = null;
    expect(fake.listeners.size).toBe(0);
    await expect(call(live.port, `/v/${live.token}/state`)).rejects.toThrow();
  });
});
