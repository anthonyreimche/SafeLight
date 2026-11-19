// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.programs over the privileged bridge: core names the extension asking,
// reads every answer as untrusted, tags each run so its output and its
// cancellation find their way, and the browser build, with no bridge, has no
// program to run.

import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { NativeProgramsBridge } from "./api/native-bridge";

const h = vi.hoisted(() => ({ programs: null as NativeProgramsBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedPrograms: () => h.programs }));

import { programsAPI } from "./programs";

afterEach(() => {
  h.programs = null;
});

type OutputEvent = { runId: unknown; stream: unknown; text: unknown };
type RunMock = Mock<(...args: unknown[]) => Promise<unknown>>;

function bridge(over: Partial<NativeProgramsBridge> = {}) {
  const listeners = new Set<(e: OutputEvent) => void>();
  const unsubscribed = vi.fn();
  const b = {
    pick: vi.fn(async () => ({ token: "t1", path: "/usr/bin/gmic", name: "gmic" })),
    locate: vi.fn(async () => ({ token: "t2", path: "/usr/bin/gmic", name: "gmic" })),
    list: vi.fn(async () => [{ token: "t1", path: "/usr/bin/gmic", name: "gmic" }]),
    forget: vi.fn(async () => {}),
    run: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ exitCode: 0, killed: null, stdout: "out", stderr: "", files: {} })),
    cancel: vi.fn(async () => {}),
    onOutput: vi.fn((cb: (e: OutputEvent) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
        unsubscribed();
      };
    }),
    ...over,
  };
  h.programs = b as unknown as NativeProgramsBridge;
  return { b: b as Omit<typeof b, "run"> & { run: RunMock }, listeners, unsubscribed, emit: (e: OutputEvent) => listeners.forEach((l) => l(e)) };
}

const done = { exitCode: 0, killed: null, stdout: "", stderr: "", files: {} };

