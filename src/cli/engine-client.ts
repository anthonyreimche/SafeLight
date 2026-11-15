// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Starts the hidden engine and talks to it over the wire in engine/protocol.ts.

import { spawn } from "node:child_process";
import type { Socket } from "node:net";
import { ENGINE_PROTOCOL, WIRE_FRAME, WIRE_JSON, WireDecoder, type EngineEvent, type EngineRequest } from "@/engine/protocol";
import type { LockInfo } from "@/project/storage-options";
import { enginePipePath, listenForEngine, type EnginePipe } from "./engine-pipe";
import type { Output } from "./output/types";
import { CliError, type CliEnv, COMMAND } from "./types";

/** An image frame the engine sent after its "frame" event. */
export interface EngineFrame { frame: number; bytes: Uint8Array }

/** How a caller stops a request it no longer wants. */
export interface RequestOptions {
  /** Aborting asks the engine to cancel; the request still ends on the engine's own "done". If that
   *  doesn't come within the grace time the engine is killed. */
  signal?: AbortSignal;
  /** Aborting kills the engine at once: the second Ctrl+C. */
  force?: AbortSignal;
}

export interface EngineClient {
  /** The events (and frames) answering one request, ending after "done" or "error". */
  request(req: EngineRequest, options?: RequestOptions): AsyncIterable<EngineEvent | EngineFrame>;
  shutdown(): Promise<void>;
}

/** The part of a child process the client uses; tests supply a fake. The wire
 *  itself runs over the socket the engine connects to (engine-pipe.ts). */
export interface EngineChild {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "exit", listener: (code: number | null) => void): unknown;
  kill(): unknown;
}

export interface EngineSpawn {
  (command: string, args: string[], env: Record<string, string>): EngineChild;
}

const spawnEngine: EngineSpawn = (command, args, env) => {
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (!child.stdout || !child.stderr) throw new Error("engine pipes missing");
  return child as unknown as EngineChild;
};

const BASE_TIMEOUT_S = 60;
/** How long a dropped connection waits for the engine's exit code before giving up on it. */
const LINK_CLOSE_GRACE_MS = 500;
const PER_PHOTO_TIMEOUT_S = 30;
const SHUTDOWN_GRACE_MS = 2000;
const CANCEL_GRACE_S = 10;

type CancelRequest = Extract<EngineRequest, { type: "cancel" }>;
type ImportRequest = Extract<EngineRequest, { type: "import" }>;
type ThumbsRequest = Extract<EngineRequest, { type: "thumbs" }>;

export function engineArgs(env: CliEnv, pipe: string): string[] {
  return [env.appRoot, "--engine", `--slu-protocol=${ENGINE_PROTOCOL}`, `--slu-pipe=${pipe}`];
}

/** The engine runs as Electron proper: ELECTRON_RUN_AS_NODE is what made safelight itself a plain Node. */
export function engineEnv(env: CliEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env.env)) {
    if (value !== undefined && key !== "ELECTRON_RUN_AS_NODE") out[key] = value;
  }
  return out;
}

function timeoutOverride(env: CliEnv): number | null {
  const override = Number(env.env.SLU_ENGINE_TIMEOUT);
  return env.env.SLU_ENGINE_TIMEOUT !== undefined && Number.isFinite(override) && override > 0 ? override : null;
}

function timeoutSeconds(env: CliEnv, req: EngineRequest): number {
  const override = timeoutOverride(env);
  if (override !== null) return override;
  const photos = req.type === "export" || req.type === "thumbs" ? req.photoIds.length : 0;
  return BASE_TIMEOUT_S + PER_PHOTO_TIMEOUT_S * photos;
}

/** An import's length isn't known when it starts, so its limit is on silence:
 *  every event it sends starts the time again. */
const timesOutWhenQuiet = (req: EngineRequest): boolean => req.type === "import";

function cancelGraceSeconds(env: CliEnv): number {
  const override = Number(env.env.SLU_ENGINE_CANCEL_GRACE);
  return env.env.SLU_ENGINE_CANCEL_GRACE !== undefined && Number.isFinite(override) && override > 0 ? override : CANCEL_GRACE_S;
}

type Item = EngineEvent | EngineFrame;

/** An unbounded async queue one request reads from. */
class Inbox {
  private items: Item[] = [];
  private failure: CliError | null = null;
  private waiting: (() => void) | null = null;

  push(item: Item): void {
    this.items.push(item);
    this.wake();
  }

