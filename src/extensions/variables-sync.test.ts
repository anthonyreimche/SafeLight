// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { createVariableRegistry, type VariableMessage, type VariableTransport } from "./variables";

/** A synchronous stand-in for BroadcastChannel: posts reach every other port
 *  as a structured clone, never the poster. hold() queues messages until
 *  release(), to make two windows write "at the same time". */
function createBus() {
  const ports: { handler: ((m: VariableMessage) => void) | null }[] = [];
  let held: { from: object; m: VariableMessage }[] | null = null;
  const send = (from: object, m: VariableMessage) => {
    for (const p of ports) if (p !== from) p.handler?.(structuredClone(m));
  };
  return {
    transport(): VariableTransport {
      const port = { handler: null as ((m: VariableMessage) => void) | null };
      ports.push(port);
      return {
        post: (m) => (held ? held.push({ from: port, m: structuredClone(m) }) : send(port, m)),
        listen: (h) => {
          port.handler = h;
          return () => {
            port.handler = null;
          };
        },
      };
    },
    hold() {
      held = [];
    },
    release() {
      const q = held ?? [];
      held = null;
      for (const { from, m } of q) send(from, m);
    },
  };
}

function windowOn(bus: ReturnType<typeof createBus>, id: string, label: string) {
  const warnings: string[] = [];
  let t = 1000;
  const reg = createVariableRegistry({
    window: { id, label },
    transport: bus.transport(),
    warn: (m) => void warnings.push(m),
    now: () => t++,
  });
  return { reg, warnings };
}

describe("replication", () => {
  it("copies registrations and writes to the other windows and delivers them there", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    const got: number[] = [];
    w2.reg.scoped("ext-b").subscribe<number>("x.v", (s) => void got.push(s.value));
    w1.reg.scoped("ext-a").register("x.v", { initial: 1, description: "d" });
    w1.reg.scoped("ext-a").set("x.v", 2);
    const s = w2.reg.scoped("ext-b").get<number>("x.v");
    expect(s).toMatchObject({ value: 2, revision: { n: 1, window: "w1" }, registeredBy: { extension: "ext-a", window: "w1" }, description: "d" });
    expect(got).toEqual([1, 2]);
  });

  it("accepts a write based on a replicated value without reporting anything", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w1.reg.scoped("ext-a").register("x.v", { initial: { a: 1 } });
    w2.reg.scoped("ext-b").get("x.v");
    expect(w2.reg.scoped("ext-b").set("x.v", { a: 2 })).toMatchObject({ ok: true, revision: { n: 1, window: "w2" } });
    expect(w1.reg.scoped("ext-a").get<{ a: number }>("x.v")?.value).toEqual({ a: 2 });
    expect(Object.isFrozen(w1.reg.scoped("ext-a").get<{ a: number }>("x.v")?.value)).toBe(true);
    expect([...w1.warnings, ...w2.warnings]).toEqual([]);
  });

  it("an extension that didn't see a remote write is refused until it reads it", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w1.reg.scoped("ext-a").register("x.v", { initial: 0 });
    w2.reg.scoped("ext-a").register("x.v", { initial: 0 });
    w1.reg.scoped("ext-a").set("x.v", 1);
    expect(w2.reg.scoped("ext-a").set("x.v", 2)).toMatchObject({ ok: false, reason: "stale" });
    expect(w2.warnings[0]).toBe(
      "[variables] x.v: write by ext-a refused — ext-a in window main changed it (rev 1) since ext-a last saw it (rev 0).",
    );
  });

  it("doesn't report a loss when each window wrote after seeing the other's write", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    const a = w1.reg.scoped("ext-a");
    const b = w2.reg.scoped("ext-b");
    a.register("x.v", { initial: 0 });
    a.set("x.v", 1);
    b.get("x.v");
    b.set("x.v", 2);
    a.get("x.v");
    a.set("x.v", 3);
    b.get("x.v");
    b.set("x.v", 4);
    for (const w of [w1, w2]) {
      expect(w.reg.scoped("ext-z").get("x.v")).toMatchObject({ value: 4, revision: { n: 4, window: "w2" } });
      expect(w.warnings).toEqual([]);
      expect(w.reg.inspect()[0].history.filter((h) => h.outcome === "lost")).toEqual([]);
    }
  });
});