describe("api.programs through the desktop bridge", () => {
  it("names the extension on every call", async () => {
    const { b } = bridge();
    const api = programsAPI("gmic");
    await expect(api.pick({ title: "Find G'MIC", replacing: "old" })).resolves.toEqual({ token: "t1", path: "/usr/bin/gmic", name: "gmic" });
    await expect(api.locate("gmic")).resolves.toMatchObject({ token: "t2" });
    await expect(api.list()).resolves.toHaveLength(1);
    await api.forget("t1");
    expect(b.pick).toHaveBeenCalledWith("gmic", { title: "Find G'MIC", replacing: "old" });
    expect(b.locate).toHaveBeenCalledWith("gmic", "gmic");
    expect(b.list).toHaveBeenCalledWith("gmic");
    expect(b.forget).toHaveBeenCalledWith("gmic", "t1");
    await api.pick();
    expect(b.pick).toHaveBeenLastCalledWith("gmic", { title: undefined, replacing: null });
  });

  it("reads what the bridge says as untrusted", async () => {
    bridge({
      pick: vi.fn(async () => ({ token: 4, path: "/x", name: "x" })),
      locate: vi.fn(async () => "yes"),
      list: vi.fn(async () => [{ token: "t", path: "/p", name: "n" }, { token: "u" }, null, 3, { token: "", path: "/p", name: "n" }]),
    });
    const api = programsAPI("gmic");
    await expect(api.pick()).resolves.toBeNull();
    await expect(api.locate("gmic")).resolves.toBeNull();
    await expect(api.list()).resolves.toEqual([{ token: "t", path: "/p", name: "n" }]);
  });

  it("runs a program, sending the arguments, files and limits and nothing else", async () => {
    const { b } = bridge();
    const api = programsAPI("gmic");
    const files = { "in.png": new Uint8Array([1]) };
    const result = await api.run("t1", ["-v", "-1"], { files, outputs: ["out*"], timeoutMs: 5000 });
    expect(result).toEqual({ exitCode: 0, killed: null, stdout: "out", stderr: "", files: {} });
    expect(b.run).toHaveBeenCalledWith("gmic", expect.stringMatching(/^gmic#[0-9a-f-]{36}$/), "t1", ["-v", "-1"], {
      files,
      outputs: ["out*"],
      timeoutMs: 5000,
      stream: false,
    });
  });

  it("gives each run an id no other window's run can share", async () => {
    const { b } = bridge();
    const api = programsAPI("gmic");
    await api.run("t1", []);
    await programsAPI("gmic").run("t1", []);
    const [first, second] = b.run.mock.calls.map((call) => call[1]);
    expect(first).not.toBe(second);
  });

  it("reads a run's answer as untrusted", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { b } = bridge({
      run: vi.fn(async () => ({
        exitCode: "0",
        killed: "evil",
        stdout: 5,
        stderr: "e",
        files: { "a.png": bytes, "b.png": "text", "c.png": new ArrayBuffer(2) },
      })),
    });
    const result = await programsAPI("gmic").run("t", []);
    expect(result).toEqual({ exitCode: null, killed: null, stdout: "", stderr: "e", files: { "a.png": bytes, "c.png": new Uint8Array(2) } });
    b.run.mockResolvedValue("nonsense");
    await expect(programsAPI("gmic").run("t", [])).rejects.toThrow(/can't read/);
  });

  it("refuses arguments that aren't text", async () => {
    const { b } = bridge();
    await expect(programsAPI("gmic").run("t", [1 as unknown as string])).rejects.toThrow(TypeError);
    await expect(programsAPI("gmic").run("t", "-v" as unknown as string[])).rejects.toThrow(TypeError);
    expect(b.run).not.toHaveBeenCalled();
  });

  it("passes a rejection from the main process through", async () => {
    bridge({ run: vi.fn(async () => Promise.reject(new Error("That isn't one this extension kept."))) });
    await expect(programsAPI("gmic").run("t", [])).rejects.toThrow(/isn't one/);
  });
});

describe("a run's output", () => {
  it("reaches onOutput for this run only, in order, and the listener goes when the run ends", async () => {
    let finish: (v: unknown) => void = () => {};
    const { b, emit, listeners, unsubscribed } = bridge({
      run: vi.fn(() => new Promise((resolve) => (finish = resolve))),
    });
    const seen: [string, string][] = [];
    const run = programsAPI("gmic").run("t", [], { onOutput: (stream, text) => void seen.push([stream, text]) });
    const runId = b.run.mock.calls[0][1];
    expect(b.run.mock.calls[0][4]).toMatchObject({ stream: true });
    emit({ runId, stream: "stdout", text: "a" });
    emit({ runId: "someone-else", stream: "stdout", text: "NO" });
    emit({ runId, stream: "stderr", text: "b" });
    emit({ runId, stream: "weird", text: "NO" });
    emit({ runId, stream: "stdout", text: 7 });
    expect(seen).toEqual([["stdout", "a"], ["stderr", "b"]]);
    finish(done);
    await run;
    expect(listeners.size).toBe(0);
    expect(unsubscribed).toHaveBeenCalledTimes(1);
  });

  it("keeps a callback that throws from breaking the run", async () => {
    let finish: (v: unknown) => void = () => {};
    const { b, emit } = bridge({ run: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = programsAPI("gmic").run("t", [], {
      onOutput: () => {
        throw new Error("oops");
      },
    });
    emit({ runId: b.run.mock.calls[0][1], stream: "stdout", text: "a" });
    finish(done);
    await expect(run).resolves.toMatchObject({ exitCode: 0 });
    warn.mockRestore();
  });

  it("shares one bridge listener between runs at once", async () => {
    const finishers: ((v: unknown) => void)[] = [];
    const { b, listeners } = bridge({ run: vi.fn(() => new Promise((resolve) => void finishers.push(resolve))) });
    const api = programsAPI("gmic");
    const a = api.run("t", [], { onOutput: () => {} });
    const c = api.run("t", [], { onOutput: () => {} });
    expect(b.onOutput).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    finishers.forEach((f) => f(done));
    await Promise.all([a, c]);
    expect(listeners.size).toBe(0);
  });
});

describe("cancelling a run", () => {
  it("tells the main process, and resolves with what it says", async () => {
    let finish: (v: unknown) => void = () => {};
    const { b } = bridge({ run: vi.fn(() => new Promise((resolve) => (finish = resolve))) });
    const controller = new AbortController();
    const run = programsAPI("gmic").run("t", [], { signal: controller.signal });
    controller.abort();
    expect(b.cancel).toHaveBeenCalledWith(b.run.mock.calls[0][1]);
    finish({ exitCode: null, killed: "cancelled", stdout: "x", stderr: "", files: {} });
    await expect(run).resolves.toMatchObject({ killed: "cancelled", exitCode: null, stdout: "x" });
  });

  it("doesn't start a run that was already cancelled", async () => {
    const { b } = bridge();
    const result = await programsAPI("gmic").run("t", [], { signal: AbortSignal.abort() });
    expect(result).toEqual({ exitCode: null, killed: "cancelled", stdout: "", stderr: "", files: {} });
    expect(b.run).not.toHaveBeenCalled();
  });

  it("stops listening for the signal once the run ends", async () => {
    bridge();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    await programsAPI("gmic").run("t", [], { signal: controller.signal });
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});

describe("api.programs in the browser build", () => {
  it("has no program to find, and can't run one", async () => {
    const api = programsAPI("gmic");
    await expect(api.pick()).resolves.toBeNull();
    await expect(api.locate("gmic")).resolves.toBeNull();
    await expect(api.list()).resolves.toEqual([]);
    await expect(api.forget("t")).resolves.toBeUndefined();
    await expect(api.run("t", [])).rejects.toMatchObject({ name: "NotSupportedError" });
  });
});
