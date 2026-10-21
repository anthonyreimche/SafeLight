// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  HISTORY_LIMIT,
  createVariableRegistry,
  type RegistryOptions,
  type VariableMessage,
} from "./variables";
import type { VariableWriteResult } from "./types";

function setup(opts: Partial<RegistryOptions> = {}) {
  const warnings: string[] = [];
  const posted: VariableMessage[] = [];
  let t = 1000;
  const reg = createVariableRegistry({
    window: { id: "w1", label: "main" },
    transport: { post: (m) => void posted.push(m), listen: () => () => {} },
    warn: (m) => void warnings.push(m),
    now: () => t++,
    ...opts,
  });
  return { reg, warnings, posted, a: reg.scoped("ext-a"), b: reg.scoped("ext-b"), c: reg.scoped("ext-c") };
}

describe("register", () => {
  it("creates the variable at revision 0 with its registrant as writer", () => {
    const { a } = setup();
    const s = a.register("x.v", { initial: { n: 1 }, description: "A test value" });
    expect(s).toEqual({
      name: "x.v",
      value: { n: 1 },
      revision: { n: 0, window: "w1" },
      writer: { extension: "ext-a", window: "w1" },
      registeredBy: { extension: "ext-a", window: "w1" },
      description: "A test value",
    });
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.value)).toBe(true);
  });

  it("is idempotent: the first initial and description win", () => {
    const { a, b } = setup();
    a.register("x.v", { initial: 1, description: "first" });
    const s = b.register("x.v", { initial: 2, description: "second" });
    expect(s.value).toBe(1);
    expect(s.description).toBe("first");
    expect(s.registeredBy.extension).toBe("ext-a");
  });

  it("throws on invalid or reserved names and on non-JSON initial values", () => {
    const { a } = setup();
    expect(() => a.register("Bad Name", { initial: 1 })).toThrow('[variables] invalid variable name "Bad Name"');
    expect(() => a.register("core.x", { initial: 1 })).toThrow("reserved for core");
    expect(() => a.register("x.v", { initial: NaN })).toThrow("[variables] x.v: initial: NaN");
  });

  it("throws on a description that isn't a string, and stores nothing", () => {
    const { a } = setup();
    expect(() => a.register("x.v", { initial: 1, description: (() => "x") as unknown as string })).toThrow(
      "[variables] x.v: description must be a string",
    );
    expect(a.get("x.v")).toBeUndefined();
  });
});

describe("get and subscribe", () => {
  it("get returns undefined for an unregistered name", () => {
    const { a } = setup();
    expect(a.get("x.v")).toBeUndefined();
  });

  it("a subscriber added before registration hears it; one added after hears the current value at once", () => {
    const { a, b, c } = setup();
    const early: number[] = [];
    const late: number[] = [];
    b.subscribe<number>("x.v", (s) => void early.push(s.value));
    expect(early).toEqual([]);
    a.register("x.v", { initial: 5 });
    expect(early).toEqual([5]);
    c.subscribe<number>("x.v", (s) => void late.push(s.value));
    expect(late).toEqual([5]);
  });

  it("unsubscribing stops deliveries", () => {
    const { a, b } = setup();
    const got: number[] = [];
    a.register("x.v", { initial: 0 });
    const off = b.subscribe<number>("x.v", (s) => void got.push(s.value));
    off();
    a.set("x.v", 1);
    expect(got).toEqual([0]);
  });

  it("a throwing listener is logged with its extension and the others still run", () => {
    const { a, b, c, warnings } = setup();
    const got: number[] = [];
    a.register("x.v", { initial: 0 });
    b.subscribe("x.v", () => {
      throw new Error("boom");
    });
    c.subscribe<number>("x.v", (s) => void got.push(s.value));
    a.set("x.v", 1);
    expect(got).toEqual([0, 1]);
    expect(warnings).toContain("[variables] x.v: a subscriber of ext-b threw: boom");
  });
});