  fail(error: CliError): void {
    this.failure ??= error;
    this.wake();
  }

  async next(): Promise<Item> {
    for (;;) {
      const item = this.items.shift();
      if (item) return item;
      if (this.failure) throw this.failure;
      await new Promise<void>((resolve) => { this.waiting = resolve; });
    }
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }
}

function endsRequest(req: EngineRequest, event: EngineEvent): boolean {
  if (event.type === "done") return true;
  if (event.type === "import-done") return event.stopped === "safelight-opened";
  if (event.type !== "error") return false;
  return !((req.type === "export" || req.type === "thumbs") && event.photoId !== undefined);
}

export function createEngineClient(env: CliEnv, out: Output, spawnFn: EngineSpawn = spawnEngine): EngineClient {
  const decoder = new WireDecoder();
  const inboxes = new Map<number, Inbox>();
  let child: EngineChild | null = null;
  let link: Socket | null = null;
  let ready: Promise<void> | null = null;
  let exited = false;
  let stderrTail = "";
  let cancelSeq = 0;

  const killOnExit = () => { child?.kill(); };

  function failAll(error: CliError): void {
    for (const inbox of inboxes.values()) inbox.fail(error);
  }

  function dispatch(kind: 0 | 1, payload: Uint8Array, onReady: (e: Extract<EngineEvent, { type: "ready" }>) => void): void {
    if (kind === WIRE_FRAME) {
      const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
      const frame = view.getUint32(0, true);
      // the one open request owns frames: the engine answers one request at a time
      for (const inbox of inboxes.values()) inbox.push({ frame, bytes: payload.subarray(4) });
      return;
    }
    if (kind !== WIRE_JSON) return;
    const event = JSON.parse(new TextDecoder().decode(payload)) as EngineEvent;
    if (event.type === "ready") onReady(event);
    else if (event.type === "log") out.info(`engine: ${event.message}`);
    else inboxes.get(event.id)?.push(event);
  }

  function start(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const startFailure = (why: string) => new CliError(
        3,
        `The engine didn't start: ${why}`,
        `${COMMAND} doctor shows what ${COMMAND} found; -vv prints the engine's own log.`,
      );
      if (env.electronBinary === null) {
        reject(new CliError(
          3,
          "Can't find Safelight's engine. Build the app first, or set SAFELIGHT_ELECTRON.",
          `${COMMAND} doctor shows what ${COMMAND} found.`,
        ));
        return;
      }
      const binary = env.electronBinary;
      let settled = false;
      let pipe: EnginePipe | null = null;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const startSeconds = timeoutOverride(env) ?? BASE_TIMEOUT_S;
      const startTimer = setTimeout(() => {
        const why = link ? "it wasn't ready" : "it never connected";
        settle(() => reject(startFailure(`${why} within ${Math.round(startSeconds)} s.`)));
        pipe?.close();
        child?.kill();
      }, startSeconds * 1000);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        fn();
      };

      const stopped = (code: number | null) => {
        if (exited) return;
        exited = true;
        if (closeTimer) clearTimeout(closeTimer);
        pipe?.close();
        const detail = stderrTail.trim().split(/\r?\n/).pop();
        const failure = new CliError(
          3,
          `The engine stopped${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail}` : "."}`,
          `${COMMAND} doctor shows what ${COMMAND} found; -vv prints the engine's own log.`,
        );
        settle(() => reject(failure));
        failAll(failure);
      };

      const logText = (chunk: Uint8Array | string): string => {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        if (out.options.verbosity === "debug" && text.trim() !== "") out.info(text.trimEnd());
        return text;
      };

      const readWire = (chunk: Uint8Array) => {
        try {
          for (const message of decoder.push(chunk)) {
            dispatch(message.kind, message.payload, (event) => {
              if (event.protocol !== ENGINE_PROTOCOL) {
                settle(() => reject(startFailure(`it speaks protocol ${event.protocol}, ${COMMAND} speaks ${ENGINE_PROTOCOL}.`)));
                return;
              }
              out.info(`engine ready (${event.backend}${event.software ? ", software rendering" : ""})`);
              settle(resolve);
            });
          }
        } catch (error) {
          const failure = new CliError(3, `The engine sent something ${COMMAND} can't read: ${error instanceof Error ? error.message : String(error)}`);
          settle(() => reject(failure));
          failAll(failure);
        }
      };

      const launch = (listening: EnginePipe) => {
        pipe = listening;
        let running: EngineChild;
        try {
          running = spawnFn(binary, engineArgs(env, listening.path), engineEnv(env));
        } catch (error) {
          listening.close();
          settle(() => reject(startFailure(error instanceof Error ? error.message : String(error))));
          return;
        }
        child = running;
        process.once("exit", killOnExit);

        running.on("error", (error) => {
          exited = true;
          listening.close();
          const failure = startFailure(error.message);
          settle(() => reject(failure));
          failAll(failure);
        });
        running.on("exit", stopped);
        running.stderr.on("data", (chunk: Uint8Array | string) => {
          stderrTail = (stderrTail + logText(chunk)).slice(-2000);
        });
        // Electron writes a stray CRLF here on Windows; nothing else should come.
        running.stdout.on("data", logText);

        void listening.connection.then((socket) => {
          if (exited) {
            socket.destroy();
            return;
          }
          link = socket;
          socket.on("data", readWire);
          socket.on("error", (error) => logText(`engine connection: ${error.message}\n`));
          // The process's own exit names its code; wait a moment for it.
          socket.on("close", () => {
            closeTimer = setTimeout(() => {
              stopped(null);
              running.kill();
            }, LINK_CLOSE_GRACE_MS);
          });
        });
      };

      listenForEngine(enginePipePath()).then(
        (listening) => {
          if (settled) listening.close();
          else launch(listening);
        },
        (error: unknown) => {
          settle(() => reject(startFailure(`it had no socket to connect to: ${error instanceof Error ? error.message : String(error)}`)));
        },
      );
    });
  }

  async function* request(req: EngineRequest, options: RequestOptions = {}): AsyncGenerator<Item> {
    ready ??= start();
    await ready;
    if (!child || !link || exited) throw new CliError(3, "The engine isn't running.");
    const running = child;
    const wire = link;
    const { signal, force } = options;
    if (signal?.aborted || force?.aborted) return;
    const inbox = new Inbox();
    inboxes.set(req.id, inbox);
    const seconds = timeoutSeconds(env, req);
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const timeOut = () => setTimeout(() => {
      inbox.fail(new CliError(3, `The engine didn't answer within ${Math.round(seconds)} s.`, "SLU_ENGINE_TIMEOUT sets the limit in seconds."));
      running.kill();
    }, seconds * 1000);
    let timer = timeOut();
    const onCancel = () => {
      cancelled = true;
      clearTimeout(timer);
      const cancel: CancelRequest = { id: -(++cancelSeq), type: "cancel", target: req.id };
      wire.write(`${JSON.stringify(cancel)}\n`);
      const grace = cancelGraceSeconds(env);
      graceTimer = setTimeout(() => {
        inbox.fail(new CliError(3, `The engine didn't stop within ${Math.round(grace)} s, so it was stopped.`));
        running.kill();
      }, grace * 1000);
    };
    const onForce = () => {
      inbox.fail(new CliError(3, "The engine was stopped."));
      running.kill();
    };
    signal?.addEventListener("abort", onCancel, { once: true });
    force?.addEventListener("abort", onForce, { once: true });
    try {
      wire.write(`${JSON.stringify(req)}\n`);
      for (;;) {
        const item = await inbox.next();
        if (timesOutWhenQuiet(req) && !cancelled) {
          clearTimeout(timer);
          timer = timeOut();
        }
        yield item;
        if ("type" in item && endsRequest(req, item)) return;
      }
    } finally {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      signal?.removeEventListener("abort", onCancel);
      force?.removeEventListener("abort", onForce);
      inboxes.delete(req.id);
    }
  }

  async function shutdown(): Promise<void> {
    process.removeListener("exit", killOnExit);
    const running = child;
    const wire = link;
    if (!running || exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { running.kill(); resolve(); }, SHUTDOWN_GRACE_MS);
      running.on("exit", () => { clearTimeout(timer); resolve(); });
      if (wire) wire.end(`${JSON.stringify({ id: 0, type: "shutdown" })}\n`);
      else running.kill();
    });
  }

  return { request, shutdown };
}

