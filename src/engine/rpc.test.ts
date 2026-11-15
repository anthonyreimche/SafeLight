// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import type { EngineEvent, EngineRequest } from "./protocol";
import { EngineFailure, serveEngine, type EngineChannel, type EngineHandlers, type PortMessage } from "./rpc";

function fakeChannel() {
  const sent: PortMessage[] = [];
  let handler: ((data: unknown) => void) | null = null;
  const channel: EngineChannel = {
    send: (message) => sent.push(message),
    listen: (h) => {
      handler = h;
    },
  };
  return {
    channel,
    sent,
    deliver: (data: unknown) => handler?.(data),
    events: () => sent.filter((m): m is EngineEvent => "type" in m),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const PROJECT = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" as const };
const preview = (id: number): EngineRequest => ({
  id,
  type: "preview",
  project: PROJECT,
  photoId: `photo-${id}`,
  width: 10,
  height: 10,
  encoding: "rgba",
});

function handlers(over: Partial<EngineHandlers> = {}): EngineHandlers {
  return {
    export: async () => {},
    preview: async () => {},
    shutdown: async () => {},
    ...over,
  };
}

describe("serveEngine", () => {
  it("answers one request at a time, in the order they came", async () => {
    const order: string[] = [];
    let release = () => {};
    const first = new Promise<void>((resolve) => (release = resolve));
    const port = fakeChannel();
    serveEngine(port.channel, handlers({
      preview: async (req) => {
        order.push(`start ${req.id}`);
        if (req.id === 1) await first;
        order.push(`end ${req.id}`);
      },
    }));
    port.deliver(preview(1));
    port.deliver(JSON.stringify(preview(2)));
    await settle();
    expect(order).toEqual(["start 1"]);
    release();
    await settle();
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(port.events().map((e) => [e.id, e.type])).toEqual([[1, "done"], [2, "done"]]);
  });

  it("sends a frame's event before its bytes, numbered in turn", async () => {
    const port = fakeChannel();
    serveEngine(port.channel, handlers({
      preview: async (req, out) => {
        out.frame(new Uint8Array([1, 2]), (frame) => ({ id: req.id, type: "frame", frame, width: 1, height: 1, encoding: "rgba" }));
        out.frame(new Uint8Array([3]), (frame) => ({ id: req.id, type: "frame", frame, width: 1, height: 1, encoding: "rgba" }));
      },
    }));
    port.deliver(preview(4));
    await settle();
    expect(port.sent).toEqual([
      { id: 4, type: "frame", frame: 1, width: 1, height: 1, encoding: "rgba" },
      { frame: 1, bytes: new Uint8Array([1, 2]) },
      { id: 4, type: "frame", frame: 2, width: 1, height: 1, encoding: "rgba" },
      { frame: 2, bytes: new Uint8Array([3]) },
      { id: 4, type: "done" },
    ]);
  });

  it("turns a failed request into an error event with its code, and no done", async () => {
    const port = fakeChannel();
    serveEngine(port.channel, handlers({
      preview: async (req) => {
        if (req.id === 1) throw new EngineFailure("decode", "Can't read this file.");
        throw new Error("boom");
      },
    }));
    port.deliver(preview(1));
    port.deliver(preview(2));
    await settle();
    expect(port.events()).toEqual([
      { id: 1, type: "error", code: "decode", message: "Can't read this file." },
      { id: 2, type: "error", code: "internal", message: "boom" },
    ]);
  });

  it("sends done after the per-photo errors a request carries on through", async () => {
    const port = fakeChannel();
    serveEngine(port.channel, handlers({
      export: async (req, out) => {
        out.emit({ id: req.id, type: "error", code: "decode", message: "nope", photoId: "a" });
      },
    }));
    port.deliver({ id: 3, type: "export", project: PROJECT, photoIds: ["a"], settings: {}, target: { kind: "stdout" } });
    await settle();
    expect(port.events()).toEqual([
      { id: 3, type: "error", code: "decode", message: "nope", photoId: "a" },
      { id: 3, type: "done" },
    ]);
  });

  it("shuts down after the requests before it, answers it, and takes no more", async () => {
    const order: string[] = [];
    const port = fakeChannel();
    serveEngine(port.channel, handlers({
      preview: async (req) => {
        order.push(`preview ${req.id}`);
      },
      shutdown: async () => {
        order.push("shutdown");
      },
    }));
    port.deliver(preview(1));
    port.deliver({ id: 2, type: "shutdown" });
    port.deliver(preview(3));
    await settle();
    expect(order).toEqual(["preview 1", "shutdown"]);
    expect(port.events().map((e) => [e.id, e.type])).toEqual([[1, "done"], [2, "done"]]);
  });

  it("logs a message that isn't a request instead of failing", async () => {
    const port = fakeChannel();
    serveEngine(port.channel, handlers());
    port.deliver("{not json");
    port.deliver({ id: 1, type: "dance" });
    await settle();
    const events = port.events();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "log" && e.level === "warn" && e.id === 0)).toBe(true);
  });
});