describe("the write rule", () => {
  it("accepts a set from an extension that saw the current revision through register, get or a delivery", () => {
    const { a, b, c } = setup();
    a.register("x.v", { initial: 0 });
    expect(a.set("x.v", 1)).toEqual({ ok: true, revision: { n: 1, window: "w1" } });
    b.get("x.v");
    expect(b.set("x.v", 2)).toMatchObject({ ok: true });
    c.subscribe("x.v", () => {});
    expect(c.set("x.v", 3)).toMatchObject({ ok: true });
    expect(a.get<number>("x.v")?.value).toBe(3);
  });

  it("refuses a stale set, returns the current snapshot and reports both writers", () => {
    const { a, b, warnings } = setup();
    a.register("x.v", { initial: 0 });
    b.register("x.v", { initial: 0 });
    a.set("x.v", 1);
    const r = b.set("x.v", 2);
    expect(r).toMatchObject({ ok: false, reason: "stale" });
    if (r.ok || r.reason !== "stale") throw new Error("expected stale");
    expect(r.current.value).toBe(1);
    expect(a.get<number>("x.v")?.value).toBe(1);
    expect(warnings).toEqual(["[variables] x.v: write by ext-b refused — ext-a changed it (rev 1) since ext-b last saw it (rev 0)."]);
  });

  it("refuses a set from an extension that never read the variable", () => {
    const { a, c, warnings } = setup();
    a.register("x.v", { initial: 0 });
    expect(c.set("x.v", 1)).toMatchObject({ ok: false, reason: "stale" });
    expect(warnings).toEqual(["[variables] x.v: write by ext-c refused — ext-a changed it (rev 0) and ext-c hasn't read it yet."]);
  });

  it("update applies to the latest value even when the extension hadn't seen it", () => {
    const { a, b } = setup();
    a.register("x.v", { initial: { list: [1] } });
    b.register("x.v", { initial: { list: [] } });
    a.set("x.v", { list: [1, 2] });
    const r = b.update<{ list: number[] }>("x.v", (cur) => {
      expect(Object.isFrozen(cur)).toBe(true);
      return { list: [...cur.list, 3] };
    });
    expect(r).toEqual({ ok: true, revision: { n: 2, window: "w1" } });
    expect(a.get<{ list: number[] }>("x.v")?.value.list).toEqual([1, 2, 3]);
  });

  it("update writes nothing when fn throws or returns a Promise", () => {
    const { a, warnings } = setup();
    a.register("x.v", { initial: 0 });
    expect(
      a.update("x.v", () => {
        throw new Error("nope");
      }),
    ).toEqual({ ok: false, reason: "invalid", message: "update function threw: nope" });
    expect(a.update("x.v", () => Promise.resolve(1) as unknown as number)).toEqual({
      ok: false,
      reason: "invalid",
      message: "update function returned a Promise; it must return the new value",
    });
    expect(a.get<number>("x.v")?.revision.n).toBe(0);
    expect(warnings).toHaveLength(2);
  });

  it("update refuses when its function wrote the same variable", () => {
    const { reg, a, posted } = setup();
    a.register("x.v", { initial: 0 });
    const r = a.update<number>("x.v", (cur) => {
      a.set("x.v", 100);
      return cur + 1;
    });
    expect(r).toEqual({ ok: false, reason: "invalid", message: "update function wrote x.v while it ran" });
    const s = a.get<number>("x.v");
    expect(s?.value).toBe(100);
    expect(s?.revision.n).toBe(1);
    const h = reg.inspect()[0].history;
    expect(h[h.length - 1]).toMatchObject({ outcome: "invalid", revision: { n: 1 } });
    const writeRevisions = posted.flatMap((m) => (m.type === "write" ? [m.revision.n] : []));
    expect(new Set(writeRevisions).size).toBe(writeRevisions.length);
  });

  it("refuses values that aren't JSON data, naming the path", () => {
    const { a, warnings } = setup();
    a.register("x.v", { initial: 0 });
    expect(a.set("x.v", { t: NaN })).toEqual({ ok: false, reason: "invalid", message: "value.t: NaN" });
    expect(warnings).toEqual(["[variables] x.v: write by ext-a refused — value.t: NaN."]);
  });

  it("refuses writes to an unregistered name", () => {
    const { a, warnings } = setup();
    expect(a.set("map.overlay", 1)).toEqual({ ok: false, reason: "unregistered" });
    expect(a.update("map.overlay", (v) => v)).toEqual({ ok: false, reason: "unregistered" });
    expect(warnings[0]).toBe('[variables] write by ext-a to unregistered "map.overlay" refused.');
  });

  it("stores a frozen copy, so the writer can't change it afterwards", () => {
    const { a } = setup();
    a.register("x.v", { initial: {} });
    const mine = { list: [1] };
    a.set("x.v", mine);
    mine.list.push(2);
    const s = a.get<{ list: number[] }>("x.v");
    expect(s?.value.list).toEqual([1]);
    expect(Object.isFrozen(s?.value.list)).toBe(true);
  });
});

