import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { encodeWire, WIRE_FRAME, WIRE_JSON, type EngineEvent, type EngineRequest } from "@/engine/protocol";
import { createEngineClient, type EngineChild, type EngineFrame, type EngineSpawn } from "./engine-client";
import type { Output } from "./output/types";
import { CliError, type CliEnv } from "./types";

class FakeChild extends EventEmitter implements EngineChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly written: string[] = [];
  killed = false;
  readonly stdin = {
    write: (chunk: string) => { this.written.push(chunk); },
    end: () => {},
  };
  kill() { this.killed = true; this.emit("exit", null); }
  send(event: EngineEvent) { this.stdout.write(encodeWire(WIRE_JSON, new TextEncoder().encode(JSON.stringify(event)))); }
  sendFrame(frame: number, bytes: number[]) {
    const payload = new Uint8Array(4 + bytes.length);
    new DataView(payload.buffer).setUint32(0, frame, true);
    payload.set(bytes, 4);
    this.stdout.write(encodeWire(WIRE_FRAME, payload));
  }
}

const READY: EngineEvent = { id: 0, type: "ready", protocol: 1, appVersion: "3.3.0", backend: "d3d11", software: false, extensions: [] };

function env(extra: Record<string, string> = {}): CliEnv {
  return {
    cwd: "/w", userData: "/u", appRoot: "/app", appVersion: "3.3.0", platform: "linux",
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

describe("engine client", () => {
  it("spawns Electron proper: ELECTRON_RUN_AS_NODE removed, engine flags passed", async () => {
    const child = new FakeChild();
    const calls: Array<{ command: string; args: string[]; env: Record<string, string> }> = [];
    const spawnFn: EngineSpawn = (command, args, e) => { calls.push({ command, args, env: e }); return child; };
    const client = createEngineClient(env(), output(), spawnFn);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send(READY);
    await new Promise((r) => setTimeout(r, 0));
    child.send({ id: 1, type: "done" });
    await run;
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe(process.execPath);
    expect(calls[0].args).toEqual(["/app", "--engine", "--slu-protocol=1"]);
    expect("ELECTRON_RUN_AS_NODE" in calls[0].env).toBe(false);
    expect(calls[0].env.PATH).toBe("/bin");
  });

  it("sends the request as a JSON line and returns events and frames until done", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), () => child);
    const run = collect(client.request(preview(7)));
    await new Promise((r) => setTimeout(r, 0));
    child.send(READY);
    await new Promise((r) => setTimeout(r, 0));
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
    const client = createEngineClient(env(), output(infos), () => child);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send({ id: 0, type: "log", level: "info", message: "warming up" });
    child.send(READY);
    await new Promise((r) => setTimeout(r, 0));
    child.send({ id: 1, type: "done" });
    await run;
    expect(infos).toContain("engine: warming up");
  });

  it("gives exit 3 when the engine can't start", async () => {
    const client = createEngineClient(env(), output(), () => { throw new Error("spawn ENOENT"); });
    await expect(collect(client.request(preview(1)))).rejects.toMatchObject({ code: 3 });
  });

  it("gives exit 3 when the engine dies before it is ready", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), () => child);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.stderr.write("GPU process crashed\n");
    child.emit("exit", 1);
    const error = await run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("GPU process crashed") });
  });

  it("gives up on an engine that never says ready, with exit 3, and stops it", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.05" }), output(), () => child);
    const error = await collect(client.request(preview(1))).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 3, message: expect.stringContaining("didn't start") });
    expect(child.killed).toBe(true);
  });

  it("refuses an engine that speaks another protocol", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), () => child);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send({ ...READY, protocol: 9 } as EngineEvent);
    await expect(run).rejects.toMatchObject({ code: 3 });
  });

  it("times out a silent engine with exit 3 and stops it", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env({ SLU_ENGINE_TIMEOUT: "0.05" }), output(), () => child);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send(READY);
    await expect(run).rejects.toMatchObject({ code: 3, message: expect.stringContaining("didn't answer") });
    expect(child.killed).toBe(true);
  });

  it("keeps an export going after one photo fails, and ends on a fatal error", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), () => child);
    const req: EngineRequest = {
      id: 2, type: "export", project: { root: "/p", workingDir: "/p/.safelight", location: "in-folder" },
      photoIds: ["a", "b"], settings: {}, target: { kind: "dir", dir: "/o" },
    };
    const run = collect(client.request(req));
    await new Promise((r) => setTimeout(r, 0));
    child.send(READY);
    await new Promise((r) => setTimeout(r, 0));
    child.send({ id: 2, type: "error", code: "decode", message: "bad", photoId: "a" });
    child.send({ id: 2, type: "error", code: "internal", message: "gone" });
    const items = await run;
    expect(items).toHaveLength(2);
  });

  it("shutdown asks the engine to quit", async () => {
    const child = new FakeChild();
    const client = createEngineClient(env(), output(), () => child);
    const run = collect(client.request(preview(1)));
    await new Promise((r) => setTimeout(r, 0));
    child.send(READY);
    await new Promise((r) => setTimeout(r, 0));
    child.send({ id: 1, type: "done" });
    await run;
    const down = client.shutdown();
    expect(JSON.parse(child.written.at(-1) ?? "")).toMatchObject({ type: "shutdown" });
    child.emit("exit", 0);
    await down;
  });
});