describe("a window opened later", () => {
  it("gets every current value and its history through hello and answer", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w1.reg.scoped("ext-a").register("x.v", { initial: 0 });
    w2.reg.scoped("ext-b").get("x.v");
    w2.reg.scoped("ext-b").set("x.v", 5);
    const w3 = windowOn(bus, "w3", "Developer Tools");
    const [v] = w3.reg.inspect();
    expect(v.snapshot).toMatchObject({ name: "x.v", value: 5, revision: { n: 1, window: "w2" } });
    expect(v.history.map((h) => h.outcome)).toEqual(["accepted", "accepted"]);
    expect(w3.reg.windowName("w2")).toBe("map");
    expect(w3.warnings).toEqual([]);
  });

  it("reports a write it made before the answers arrived that then lost", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const a1 = w1.reg.scoped("ext-a");
    a1.register("x.v", { initial: 0 });
    for (let i = 1; i <= 3; i++) a1.set("x.v", i);
    bus.hold();
    const w3 = windowOn(bus, "w3", "map");
    w3.reg.scoped("ext-c").register("x.v", { initial: 0 });
    w3.reg.scoped("ext-c").set("x.v", 9);
    bus.release();
    expect(w3.reg.scoped("ext-c").get<number>("x.v")?.value).toBe(3);
    expect(w1.reg.scoped("ext-a").get<number>("x.v")?.value).toBe(3);
    expect(w3.warnings).toEqual([
      "[variables] x.v: write by ext-c in this window lost to ext-a in window main writing at the same time.",
    ]);
  });
});

describe("two windows writing at the same time", () => {
  function racing() {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w1.reg.scoped("ext-a").register("x.v", { initial: "start" });
    w2.reg.scoped("ext-b").get("x.v");
    return { bus, w1, w2 };
  }

  it("converge on the higher revision and only the losing window reports", () => {
    const { bus, w1, w2 } = racing();
    bus.hold();
    w1.reg.scoped("ext-a").set("x.v", "one");
    w2.reg.scoped("ext-b").set("x.v", "two");
    bus.release();
    // Both are revision 1; "w2" > "w1" breaks the tie.
    expect(w1.reg.scoped("ext-a").get("x.v")?.value).toBe("two");
    expect(w2.reg.scoped("ext-b").get("x.v")?.value).toBe("two");
    expect(w1.warnings).toEqual([
      "[variables] x.v: write by ext-a in this window lost to ext-b in window map writing at the same time.",
    ]);
    expect(w2.warnings).toEqual([]);
    for (const w of [w1, w2]) {
      const lost = w.reg.inspect()[0].history.filter((h) => h.outcome === "lost");
      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatchObject({ writer: { extension: "ext-a", window: "w1" }, other: { extension: "ext-b", window: "w2" } });
    }
  });

  it("don't report a loss when both wrote the same value", () => {
    const { bus, w1, w2 } = racing();
    bus.hold();
    w1.reg.scoped("ext-a").set("x.v", { cleared: true });
    w2.reg.scoped("ext-b").set("x.v", { cleared: true });
    bus.release();
    expect([...w1.warnings, ...w2.warnings]).toEqual([]);
  });

  it("don't report a lost registration", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    bus.hold();
    w1.reg.scoped("ext-a").register("y.v", { initial: 1 });
    w2.reg.scoped("ext-b").register("y.v", { initial: 2 });
    bus.release();
    for (const w of [w1, w2])
      expect(w.reg.scoped("ext-z").get("y.v")).toMatchObject({ value: 2, registeredBy: { extension: "ext-b", window: "w2" } });
    expect([...w1.warnings, ...w2.warnings]).toEqual([]);
  });
});

describe("outcomes", () => {
  it("a refusal in one window appears in the other window's history but is reported only where it happened", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w1.reg.scoped("ext-a").register("x.v", { initial: 0 });
    w1.reg.scoped("ext-c").set("x.v", 1);
    const h = w2.reg.inspect()[0].history;
    expect(h[h.length - 1]).toMatchObject({ outcome: "stale", writer: { extension: "ext-c", window: "w1" } });
    expect(w1.warnings).toHaveLength(1);
    expect(w2.warnings).toEqual([]);
  });
});

describe("window names", () => {
  it("names other windows by label once heard from, else by the start of their id", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    expect(w1.reg.windowName("zzzz-unknown")).toBe("zzzz");
    windowOn(bus, "w2", "map"); // its hello carries its label
    expect(w1.reg.windowName("w2")).toBe("map");
  });
});

describe("dispose", () => {
  it("stops listening", () => {
    const bus = createBus();
    const w1 = windowOn(bus, "w1", "main");
    const w2 = windowOn(bus, "w2", "map");
    w2.reg.dispose();
    w1.reg.scoped("ext-a").register("x.v", { initial: 1 });
    expect(w2.reg.scoped("ext-b").get("x.v")).toBeUndefined();
  });
});
