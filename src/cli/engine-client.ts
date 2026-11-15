// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Starts the hidden engine and talks to it over the wire in engine/protocol.ts.

import { spawn } from "node:child_process";
import { ENGINE_PROTOCOL, WIRE_FRAME, WIRE_JSON, WireDecoder, type EngineEvent, type EngineRequest } from "@/engine/protocol";
import type { Output } from "./output/types";
import { CliError, type CliEnv } from "./types";

/** An image frame the engine sent after its "frame" event. */
export interface EngineFrame { frame: number; bytes: Uint8Array }

export interface EngineClient {
  /** The events (and frames) answering one request, ending after "done" or "error". */
  request(req: EngineRequest): AsyncIterable<EngineEvent | EngineFrame>;
  shutdown(): Promise<void>;
}

/** The part of a child process the client uses; tests supply a fake. */
export interface EngineChild {
  stdin: { write(chunk: string): unknown; end(): unknown };
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
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("engine pipes missing");
  return child as unknown as EngineChild;
};

const BASE_TIMEOUT_S = 60;
const PER_PHOTO_TIMEOUT_S = 30;
const SHUTDOWN_GRACE_MS = 2000;

export function engineArgs(env: CliEnv): string[] {
  return [env.appRoot, "--engine", `--slu-protocol=${ENGINE_PROTOCOL}`];
}

/** The engine runs as Electron proper: ELECTRON_RUN_AS_NODE is what made slu itself a plain Node. */
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
  const photos = req.type === "export" ? req.photoIds.length : 0;
  return BASE_TIMEOUT_S + PER_PHOTO_TIMEOUT_S * photos;
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
  if (event.type !== "error") return false;
  return !(req.type === "export" && event.photoId !== undefined);
}

export function createEngineClient(env: CliEnv, out: Output, spawnFn: EngineSpawn = spawnEngine): EngineClient {
  const decoder = new WireDecoder();
  const inboxes = new Map<number, Inbox>();
  let child: EngineChild | null = null;
  let ready: Promise<void> | null = null;
  let exited = false;
  let stderrTail = "";

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
        "slu doctor shows what slu found; -vv prints the engine's own log.",
      );
      try {
        child = spawnFn(process.execPath, engineArgs(env), engineEnv(env));
      } catch (error) {
        reject(startFailure(error instanceof Error ? error.message : String(error)));
        return;
      }
      process.once("exit", killOnExit);
      let settled = false;
      const startSeconds = timeoutOverride(env) ?? BASE_TIMEOUT_S;
      const startTimer = setTimeout(() => {
        settle(() => reject(startFailure(`it wasn't ready within ${Math.round(startSeconds)} s.`)));
        child?.kill();
      }, startSeconds * 1000);
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(startTimer);
        fn();
      };

      child.on("error", (error) => {
        exited = true;
        const failure = startFailure(error.message);
        settle(() => reject(failure));
        failAll(failure);
      });
      child.on("exit", (code) => {
        exited = true;
        const detail = stderrTail.trim().split(/\r?\n/).pop();
        const failure = new CliError(
          3,
          `The engine stopped${code === null ? "" : ` (exit ${code})`}${detail ? `: ${detail}` : "."}`,
          "slu doctor shows what slu found; -vv prints the engine's own log.",
        );
        settle(() => reject(failure));
        failAll(failure);
      });
      child.stderr.on("data", (chunk: Uint8Array | string) => {
        const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
        stderrTail = (stderrTail + text).slice(-2000);
        if (out.options.verbosity === "debug") out.info(text.trimEnd());
      });
      child.stdout.on("data", (chunk: Uint8Array | string) => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
        try {
          for (const message of decoder.push(bytes)) {
            dispatch(message.kind, message.payload, (event) => {
              if (event.protocol !== ENGINE_PROTOCOL) {
                settle(() => reject(startFailure(`it speaks protocol ${event.protocol}, slu speaks ${ENGINE_PROTOCOL}.`)));
                return;
              }
              out.info(`engine ready (${event.backend}${event.software ? ", software rendering" : ""})`);
              settle(resolve);
            });
          }
        } catch (error) {
          const failure = new CliError(3, `The engine sent something slu can't read: ${error instanceof Error ? error.message : String(error)}`);
          settle(() => reject(failure));
          failAll(failure);
        }
      });
    });
  }

  async function* request(req: EngineRequest): AsyncGenerator<Item> {
    ready ??= start();
    await ready;
    if (!child || exited) throw new CliError(3, "The engine isn't running.");
    const inbox = new Inbox();
    inboxes.set(req.id, inbox);
    const seconds = timeoutSeconds(env, req);
    const timer = setTimeout(() => {
      inbox.fail(new CliError(3, `The engine didn't answer within ${Math.round(seconds)} s.`, "SLU_ENGINE_TIMEOUT sets the limit in seconds."));
      child?.kill();
    }, seconds * 1000);
    try {
      child.stdin.write(`${JSON.stringify(req)}\n`);
      for (;;) {
        const item = await inbox.next();
        yield item;
        if ("type" in item && endsRequest(req, item)) return;
      }
    } finally {
      clearTimeout(timer);
      inboxes.delete(req.id);
    }
  }

  async function shutdown(): Promise<void> {
    process.removeListener("exit", killOnExit);
    const running = child;
    if (!running || exited) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { running.kill(); resolve(); }, SHUTDOWN_GRACE_MS);
      running.on("exit", () => { clearTimeout(timer); resolve(); });
      try {
        running.stdin.write(`${JSON.stringify({ id: 0, type: "shutdown" })}\n`);
        running.stdin.end();
      } catch {
        running.kill();
      }
    });
  }

  return { request, shutdown };
}