describe("delivery order", () => {
  it("queues writes made during a delivery, so every subscriber sees every revision in order", () => {
    const { a, b, c } = setup();
    a.register("x.v", { initial: 0 });
    const byB: number[] = [];
    const byC: number[] = [];
    const results: VariableWriteResult<number>[] = [];
    b.subscribe<number>("x.v", (s) => {
      byB.push(s.value);
      if (s.value === 1) results.push(b.set("x.v", 2));
    });
    c.subscribe<number>("x.v", (s) => {
      byC.push(s.value);
      // c is handed revision 1 while revision 2 is already queued, so it hasn't seen the current value.
      if (s.value === 1) results.push(c.set("x.v", 99));
    });
    expect(a.set("x.v", 1).ok).toBe(true);
    expect(byB).toEqual([0, 1, 2]);
    expect(byC).toEqual([0, 1, 2]);
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toMatchObject({ reason: "stale" });
  });

  it("an extension that already wrote a newer revision is not refused when an older delivery reaches its other subscription", () => {
    const { a, b, warnings } = setup();
    a.register("x.v", { initial: 0 });
    const results: VariableWriteResult<number>[] = [];
    b.subscribe<number>("x.v", (s) => {
      if (s.value === 1) results.push(b.set("x.v", 2));
    });
    b.subscribe<number>("x.v", (s) => {
      if (s.value === 1) results.push(b.set("x.v", 3));
    });
    a.set("x.v", 1);
    expect(a.get<number>("x.v")?.value).toBe(3);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(warnings).toEqual([]);
  });
});

describe("dropExtension", () => {
  it("removes the extension's subscriptions and what it has seen; values stay", () => {
    const { reg, a, b } = setup();
    const got: number[] = [];
    a.register("x.v", { initial: 0 });
    b.subscribe<number>("x.v", (s) => void got.push(s.value));
    reg.dropExtension("ext-b");
    a.set("x.v", 1);
    expect(got).toEqual([0]);
    expect(b.set("x.v", 2)).toMatchObject({ ok: false, reason: "stale" });
    expect(a.get<number>("x.v")?.value).toBe(1);
  });
});

describe("history and reports", () => {
  it("records accepted, stale and invalid writes without values, newest last", () => {
    const { reg, a, c } = setup();
    a.register("x.v", { initial: 0 });
    a.set("x.v", 1);
    c.set("x.v", 2);
    a.set("x.v", { bad: undefined, t: Infinity });
    const h = reg.inspect()[0].history;
    expect(h.map((i) => i.outcome)).toEqual(["accepted", "accepted", "stale", "invalid"]);
    expect(h[2]).toMatchObject({ writer: { extension: "ext-c" }, revision: { n: 1 }, other: { extension: "ext-a" } });
    expect(h[3]).toMatchObject({ message: "value.t: Infinity" });
    expect(h.some((i) => "value" in i)).toBe(false);
  });

  it(`keeps the last ${HISTORY_LIMIT} items`, () => {
    const { reg, a } = setup();
    a.register("x.v", { initial: 0 });
    for (let i = 1; i <= 60; i++) a.set("x.v", i);
    const h = reg.inspect()[0].history;
    expect(h).toHaveLength(HISTORY_LIMIT);
    expect(h[h.length - 1].revision.n).toBe(60);
  });

  it("reports a write over 8 MB once per variable", () => {
    const { a, warnings } = setup();
    a.register("x.big", { initial: "" });
    const big = "x".repeat(4_200_001); // 8,400,002 bytes estimated
    a.set("x.big", big);
    a.set("x.big", big + "y");
    expect(warnings).toEqual(["[variables] x.big: 8.0 MB written by ext-a — values this large are copied to every window."]);
  });
});

describe("transport posts", () => {
  it("posts registrations and writes with what they replaced, and refusals without values", () => {
    const { a, b, posted } = setup();
    a.register("x.v", { initial: 0 });
    a.set("x.v", 1);
    b.register("x.v", { initial: 0 });
    a.set("x.v", 2);
    b.set("x.v", 3); // stale
    expect(posted.map((m) => m.type)).toEqual(["hello", "write", "write", "write", "outcome"]);
    expect(posted[1]).toMatchObject({ type: "write", revision: { n: 0 }, basedOn: null, value: 0 });
    expect(posted[2]).toMatchObject({ type: "write", revision: { n: 1 }, basedOn: { n: 0, window: "w1" }, value: 1 });
    expect(posted[4]).toMatchObject({ type: "outcome", name: "x.v", item: { outcome: "stale" } });
    expect("value" in (posted[4] as { item: object }).item).toBe(false);
  });
});

describe("inspection", () => {
  it("lists variables by name with their subscribers here, and counts changes", () => {
    const { reg, a, b } = setup();
    let notified = 0;
    reg.subscribeChanges(() => void notified++);
    a.register("z.last", { initial: 1 });
    a.register("a.first", { initial: "s" });
    b.subscribe("a.first", () => {});
    const list = reg.inspect();
    expect(list.map((v) => v.snapshot.name)).toEqual(["a.first", "z.last"]);
    expect(list[0].subscribers).toEqual(["ext-b"]);
    expect(list[0].size).toBe(2);
    expect(notified).toBeGreaterThanOrEqual(3);
    expect(reg.changeCount()).toBe(notified);
    expect(reg.windowName("w1")).toBe("this window");
  });
});
