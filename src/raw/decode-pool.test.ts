// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Who gets a libraw instance when all of them are busy. The photo the user just
// opened must not queue behind the cache pre-fill, neighbour prefetch or
// thumbnail regeneration that share the pool. libraw itself is faked: an
// instance here is only a token handed round.

import { describe, expect, it, vi } from "vitest";

vi.mock("libraw-wasm", () => ({ default: class {} }));

import { acquireInstance, releaseInstance } from "./decode-pool";
import {
  exhaustPool,
  freshPoolForEachTest,
  settle,
  type Instance,
} from "./decode-pool.test-support";

freshPoolForEachTest();

describe("acquireInstance when every instance is busy", () => {
  it("hands a released instance to a waiting interactive decode before any background one", async () => {
    const held = await exhaustPool();
    const served: string[] = [];
    const request = (label: string, background: boolean): Promise<Instance> =>
      acquireInstance({ background }).then((inst) => {
        served.push(label);
        if (!inst) throw new Error("pool unavailable");
        return inst;
      });

    void request("prefetch 1", true);
    void request("prefetch 2", true);
    const opened = request("opened", false);
    await settle();

    releaseInstance(held[0]);
    await settle();
    expect(served).toEqual(["opened"]);

    releaseInstance(held[1]);
    releaseInstance(await opened);
    await settle();
    expect(served).toEqual(["opened", "prefetch 1", "prefetch 2"]);
  });

  it("serves interactive decodes in the order they asked", async () => {
    const held = await exhaustPool();
    const served: string[] = [];
    const request = (label: string): Promise<unknown> =>
      acquireInstance().then(() => served.push(label));

    void request("first");
    void request("second");
    await settle();

    releaseInstance(held[0]);
    releaseInstance(held[1]);
    await settle();
    expect(served).toEqual(["first", "second"]);
  });

  it("treats an unflagged request as interactive", async () => {
    const held = await exhaustPool();
    const served: string[] = [];

    void acquireInstance({ background: true }).then(() => served.push("prefetch"));
    void acquireInstance().then(() => served.push("opened"));
    await settle();

    releaseInstance(held[0]);
    await settle();
    expect(served).toEqual(["opened"]);
  });
});