/** Exit 4 for a project whose writer lock someone else holds. */
export function lockHeldError(root: string, heldBy: Pick<LockInfo, "app">): CliError {
  return heldBy.app === "safelight"
    ? new CliError(4, `Safelight has ${root} open. Close the folder there, or add --wait.`)
    : new CliError(4, `Another ${COMMAND} command is writing to ${root}.`, "Let it finish, or add --wait.");
}

export type ImportEvent = Extract<EngineEvent, { type: "import-plan" | "import-file" | "progress" | "import-done" }>;

/** An import's events as they come. A held lock is exit 4; the engine's other
 *  failures are exit 2 when the project can't be opened, else 3. */
export async function* importEvents(client: EngineClient, req: ImportRequest, options?: RequestOptions): AsyncGenerator<ImportEvent> {
  for await (const item of client.request(req, options)) {
    if (!("type" in item) || item.type === "done") continue;
    if (item.type === "error") {
      if (item.code === "locked" && item.heldBy) throw lockHeldError(req.project.root, item.heldBy);
      throw new CliError(item.code === "project" ? 2 : 3, item.message);
    }
    if (item.type === "import-plan" || item.type === "import-file" || item.type === "progress" || item.type === "import-done") yield item;
  }
}

export type Thumb =
  | { photoId: string; width: number; height: number; encoding: "png" | "rgba"; bytes: Uint8Array }
  | { photoId: string; error: string };

