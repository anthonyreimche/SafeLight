import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { Key } from "./keys";
import { createTerminal } from "./terminal";

function streams(columns = 80) {
  const raw: boolean[] = [];
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode(on: boolean) { raw.push(on); return stdin; },
  }) as unknown as NodeJS.ReadStream & PassThrough;
  const written: string[] = [];
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns }) as unknown as NodeJS.WriteStream & PassThrough;
  stdout.on("data", (c: Buffer) => written.push(c.toString()));
  const flush = () => new Promise((r) => setImmediate(r));
  return { stdin, stdout, raw, out: async () => { await flush(); return written.join(""); }, reset: () => { written.length = 0; } };
}

describe("terminal", () => {
  it("takes raw mode and bracketed paste, and hands decoded keys over", async () => {
    const s = streams();
    const got: Key[][] = [];
    const term = createTerminal(s, { onKeys: (keys) => got.push(keys) });
    term.start();
    expect(s.raw).toEqual([true]);
    s.stdin.write("ab\x1b[D");
    await new Promise((r) => setImmediate(r));
    expect(got).toEqual([[{ kind: "text", text: "ab" }, { kind: "key", name: "left", ctrl: false, alt: false, shift: false }]]);
    expect(await s.out()).toContain("\x1b[?2004h");
    term.stop();
  });

  it("reads a lone escape as the escape key after a short wait", async () => {
    const s = streams();
    const got: Key[][] = [];
    const term = createTerminal(s, { onKeys: (keys) => got.push(keys) });
    term.start();
    s.stdin.write("\x1b");
    await new Promise((r) => setTimeout(r, 60));
    expect(got).toEqual([[{ kind: "key", name: "escape", ctrl: false, alt: false, shift: false }]]);
    term.stop();
  });

  it("paints a frame inside synchronized output and puts the cursor where the frame says", async () => {
    const s = streams();
    const term = createTerminal(s, { onKeys: () => {} });
    term.paint({ rows: ["› set", "  footer"], cursorRow: 0, cursorCol: 5 });
    const first = await s.out();
    expect(first).toBe("\x1b[?2026h\x1b[?25l\r\x1b[J› set\r\n  footer\x1b[1A\r\x1b[5C\x1b[?25h\x1b[?2026l");
    s.reset();
    term.paint({ rows: ["› sets", "  footer"], cursorRow: 0, cursorCol: 6 });
    expect(await s.out()).toMatch(/^\x1b\[\?2026h\x1b\[\?25l\r\x1b\[J› sets/);
  });

  it("goes back up to the area's first row from a cursor on a lower row", async () => {
    const s = streams();
    const term = createTerminal(s, { onKeys: () => {} });
    term.paint({ rows: ["a", "b", "c"], cursorRow: 2, cursorCol: 1 });
    s.reset();
    term.paint({ rows: ["a"], cursorRow: 0, cursorCol: 1 });
    expect(await s.out()).toContain("\x1b[2A\r\x1b[J");
  });

  it("counts rows the terminal wraps, ignoring escape codes", async () => {
    const s = streams(10);
    const term = createTerminal(s, { onKeys: () => {} });
    const long = `\x1b[1m${"x".repeat(25)}\x1b[0m`;
    term.paint({ rows: [long, "footer"], cursorRow: 0, cursorCol: 23 });
    const out = await s.out();
    // Four physical rows; the cursor is on the third (index 2), column 3.
    expect(out).toContain("footer\x1b[1A\r\x1b[3C");
    s.reset();
    term.paint({ rows: ["y"], cursorRow: 0, cursorCol: 1 });
    expect(await s.out()).toContain("\x1b[2A\r\x1b[J");
  });

  it("adds a row when the cursor sits just past a full-width last row", async () => {
    const s = streams(10);
    const term = createTerminal(s, { onKeys: () => {} });
    term.paint({ rows: ["x".repeat(10)], cursorRow: 0, cursorCol: 10 });
    expect(await s.out()).toContain(`${"x".repeat(10)}\r\n\r\x1b[?25h`);
  });

  it("commits rows to scrollback and starts the next frame below them", async () => {
    const s = streams();
    const term = createTerminal(s, { onKeys: () => {} });
    term.paint({ rows: ["› set", "  footer"], cursorRow: 0, cursorCol: 5 });
    s.reset();
    term.commit(["› set"]);
    expect(await s.out()).toBe("\x1b[?2026h\x1b[?25l\r\x1b[J› set\r\n\x1b[?25h\x1b[?2026l");
    s.reset();
    term.paint({ rows: ["› "], cursorRow: 0, cursorCol: 2 });
    expect(await s.out()).not.toContain("\x1b[1A\r\x1b[J›");
  });

  it("puts the terminal back on stop, and on exit while held", async () => {
    const s = streams();
    let onExit: (() => void) | null = null;
    const unsubscribe = vi.fn();
    const term = createTerminal(s, { onKeys: () => {}, onExit: (restore) => { onExit = restore; return unsubscribe; } });
    term.start();
    s.reset();
    (onExit as unknown as () => void)();
    expect(await s.out()).toBe("\x1b[?25h\x1b[?2004l\x1b[0m");
    term.stop();
    expect(s.raw).toEqual([true, false, false]);
    expect(unsubscribe).toHaveBeenCalled();
  });
});
