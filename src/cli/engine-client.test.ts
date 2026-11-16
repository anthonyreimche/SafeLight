import { EventEmitter } from "node:events";
import { connect, type Socket } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { ENGINE_PROTOCOL, encodeWire, WIRE_FRAME, WIRE_JSON, type EngineEvent, type EngineRequest } from "@/engine/protocol";
import { createEngineClient, createEngineSession, importEvents, thumbFrames, timeoutSeconds, timesOutWhenQuiet, type EngineChild, type EngineFrame, type EngineSpawn } from "./engine-client";
import type { Output } from "./output/types";
import { CliError, type CliEnv } from "./types";

/** An engine that connects back to the CLI's socket, as engine-mode.cjs does. */
class FakeChild extends EventEmitter implements EngineChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  /** The request lines the CLI sent, each with its newline. */
  readonly written: string[] = [];
  killed = false;
  spawned = false;
  socket: Socket | null = null;
  private readonly outgoing = new PassThrough();
  private partial = "";

  private readonly connects: boolean;

  constructor(connects = true) { super(); this.connects = connects; }

  readonly spawn: EngineSpawn = (_command, args) => {
    this.spawned = true;
    const pipe = args.find((a) => a.startsWith("--slu-pipe="))?.slice("--slu-pipe=".length);
    if (pipe && this.connects) {
      const socket = connect(pipe);
      this.socket = socket;
      this.outgoing.pipe(socket);
      socket.on("error", () => {});
      socket.on("data", (chunk: Buffer) => {
        const lines = (this.partial + chunk.toString("utf8")).split("\n");
        this.partial = lines.pop() ?? "";
        for (const line of lines) this.written.push(`${line}\n`);
      });
    }
    return this;
  };

  kill() { this.killed = true; this.socket?.destroy(); this.emit("exit", null); }
  send(event: EngineEvent) { this.outgoing.write(encodeWire(WIRE_JSON, new TextEncoder().encode(JSON.stringify(event)))); }
  sendFrame(frame: number, bytes: number[]) {
    const payload = new Uint8Array(4 + bytes.length);
    new DataView(payload.buffer).setUint32(0, frame, true);
    payload.set(bytes, 4);
    this.outgoing.write(encodeWire(WIRE_FRAME, payload));
  }
  async line(n: number): Promise<string> {
    await until(() => this.written.length > n);
    return this.written[n];
  }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

const READY: EngineEvent = { id: 0, type: "ready", protocol: ENGINE_PROTOCOL, appVersion: "3.3.0", backend: "d3d11", software: false, extensions: [] };

function env(extra: Record<string, string> = {}): CliEnv {
  return {
    cwd: "/w", userData: "/u", appRoot: "/app", electronBinary: "/electron", appVersion: "3.3.0", platform: "linux",
    isTTY: { stdin: false, stdout: false, stderr: false },
    env: { PATH: "/bin", ELECTRON_RUN_AS_NODE: "1", ...extra },
  };
}

function output(infos: string[] = []): Output {
  return { options: { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "debug" }, info: (t: string) => infos.push(t) } as unknown as Output;
}

const preview = (id: number): EngineRequest => ({
  id, type: "preview", project: { root: "/p", workingDir: "/p/.safelight", location: "in-folder" },
  photoId: "a", width: 10, height: 10, encoding: "png",
});

async function collect(iter: AsyncIterable<EngineEvent | EngineFrame>) {
  const items: Array<EngineEvent | EngineFrame> = [];
  for await (const item of iter) items.push(item);
  return items;
}

/** Says ready, then waits for the request line it lets through. */
async function started(child: FakeChild, line = 0) {
  child.send(READY);
  await child.line(line);
}