/** Each photo's stored preview, or why it has none, in the order the engine sends them. */
export async function* thumbFrames(client: EngineClient, req: ThumbsRequest, options?: RequestOptions): AsyncGenerator<Thumb> {
  const announced = new Map<number, Extract<EngineEvent, { type: "frame" }>>();
  for await (const item of client.request(req, options)) {
    if (!("type" in item)) {
      const frame = announced.get(item.frame);
      announced.delete(item.frame);
      if (frame?.photoId !== undefined) {
        yield { photoId: frame.photoId, width: frame.width, height: frame.height, encoding: frame.encoding, bytes: item.bytes };
      }
    } else if (item.type === "frame") {
      announced.set(item.frame, item);
    } else if (item.type === "error") {
      if (item.photoId === undefined) throw new CliError(item.code === "project" ? 2 : 3, item.message);
      yield { photoId: item.photoId, error: item.message };
    }
  }
}

/** One engine shared by the commands of a prompt session. */
export interface EngineSession {
  /** A client for one command. It reuses the session's engine; its shutdown leaves the engine running. */
  client(out: Output): EngineClient;
  /** Stops the engine now, if one is running. */
  close(): Promise<void>;
}

const SESSION_IDLE_MS = 10 * 60 * 1000;

/** Keeps one engine alive between commands. The engine serves one request at a time over
 *  the same wire, so a second command only needs the first's engine to still be healthy:
 *  one that failed, died or was abandoned mid-request is dropped and the next use starts a new one. */
export function createEngineSession(makeClient: (out: Output) => EngineClient, idleMs: number = SESSION_IDLE_MS): EngineSession {
  let live: EngineClient | null = null;
  let current: Output | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;

  // The engine logs through whichever command is running now.
  const forwarded = new Proxy({} as Output, {
    get(_target, key) {
      const value: unknown = current ? Reflect.get(current, key) : undefined;
      return typeof value === "function" ? value.bind(current) : value;
    },
  });

  const stopIdleTimer = () => {
    if (idle) clearTimeout(idle);
    idle = null;
  };

  async function drop(): Promise<void> {
    stopIdleTimer();
    const engine = live;
    live = null;
    await engine?.shutdown();
  }

  function startIdleTimer(): void {
    stopIdleTimer();
    idle = setTimeout(() => { void drop(); }, idleMs);
    idle.unref();
  }

  async function* request(req: EngineRequest, options?: RequestOptions): AsyncGenerator<EngineEvent | EngineFrame> {
    stopIdleTimer();
    for (let attempt = 0; ; attempt++) {
      const reused = live !== null;
      const engine = (live ??= makeClient(forwarded));
      let yielded = false;
      let finished = false;
      try {
        for await (const item of engine.request(req, options)) {
          yielded = true;
          yield item;
        }
        finished = true;
        return;
      } catch (error) {
        // An engine that died while idle fails before saying anything: one fresh start is free.
        const stopped = options?.signal?.aborted === true || options?.force?.aborted === true;
        const retry = reused && !yielded && attempt === 0 && !stopped && error instanceof CliError && error.code === 3;
        await drop();
        finished = true;
        if (!retry) throw error;
      } finally {
        if (!finished) await drop();
        else if (live) startIdleTimer();
      }
    }
  }

  return {
    client(out) {
      current = out;
      return { request, shutdown: async () => { if (live) startIdleTimer(); } };
    },
    close: drop,
  };
}
