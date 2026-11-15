// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The live view's web server. It listens on 127.0.0.1 only and answers only
// under a random token path, to a Host of 127.0.0.1 or localhost on its own
// port (so a web page can't reach it by rebinding a name to this machine). It
// sends no CORS headers, and the page can only step through the open photos:
// nothing it sends changes a value.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PreviewRegion } from "@/engine/protocol";
import { CliError } from "../types";

export const CSP = "default-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";
const HEARTBEAT_MS = 15_000;
const MAX_EDGE = 8192;
const MAX_BODY = 1024;

export interface PageAssets { html: string; js: string; css: string }

/** What `/frame` asks for: a frame inside width × height of `region` (null: the whole photo). */
export interface FrameQuery { width: number; height: number; region: PreviewRegion | null; before: boolean }

export type PageAction = "next" | "prev" | "before";

export interface LiveSource {
  state(): { rev: number };
  /** Calls `listener` with each new rev; returns the unsubscribe. */
  subscribe(listener: (rev: number) => void): () => void;
  /** The image's bytes, or null when a newer ask took its place. */
  frame(query: FrameQuery): Promise<Uint8Array | null>;
  /** False when the action can't be done now (next with no open photos). */
  command(action: PageAction): Promise<boolean>;
}

export interface LiveServerOptions {
  /** 0 picks a free one. */
  port: number;
  source: LiveSource;
  assets: PageAssets;
  token?: string;
  heartbeatMs?: number;
}

export interface LiveServer { url: string; port: number; token: string; close(): Promise<void> }

const ACTIONS: ReadonlySet<string> = new Set<PageAction>(["next", "prev", "before"]);

class BadRequest extends Error {}

function imageType(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  return "image/png";
}

function numberParam(params: URLSearchParams, name: string): number | undefined {
  const text = params.get(name);
  if (text === null) return undefined;
  const value = Number(text);
  if (text.trim() === "" || !Number.isFinite(value)) throw new BadRequest(`${name} isn't a number`);
  return value;
}

export function parseFrameQuery(params: URLSearchParams): FrameQuery {
  const edge = (name: string): number => {
    const value = numberParam(params, name);
    if (value === undefined || !Number.isInteger(value) || value < 1) throw new BadRequest(`${name} needs a whole number of pixels`);
    return Math.min(value, MAX_EDGE);
  };
  const width = edge("w");
  const height = edge("h");
  numberParam(params, "rev");
  const parts = ["x", "y", "zw", "zh"].map((name) => numberParam(params, name));
  let region: PreviewRegion | null = null;
  if (parts.some((p) => p !== undefined)) {
    const [x, y, w, h] = parts;
    if (x === undefined || y === undefined || w === undefined || h === undefined) throw new BadRequest("a region needs x, y, zw and zh");
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 + 1e-6 || y + h > 1 + 1e-6) throw new BadRequest("the region is outside the photo");
    region = { x, y, w: Math.min(w, 1 - x), h: Math.min(h, 1 - y) };
  }
  const before = params.get("before");
  if (before !== null && before !== "0" && before !== "1") throw new BadRequest("before is 0 or 1");
  return { width, height, region, before: before === "1" };
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new BadRequest("too long"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export async function startLiveServer(options: LiveServerOptions): Promise<LiveServer> {
  const { source, assets } = options;
  const token = options.token ?? randomBytes(16).toString("hex");
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const streams = new Set<ServerResponse>();
  const stops = new Set<() => void>();
  let port = 0;

  const send = (res: ServerResponse, status: number, type: string | null, body?: string | Uint8Array): void => {
    res.writeHead(status, {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": CSP,
      ...(type !== null && { "Content-Type": type }),
    });
    res.end(body);
  };
  const text = (res: ServerResponse, status: number, message: string): void => send(res, status, "text/plain; charset=utf-8", message);

  const hostAllowed = (host: string | undefined): boolean => {
    const h = host?.toLowerCase();
    return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
  };

  function openEvents(req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      Connection: "keep-alive",
    });
    const event = (rev: number): void => { res.write(`event: state\ndata: ${JSON.stringify({ rev })}\n\n`); };
    event(source.state().rev);
    const unsubscribe = source.subscribe(event);
    const beat = setInterval(() => res.write(": keep-alive\n\n"), heartbeatMs);
    const stop = (): void => {
      clearInterval(beat);
      unsubscribe();
      streams.delete(res);
      stops.delete(stop);
    };
    streams.add(res);
    stops.add(stop);
    req.on("close", stop);
  }

  async function frame(res: ServerResponse, params: URLSearchParams): Promise<void> {
    const query = parseFrameQuery(params);
    let bytes: Uint8Array | null;
    try {
      bytes = await source.frame(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The photo's own fault (it can't be read) isn't the engine's.
      text(res, error instanceof CliError && error.code === 2 ? 422 : error instanceof CliError ? 503 : 500, message);
      return;
    }
    if (bytes === null) send(res, 204, null);
    else send(res, 200, imageType(bytes), bytes);
  }

  async function command(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const type = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      text(res, 415, "JSON only.");
      return;
    }
    // A page from anywhere else can't send JSON here without a preflight, which nothing answers; an Origin is checked anyway.
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      text(res, 403, "Not from this page.");
      return;
    }
    let action: unknown;
    try {
      action = (JSON.parse(await readBody(req)) as { action?: unknown } | null)?.action;
    } catch {
      throw new BadRequest("not JSON");
    }
    if (typeof action !== "string" || !ACTIONS.has(action)) throw new BadRequest("unknown action");
    if (!(await source.command(action as PageAction))) throw new BadRequest(`${action} isn't possible now`);
    send(res, 200, "application/json; charset=utf-8", '{"ok":true}');
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostAllowed(req.headers.host)) {
      text(res, 403, "Forbidden.");
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const match = /^\/v\/([^/]+)\/(.*)$/.exec(url.pathname);
    if (!match || !sameToken(match[1], token)) {
      text(res, 404, "Not found.");
      return;
    }
    const route = match[2];
    const method = req.method ?? "GET";
    const known = ["", "app.js", "app.css", "state", "frame", "events", "cmd"];
    if (!known.includes(route)) {
      text(res, 404, "Not found.");
      return;
    }
    if (route === "cmd" ? method !== "POST" : method !== "GET") {
      text(res, 405, "Method not allowed.");
      return;
    }
    switch (route) {
      case "": return send(res, 200, "text/html; charset=utf-8", assets.html);
      case "app.js": return send(res, 200, "text/javascript; charset=utf-8", assets.js);
      case "app.css": return send(res, 200, "text/css; charset=utf-8", assets.css);
      case "state": return send(res, 200, "application/json; charset=utf-8", JSON.stringify(source.state()));
      case "events": return openEvents(req, res);
      case "frame": return frame(res, url.searchParams);
      case "cmd": return command(req, res);
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof BadRequest) text(res, 400, `${error.message}.`);
      else text(res, 500, error instanceof Error ? error.message : String(error));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : options.port;

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${port}/v/${token}/`,
    port,
    token,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const res of [...streams]) res.end();
        for (const stop of [...stops]) stop();
        server.close(() => resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