describe("engine client", () => {
  it("spawns Electron proper: ELECTRON_RUN_AS_NODE removed, engine flags passed", async () => {
    const child = new FakeChild();
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const spawnFn: EngineSpawn = (command, args, e) => { calls.push({ command, args, env: e }); return child.spawn(command, args, e); };
    const client = createEngineClient(env(), output(), spawnFn);
    const run = collect(client.request(preview(1)));
    await started(child);
    child.send({ id: 1, type: "done" });
    await run;
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/electron");
    expect(calls[0].args.slice(0, 3)).toEqual(["/app", "--engine", `--slu-protocol=${ENGINE_PROTOCOL}`]);
    expect(calls[0].args[3]).toMatch(/^--slu-pipe=.*safelight-engine-\d+-[0-9a-f]+/);
    expect("ELECTRON_RUN_AS_NODE" in calls[0].env).toBe(false);
    expect(calls[0].env.PATH).toBe("/bin");
  });

  it("sends the request as a JSON line and returns events and frames until done", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(7)));
    await started(child);
    expect(JSON.parse(child.written[0])).toMatchObject({ id: 7, type: "preview" });
    expect(child.written[0].endsWith("\n")).toBe(true);
    child.send({ id: 7, type: "frame", frame: 3, width: 2, height: 1, encoding: "rgba" });
    child.sendFrame(3, [9, 8, 7]);
    child.send({ id: 7, type: "done" });
    const items = await run;
    expect(items.map((i) => ("type" in i ? i.type : "bytes"))).toEqual(["frame", "bytes", "done"]);
    const frame = items[1] as EngineFrame;
    expect(frame.frame).toBe(3);
    expect(Array.from(frame.bytes)).toEqual([9, 8, 7]);
  });

  it("routes the engine's log events to out.info", async () => {
    const child = new FakeChild();
    const infos: string[] = [];
    const client = createEngineClient(env(), output(infos), child.spawn);
    const run = collect(client.request(preview(1)));
    child.send({ id: 0, type: "log", level: "info", message: "warming up" });
    await started(child);
    child.send({ id: 1, type: "done" });
    await run;
    expect(infos).toContain("engine: warming up");
  });

  it("ignores the CRLF Electron writes to its stdout, and logs its stderr at -vv", async () => {
    const child = new FakeChild();
    const infos: string[] = [];
    const client = createEngineClient(env(), output(infos), child.spawn);
    const run = collect(client.request(preview(1)));
    await until(() => child.spawned);
    child.stdout.write("\r\n");
    child.stderr.write("[engine] booting\n");
    await started(child);
    child.send({ id: 1, type: "done" });
    expect(await run).toEqual([{ id: 1, type: "done" }]);
    expect(infos).toContain("[engine] booting");
    expect(infos).not.toContain("");
  });

  it("gives up with exit 3 on an engine that never connects, and stops it", async () => {
    const child = new FakeChild(false);
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.05" }), output(), child.spawn);
    const error = await collect(client.request(preview(1))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("never connected") });
    expect(child.killed).toBe(true);
  });

  it("fails the open request with exit 3 when the engine drops the connection, and stops it", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await started(child);
    child.socket?.end();
    const error = await run.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("The engine stopped") });
    expect(child.killed).toBe(true);
  });

  it("names the exit code and the engine's last words when it exits as the connection drops", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await started(child);
    child.stderr.write("[engine] The graphics process stopped (crashed).\n");
    child.socket?.end();
    await new Promise((r) => setTimeout(r, 20));
    child.emit("exit", 3);
    const error = await run.catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: "The engine stopped (exit 3): [engine] The graphics process stopped (crashed)." });
  });

  it("gives exit 3 when the engine can't start", async () => {
    const client = createEngineClient(env(), output(), () => { throw new Error("spawn ENOENT"); });
    await expect(collect(client.request(preview(1)))).rejects.toMatchObject({ code: 3 });
  });

  it("gives exit 3 with a plain message when no Electron binary was found", async () => {
    let spawned = false;
    const client = createEngineClient({ ...env(), electronBinary: null }, output(), () => { spawned = true; return new FakeChild(); });
    const error = await collect(client.request(preview(1))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: "Can't find Safelight's engine. Build the app first, or set SAFELIGHT_ELECTRON." });
    expect(spawned).toBe(false);
  });

  it("gives exit 3 when the engine dies before it is ready", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await until(() => child.spawned);
    child.stderr.write("GPU process crashed\n");
    child.emit("exit", 1);
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("GPU process crashed") });
  });

  it("gives up on an engine that never says ready, with exit 3, and stops it", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.3" }), output(), child.spawn);
    const error = await collect(client.request(preview(1))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("wasn't ready") });
    expect(child.killed).toBe(true);
  });

  it("refuses an engine that speaks another protocol", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send({ ...READY, protocol: 9 } as EngineEvent);
    await expect(run).rejects.toMatchObject({ code: 3 });
  });

  it("times out a silent engine with exit 3 and stops it", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.3" }), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await started(child);
    await expect(run).rejects.toMatchObject({ code: 3, message: expect.stringContaining("didn't answer") });
    expect(child.killed).toBe(true);
  });

  it("keeps an export going after one photo fails, and ends on a fatal error", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const req: EngineRequest = {
      id: 2, type: "export", project: { root: "/p", workingDir: "/p/.safelight", location: "in-folder" },
      photoIds: ["a", "b"], settings: {}, target: { kind: "dir", dir: "/o" },
    };
    const run = collect(client.request(req));
    await started(child);
    child.send({ id: 2, type: "error", code: "decode", message: "bad", photoId: "a" });
    child.send({ id: 2, type: "error", code: "internal", message: "gone" });
    const items = await run;
    expect(items).toHaveLength(2);
  });

  const project = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" as const };
  const importReq = (id: number): Extract<EngineRequest, { type: "import" }> => ({
    id, type: "import", project: { root: "/p" }, scope: { kind: "all" }, metadata: true, keepBackup: true,
  });
  const thumbsReq = (id: number): Extract<EngineRequest, { type: "thumbs" }> => ({
    id, type: "thumbs", project, photoIds: ["a", "b"], edge: 64, encoding: "rgba",
  });

  it("keeps thumbs going after one photo fails, and ends on a fatal error", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(thumbsReq(3)));
    await started(child);
    child.send({ id: 3, type: "error", code: "decode", message: "bad", photoId: "a" });
    child.send({ id: 3, type: "error", code: "internal", message: "gone" });
    expect(await run).toHaveLength(2);
  });

  it("ends an import that Safelight took over on its import-done", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(importReq(4)));
    await started(child);
    child.send({ id: 4, type: "import-done", moved: [], dropped: [], pending: 0, stopped: "safelight-opened" });
    const items = await run;
    expect(items.map((i) => ("type" in i ? i.type : "bytes"))).toEqual(["import-done"]);
  });

  it("gives a command five quiet minutes, started again by every event, unless SLU_ENGINE_TIMEOUT says otherwise", () => {
    const command: EngineRequest = { id: 5, type: "command", extension: "gmic", name: "gmic", words: [], photoIds: ["a", "b"], settings: null };
    expect(timeoutSeconds(env(), command)).toBe(300);
    expect(timesOutWhenQuiet(command)).toBe(true);
    expect(timeoutSeconds(env({ SLU_ENGINE_TIMEOUT: "7" }), command)).toBe(7);
    expect(timesOutWhenQuiet(preview(1))).toBe(false);
  });

  it("times an import out only when the engine goes quiet", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.2" }), output(), child.spawn);
    const run = collect(client.request(importReq(4)));
    await started(child);
    for (let done = 1; done <= 5; done++) {
      await new Promise((r) => setTimeout(r, 50));
      child.send({ id: 4, type: "progress", phase: "files", done, total: 5 });
    }
    child.send({ id: 4, type: "done" });
    expect(await run).toHaveLength(6);
    expect(child.killed).toBe(false);
  });

  describe("importEvents", () => {
    it("gives the import's events, without done", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const run = (async () => {
        const seen: string[] = [];
        for await (const event of importEvents(client, importReq(8))) seen.push(event.type);
        return seen;
      })();
      await started(child);
      child.send({ id: 8, type: "import-plan", workingDir: "/p/.safelight", location: "in-folder", created: false, newFiles: 1 });
      child.send({ id: 8, type: "import-file", relPath: "a.jpg", photoId: "a", state: "ok" });
      child.send({ id: 8, type: "import-done", moved: [], dropped: [], pending: 0, stopped: null });
      child.send({ id: 8, type: "done" });
      expect(await run).toEqual(["import-plan", "import-file", "import-done"]);
    });

    it("turns the engine's locked error into exit 4, naming who holds it", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const run = (async () => { for await (const _ of importEvents(client, importReq(8))) void _; })();
      const settled = run.catch((e: unknown) => e);
      await started(child);
      const heldBy = { app: "safelight" as const, pid: 7, host: "h", since: 1, refreshedAt: 1 };
      child.send({ id: 8, type: "error", code: "locked", message: "held", heldBy });
      expect(await settled).toMatchObject({ code: 4, message: "Safelight has /p open. Close the folder there, or add --wait." });
    });
  });

  describe("thumbFrames", () => {
    it("pairs each photo's frame with its bytes, and passes a photo's failure on", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const run = (async () => {
        const got: unknown[] = [];
        for await (const thumb of thumbFrames(client, thumbsReq(9))) {
          got.push("bytes" in thumb ? { photoId: thumb.photoId, width: thumb.width, bytes: Array.from(thumb.bytes) } : thumb);
        }
        return got;
      })();
      await started(child);
      child.send({ id: 9, type: "frame", frame: 1, width: 2, height: 1, encoding: "rgba", photoId: "a" });
      child.sendFrame(1, [1, 2]);
      child.send({ id: 9, type: "error", code: "decode", message: "no preview", photoId: "b" });
      child.send({ id: 9, type: "done" });
      expect(await run).toEqual([
        { photoId: "a", width: 2, bytes: [1, 2] },
        { photoId: "b", error: "no preview" },
      ]);
    });
  });

  describe("cancelling a request", () => {
    async function ready(child: FakeChild, client: ReturnType<typeof createEngineClient>, signals: { signal?: AbortSignal; force?: AbortSignal }) {
      const run = collect(client.request(preview(5), signals));
      await started(child);
      return { run };
    }

    it("sends cancel for the request and ends on the engine's done", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const abort = new AbortController();
      const { run } = await ready(child, client, { signal: abort.signal });
      abort.abort();
      const cancel = JSON.parse(await child.line(1)) as { type: string; target: number };
      expect(cancel).toMatchObject({ type: "cancel", target: 5 });
      child.send({ id: 5, type: "done" });
      const items = await run;
      expect(items.map((i) => ("type" in i ? i.type : "bytes"))).toEqual(["done"]);
      expect(child.killed).toBe(false);
    });

    it("keeps the events that arrive between cancel and done", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const abort = new AbortController();
      const { run } = await ready(child, client, { signal: abort.signal });
      abort.abort();
      child.send({ id: 5, type: "progress", done: 3, total: 9 });
      child.send({ id: 5, type: "done" });
      const items = await run;
      expect(items.map((i) => ("type" in i ? i.type : "bytes"))).toEqual(["progress", "done"]);
    });

    it("kills the engine when done doesn't come within the grace time", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env({ SLU_ENGINE_CANCEL_GRACE: "0.05" }), output(), child.spawn);
      const abort = new AbortController();
      const { run } = await ready(child, client, { signal: abort.signal });
      const settled = run.catch((e: unknown) => e);
      abort.abort();
      expect(await settled).toMatchObject({ code: 3 });
      expect(child.killed).toBe(true);
    });

    it("kills the engine at once on a second abort", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const abort = new AbortController();
      const force = new AbortController();
      const { run } = await ready(child, client, { signal: abort.signal, force: force.signal });
      const settled = run.catch((e: unknown) => e);
      abort.abort();
      expect(child.killed).toBe(false);
      force.abort();
      expect(await settled).toMatchObject({ code: 3 });
      expect(child.killed).toBe(true);
    });

    it("sends nothing for a request aborted before the engine was ready", async () => {
      const child = new FakeChild();
      const client = createEngineClient(env(), output(), child.spawn);
      const abort = new AbortController();
      const run = collect(client.request(preview(5), { signal: abort.signal }));
      await new Promise((r) => setTimeout(r, 0));
      abort.abort();
      child.send(READY);
      expect(await run).toEqual([]);
      expect(child.written).toEqual([]);
    });

    it("lets a cancelled request end without ending the session's engine", async () => {
      const child = new FakeChild();
      let spawned = 0;
      const session = createEngineSession((out) => createEngineClient(env(), out, (c, a, e) => { spawned++; return child.spawn(c, a, e); }));
      const abort = new AbortController();
      const run = collect(session.client(output()).request(preview(5), { signal: abort.signal }));
      await started(child);
      abort.abort();
      child.send({ id: 5, type: "done" });
      await run;
      expect(child.killed).toBe(false);
      const next = collect(session.client(output()).request(preview(6)));
      expect(JSON.parse(await child.line(2))).toMatchObject({ id: 6 });
      child.send({ id: 6, type: "done" });
      await next;
      expect(spawned).toBe(1);
      expect(child.killed).toBe(false);
      void session.close();
      child.emit("exit", 0);
    });

    it("doesn't rerun a request the user killed", async () => {
      const child = new FakeChild();
      let spawned = 0;
      const session = createEngineSession((out) => createEngineClient(env(), out, (c, a, e) => { spawned++; return child.spawn(c, a, e); }));
      const first = collect(session.client(output()).request(preview(4)));
      await started(child);
      child.send({ id: 4, type: "done" });
      await first;
      const force = new AbortController();
      const run = collect(session.client(output()).request(preview(5), { force: force.signal }));
      const settled = run.catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 0));
      force.abort();
      expect(await settled).toMatchObject({ code: 3 });
      expect(spawned).toBe(1);
    });
  });

  it("shutdown asks the engine to quit", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), child.spawn);
    const run = collect(client.request(preview(1)));
    await started(child);
    child.send({ id: 1, type: "done" });
    await run;
    const down = client.shutdown();
    expect(JSON.parse(await child.line(1))).toMatchObject({ type: "shutdown" });
    child.emit("exit", 0);
    await down;
  });
});
