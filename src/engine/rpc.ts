// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The engine page's side of the port to the main process: requests in, events
// and frame bytes out, one request at a time. The main process writes each
// event as a JSON wire message and each FrameBytes as a binary one.

import type { EngineEvent, EngineRequest } from "./protocol";

type ErrorCode = Extract<EngineEvent, { type: "error" }>["code"];
export type ExportRequest = Extract<EngineRequest, { type: "export" }>;
export type PreviewRequest = Extract<EngineRequest, { type: "preview" }>;

/** A frame's payload, sent right after the event that names its number. */
export interface FrameBytes { frame: number; bytes: Uint8Array }

/** What the page posts on the port: an EngineEvent (it has a `type`) or a frame. */
export type PortMessage = EngineEvent | FrameBytes;

/** The port to the main process, as the page uses it. */
export interface EngineChannel {
  send(message: PortMessage): void;
  /** `data` is a request object, or a JSON line holding one. */
  listen(handler: (data: unknown) => void): void;
}

/** A failure the request reports with this code rather than "internal". */
export class EngineFailure extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

/** How a handler answers its request. A handler that resolves is followed by
 *  "done"; one that throws, by an error event that ends the request. */
export interface RequestOut {
  emit(event: EngineEvent): void;
  /** Sends `bytes` as the next frame, after the event `announce` makes for its number. */
  frame(bytes: Uint8Array, announce: (frame: number) => EngineEvent): void;
}

export interface EngineHandlers {
  export(req: ExportRequest, out: RequestOut): Promise<void>;
  preview(req: PreviewRequest, out: RequestOut): Promise<void>;
  shutdown(): Promise<void>;
}

function parseRequest(data: unknown): EngineRequest | string {
  let value = data;
  if (typeof data === "string") {
    try {
      value = JSON.parse(data);
    } catch {
      return "a request that isn't JSON";
    }
  }
  if (typeof value !== "object" || value === null) return "a request that isn't an object";
  const { id, type } = value as { id?: unknown; type?: unknown };
  if (typeof id !== "number") return "a request without an id";
  if (type !== "export" && type !== "preview" && type !== "shutdown") return `an unknown request type ${String(type)}`;
  return value as EngineRequest;
}

/** Serves requests from `channel` with `handlers` until a shutdown request. */
export function serveEngine(channel: EngineChannel, handlers: EngineHandlers): void {
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let frames = 0;

  const out: RequestOut = {
    emit: (event) => channel.send(event),
    frame: (bytes, announce) => {
      const frame = ++frames;
      channel.send(announce(frame));
      channel.send({ frame, bytes });
    },
  };

  const run = async (req: EngineRequest): Promise<void> => {
    try {
      if (req.type === "shutdown") await handlers.shutdown();
      else if (req.type === "export") await handlers.export(req, out);
      else await handlers.preview(req, out);
      out.emit({ id: req.id, type: "done" });
    } catch (e) {
      const code = e instanceof EngineFailure ? e.code : "internal";
      const message = e instanceof Error ? e.message : String(e);
      out.emit({ id: req.id, type: "error", code, message });
    }
  };

  channel.listen((data) => {
    if (closed) return;
    const req = parseRequest(data);
    if (typeof req === "string") {
      out.emit({ id: 0, type: "log", level: "warn", message: `engine: ignored ${req}` });
      return;
    }
    if (req.type === "shutdown") closed = true;
    queue = queue.then(() => run(req));
  });
}
