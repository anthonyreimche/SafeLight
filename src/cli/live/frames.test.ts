// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { createLatestWins } from "./frames";

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

describe("latest-wins rendering", () => {
  it("renders a burst once at the end, never two at a time, and drops the asks a newer one replaced", async () => {
    const queue = createLatestWins<string>();
    const first = gate();
    const rendered: string[] = [];
    let inFlight = 0;
    let most = 0;
    const render = (key: string, wait?: Promise<void>) => async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await wait;
      rendered.push(key);
      inFlight--;
      return `frame ${key}`;
    };

    const a = queue.ask("a", render("a", first.opened));
    const burst = ["b", "c", "d", "e"].map((key) => queue.ask(key, render(key)));
    first.open();

    expect(await a).toBe("frame a");
    expect(await Promise.all(burst)).toEqual([null, null, null, "frame e"]);
    expect(rendered).toEqual(["a", "e"]);
    expect(most).toBe(1);
  });

  it("shares one render among asks for the same thing, and answers a repeat of the last from what it kept", async () => {
    const queue = createLatestWins<number>();
    let renders = 0;
    const render = async () => ++renders;

    const same = await Promise.all([queue.ask("k", render), queue.ask("k", render), queue.ask("k", render)]);
    expect(same).toEqual([1, 1, 1]);
    expect(await queue.ask("k", render)).toBe(1);
    expect(await queue.ask("other", render)).toBe(2);
    expect(renders).toBe(2);
  });

  it("fails the asks of a render that failed and goes on to the next", async () => {
    const queue = createLatestWins<string>();
    const first = gate();
    const failing = queue.ask("a", async () => {
      await first.opened;
      throw new Error("engine stopped");
    });
    const next = queue.ask("b", async () => "frame b");
    first.open();

    await expect(failing).rejects.toThrow("engine stopped");
    expect(await next).toBe("frame b");
  });
});
