import { afterEach, describe, expect, it, vi } from "vitest";
import type { EngineEvent, EngineRequest } from "@/engine/protocol";
import { createEngineSession, type EngineClient, type EngineFrame } from "./engine-client";
import type { Output } from "./output/types";
import { CliError } from "./types";

const out = { options: { verbosity: "normal" }, info: () => {} } as unknown as Output;
const req = (id: number): EngineRequest => ({ id, type: "shutdown" });
const DONE = (id: number): EngineEvent => ({ id, type: "done" });

interface Fake extends EngineClient { requests: number; shutdowns: number }

function fakeClient(behave: (n: number) => AsyncIterable<EngineEvent | EngineFrame>): Fake {
  const client: Fake = {
    requests: 0,
    shutdowns: 0,
    request: (r) => { client.requests++; return behave(r.id); },
    shutdown: async () => { client.shutdowns++; },
  };
  return client;
}

async function* done(id: number) { yield DONE(id); }
async function drain(it: AsyncIterable<unknown>) { for await (const _ of it) { /* drain */ } }

afterEach(() => { vi.useRealTimers(); });

describe("engine session", () => {
  it("serves several commands with one engine and ignores a command's own shutdown", async () => {
    const made: Fake[] = [];
    const session = createEngineSession(() => { const c = fakeClient(done); made.push(c); return c; });
    for (let id = 1; id <= 3; id++) {
      const client = session.client(out);
      await drain(client.request(req(id)));
      await client.shutdown();
    }
    expect(made).toHaveLength(1);
    expect(made[0].requests).toBe(3);
    expect(made[0].shutdowns).toBe(0);
    await session.close();
    expect(made[0].shutdowns).toBe(1);
  });

  it("starts a new engine after a request failed", async () => {
    const made: Fake[] = [];
    const session = createEngineSession(() => {
      const first = made.length === 0;
      const c = fakeClient(first ? async function* () { throw new CliError(3, "The engine stopped."); } : done);
      made.push(c);
      return c;
    });
    await expect(drain(session.client(out).request(req(1)))).rejects.toThrow("engine stopped");
    expect(made[0].shutdowns).toBe(1);
    await drain(session.client(out).request(req(2)));
    expect(made).toHaveLength(2);
  });

  it("restarts once, unseen, when the idle engine had died", async () => {
    const made: Fake[] = [];
    const session = createEngineSession(() => {
      const c = fakeClient(made.length === 0 ? done : done);
      made.push(c);
      return c;
    });
    await drain(session.client(out).request(req(1)));
    made[0].request = () => (async function* () { throw new CliError(3, "The engine isn't running."); })();
    await drain(session.client(out).request(req(2)));
    expect(made).toHaveLength(2);
    expect(made[1].requests).toBe(1);
  });

  it("drops an engine whose request was abandoned before it finished", async () => {
    const made: Fake[] = [];
    const session = createEngineSession(() => {
      const c = fakeClient(async function* (id) { yield { id, type: "log", level: "info", message: "x" } as EngineEvent; yield DONE(id); });
      made.push(c);
      return c;
    });
    for await (const _ of session.client(out).request(req(1))) break;
    expect(made[0].shutdowns).toBe(1);
    await drain(session.client(out).request(req(2)));
    expect(made).toHaveLength(2);
  });

  it("closes the engine after the idle time", async () => {
    vi.useFakeTimers();
    const made: Fake[] = [];
    const session = createEngineSession(() => { const c = fakeClient(done); made.push(c); return c; }, 600_000);
    await drain(session.client(out).request(req(1)));
    await vi.advanceTimersByTimeAsync(599_000);
    expect(made[0].shutdowns).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(made[0].shutdowns).toBe(1);
    await drain(session.client(out).request(req(2)));
    expect(made).toHaveLength(2);
  });

  it("does not start an engine just to close", async () => {
    const make = vi.fn();
    await createEngineSession(make).close();
    expect(make).not.toHaveBeenCalled();
  });
});
