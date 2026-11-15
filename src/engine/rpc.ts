// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The engine page's side of the port to the main process: requests in, events
// and frame bytes out, one request at a time, and a cancel at any time. The main
// process writes each event as a JSON wire message and each FrameBytes as a
// binary one.

import type { LockInfo } from "@/project/storage-options";
import type { EngineEvent, EngineRequest } from "./protocol";

type ErrorCode = Extract<EngineEvent, { type: "error" }>["code"];
export type ExportRequest = Extract<EngineRequest, { type: "export" }>;
export type PreviewRequest = Extract<EngineRequest, { type: "preview" }>;
export type ImportRequest = Extract<EngineRequest, { type: "import" }>;
export type ThumbsRequest = Extract<EngineRequest, { type: "thumbs" }>;
type QueuedRequest = Exclude<EngineRequest, { type: "cancel" }>;

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
  readonly heldBy?: LockInfo;
  constructor(code: ErrorCode, message: string, heldBy?: LockInfo) {
    super(message);
    this.code = code;
    if (heldBy) this.heldBy = heldBy;
  }
}

/** How a handler answers its request. A handler that resolves is followed by
 *  "done"; one that throws, by an error event that ends the request. A handler
 *  whose signal aborts stops where it can and resolves with what it did. */
export interface RequestOut {
  emit(event: EngineEvent): void;
  /** Sends `bytes` as the next frame, after the event `announce` makes for its number. */
  frame(bytes: Uint8Array, announce: (frame: number) => EngineEvent): void;
}

export interface EngineHandlers {
  export(req: ExportRequest, out: RequestOut, signal: AbortSignal): Promise<void>;
  preview(req: PreviewRequest, out: RequestOut, signal: AbortSignal): Promise<void>;
  import(req: ImportRequest, out: RequestOut, signal: AbortSignal): Promise<void>;
  thumbs(req: ThumbsRequest, out: RequestOut, signal: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
}

const REQUEST_TYPES: ReadonlySet<string> = new Set(["export", "preview", "import", "thumbs", "cancel", "shutdown"]);

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
  if (typeof type !== "string" || !REQUEST_TYPES.has(type)) return `an unknown request type ${String(type)}`;
  return value as EngineRequest;
}

/** Serves requests from `channel` with `handlers` until a shutdown request. */
export function serveEngine(channel: EngineChannel, handlers: EngineHandlers): void {
  let queue: Promise<void> = Promise.resolve();
  let closed = false;
  let frames = 0;
  /** The requests queued or running, by id, each with what stops it. */
  const live = new Map<number, AbortController>();

  const out: RequestOut = {
    emit: (event) => channel.send(event),
    frame: (bytes, announce) => {
      const frame = ++frames;
      channel.send(announce(frame));
      channel.send({ frame, bytes });
    },
  };

  const handle = (req: QueuedRequest, signal: AbortSignal): Promise<void> => {
    switch (req.type) {
      case "shutdown":
        return handlers.shutdown();
      case "export":
        return handlers.export(req, out, signal);
      case "preview":
        return handlers.preview(req, out, signal);
      case "import":
        return handlers.import(req, out, signal);
      case "thumbs":
        return handlers.thumbs(req, out, signal);
    }
  };

  const run = async (req: QueuedRequest, stop: AbortController): Promise<void> => {
    try {
      if (!stop.signal.aborted) await handle(req, stop.signal);
      out.emit({ id: req.id, type: "done" });
    } catch (e) {
      const code = e instanceof EngineFailure ? e.code : "internal";
      const message = e instanceof Error ? e.message : String(e);
      const heldBy = e instanceof EngineFailure ? e.heldBy : undefined;
      out.emit({ id: req.id, type: "error", code, message, ...(heldBy ? { heldBy } : {}) });
    } finally {
      live.delete(req.id);
    }
  };

  channel.listen((data) => {
    const req = parseRequest(data);
    if (typeof req === "string") {
      if (!closed) out.emit({ id: 0, type: "log", level: "warn", message: `engine: ignored ${req}` });
      return;
    }
    // A cancel jumps the queue, and still reaches a request a shutdown waits behind.
    if (req.type === "cancel") {
      live.get(req.target)?.abort();
      return;
    }
    if (closed) return;
    if (req.type === "shutdown") closed = true;
    const stop = new AbortController();
    live.set(req.id, stop);
    queue = queue.then(() => run(req, stop));
  });
}
