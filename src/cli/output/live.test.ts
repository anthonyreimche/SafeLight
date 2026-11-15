// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EXPOSURE, HIGHLIGHTS, richOptions, sink, taggedLook, untag } from "./fixtures";
import { createOutput, formatHome, settleOutput, showHome } from "./index";
import type { HomeStatus, OutputOptions } from "./index";
import { RESTORE_TERMINAL, createLiveRegion } from "./live";
import { createClock, easeOutCubic, tickFor } from "./motion";
import type { Timers } from "./motion";
import { LOGO_ART } from "./logo/art";
import { bulbRows, homeLayout } from "./surfaces/home";
import { stripMarkup } from "./width";

const HIDE = "\x1b[?25l";
const SHOW = "\x1b[?25h";
const K = "\x1b[K";
const J = "\x1b[J";

describe("createLiveRegion", () => {
  it("draws in place: back to its first line, each line erased to its end", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false });
    region.show(["one", "two"]);
    region.show(["ONE", "TWO"]);
    expect(out.chunks).toEqual([`${HIDE}\rone${K}\ntwo${K}`, `${HIDE}\r\x1b[1AONE${K}\nTWO${K}`]);
  });

  it("erases what a shorter frame leaves behind", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false });
    region.show(["one", "two", "three"]);
    region.show(["only"]);
    expect(out.chunks[1]).toBe(`${HIDE}\r\x1b[2Aonly${K}${J}`);
  });

  it("wraps each frame in synchronized output when the terminal is told to", () => {
    const out = sink(true);
    createLiveRegion(out.stream, { sync: true }).show(["one"]);
    expect(out.text()).toBe(`\x1b[?2026h${HIDE}\rone${K}\x1b[?2026l`);
  });

  it("clears itself, shows the cursor again, and can leave lines behind in scrollback", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false });
    region.show(["one", "two"]);
    region.clear();
    expect(out.chunks[1]).toBe(`\r\x1b[1A${J}${SHOW}`);
    expect(region.showing).toBe(false);
    region.show(["frame"]);
    region.clear(["done", "and dusted"]);
    expect(out.chunks[3]).toBe(`\r${J}done\nand dusted\n${SHOW}`);
    region.clear();
    expect(out.chunks).toHaveLength(4);
  });

  it("lifts out of the way of anything else written to its stream, and comes back under it", () => {
    const out = sink(true);
    const write = out.stream.write;
    const region = createLiveRegion(out.stream, { sync: false });
    region.show(["live"]);
    out.stream.write("a line of output\n");
    expect(out.chunks.slice(1)).toEqual([`\r${J}`, "a line of output\n", `${HIDE}\rlive${K}`]);
    region.clear();
    expect(out.stream.write).toBe(write);
  });

  it("stays down after a write that doesn't end its line, so it never lands mid-line", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false });
    region.show(["live"]);
    out.stream.write("Install it? [y/N] ");
    region.show(["live, a tick later"]);
    expect(out.chunks.slice(1)).toEqual([`\r${J}`, "Install it? [y/N] ", SHOW]);
    out.stream.write("\n");
    region.show(["live again"]);
    expect(out.chunks.slice(4)).toEqual(["\n", `${HIDE}\rlive again${K}`]);
    region.clear();
    expect(out.chunks[6]).toBe(`\r${J}${SHOW}`);
  });

  it("lifts around a write to another stream on the same screen", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false });
    const order: string[] = [];
    region.show(["live"]);
    region.around(() => order.push(`after ${out.chunks.length} chunks`));
    expect(order).toEqual(["after 2 chunks"]);
    expect(out.chunks.slice(1)).toEqual([`\r${J}`, `${HIDE}\rlive${K}`]);
  });

  it("hands an intrusion to its owner, who settles before the write lands", () => {
    const out = sink(true);
    const region = createLiveRegion(out.stream, { sync: false, onIntrusion: () => region.clear(["final"]) });
    region.show(["frame"]);
    out.stream.write("next\n");
    expect(out.chunks.slice(1)).toEqual([`\r${J}final\n${SHOW}`, "next\n"]);
    expect(region.showing).toBe(false);
  });

  it("names what a terminal needs after anything live", () => {
    expect(RESTORE_TERMINAL).toBe("\x1b[?25h\x1b[?2004l\x1b[0m");
  });
});

describe("the clock", () => {
  function fakeTimers() {
    let now = 0;
    const pending: { run: () => void; at: number; hold: boolean }[] = [];
    const timers: Timers = {
      now: () => now,
      set(run, ms, hold) {
        const entry = { run, at: now + ms, hold };
        pending.push(entry);
        return entry;
      },
      clear(handle) {
        const at = pending.indexOf(handle as (typeof pending)[number]);
        if (at >= 0) pending.splice(at, 1);
      },
    };
    const advance = (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const next = pending.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        pending.splice(pending.indexOf(next), 1);
        now = next.at;
        next.run();
      }
      now = until;
    };
    return { timers, advance, pending };
  }

  it("is one timer for every beat, and stops when nothing is animating", () => {
    const { timers, advance, pending } = fakeTimers();
    const clock = createClock(timers);
    const lamp: number[] = [];
    const tween: number[] = [];
    const stopLamp = clock.every(80, (now) => lamp.push(now));
    const stopTween = clock.every(30, (now) => tween.push(now));
    expect(pending).toHaveLength(1);
    advance(100);
    expect(lamp).toEqual([80]);
    expect(tween).toEqual([30, 60, 90]);
    stopTween();
    advance(100);
    expect(lamp).toEqual([80, 160]);
    expect(tween).toHaveLength(3);
    stopLamp();
    expect(pending).toHaveLength(0);
    expect(clock.running).toBe(false);
  });

  it("holds the process open only while a held beat is running", () => {
    const { timers, pending } = fakeTimers();
    const clock = createClock(timers);
    const stopLamp = clock.every(80, () => {});
    expect(pending[0].hold).toBe(false);
    const stopTween = clock.every(30, () => {}, true);
    expect(pending[0].hold).toBe(true);
    stopTween();
    expect(pending[0].hold).toBe(false);
    stopLamp();
  });

  it("eases out, and slows to a redraw a second under reduced motion", () => {
    expect([0, 0.5, 1, 2].map(easeOutCubic)).toEqual([0, 0.875, 1, 1]);
    expect(tickFor(80, { motion: "full", clockScale: 1 })).toBe(80);
    expect(tickFor(80, { motion: "full", clockScale: 2 })).toBe(160);
    expect(tickFor(80, { motion: "reduced", clockScale: 1 })).toBe(1000);
  });
});

function rig(options: OutputOptions, tty = { stdout: true, stderr: true }) {
  const stdout = sink(tty.stdout, options.width);
  const stderr = sink(tty.stderr, options.width);
  const out = createOutput({ stdout: stdout.stream, stderr: stderr.stream }, options);
  /** What a terminal would be left showing on stderr: the last frame, or nothing once cleared. */
  const lastFrame = (): string => stripMarkup(stderr.chunks[stderr.chunks.length - 1] ?? "").replace(/\x1b\[[?0-9;]*[A-Za-z]/g, "").replace(/\r/g, "");
  return { out, stdout, stderr, lastFrame };
}

describe("out.progress and out.working on a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const items = (working: string) => [
    { name: "DSC_0398.NEF", state: "done" as const, ms: 900 },
    { name: "DSC_0401.NEF", state: "done" as const, ms: 800 },
    { name: working, state: "working" as const },
  ];

  it("turns progress with items into the three-line live region, and clears it when the work is done", () => {
    const { out, stderr, lastFrame } = rig(richOptions(96));
    out.progress({ label: "Rendering", done: 2, total: 78, items: items("DSC_0412.NEF") });
    expect(lastFrame()).toBe([
      "  ● DSC_0412.NEF   Rendering…",
      "",
      "  ━───────────────────────────────────────────────   2 of 78 · about 1 min left",
    ].join("\n"));
    out.progress(null);
    expect(stderr.chunks[stderr.chunks.length - 1]).toBe(`\r\x1b[2A${J}${SHOW}`);
    expect(stderr.stream.write).toBe(Object.getPrototypeOf(stderr.stream).write);
  });

  it("keeps finished rows in scrollback above the live region", () => {
    const { out, stdout, stderr } = rig(richOptions(96));
    out.progress({ label: "Rendering", done: 2, total: 78, items: items("DSC_0412.NEF") });
    const before = stderr.chunks.length;
    out.print(out.exported({ path: "DSC_0398.jpg", width: 2048, height: 1365, colourSpace: "sRGB", bytes: 1_468_006 }));
    expect(untag(stdout.text())).toBe("  ✓ DSC_0398.jpg   2048×1365   sRGB   1.4 MB\n");
    // Lifted for the row, then drawn again under it.
    expect(stderr.chunks.slice(before).map((chunk) => chunk.startsWith(`\r\x1b[2A${J}`) || chunk.includes("Rendering"))).toEqual([true, true]);
    out.progress(null);
  });

  it("leaves a piped stdout alone while the region runs on stderr", () => {
    const { out, stdout, stderr } = rig(richOptions(96, { rich: { stdout: false, stderr: true } }), { stdout: false, stderr: true });
    out.progress({ label: "Exporting", done: 1, total: 3 });
    const before = stderr.chunks.length;
    out.print("a.jpg");
    expect(stdout.text()).toBe("a.jpg\n");
    expect(stderr.chunks).toHaveLength(before);
    out.progress(null);
  });

  it("breathes on the clock while it waits, and redraws once a second under reduced motion", () => {
    const moving = rig(richOptions(96, { motion: "full" }));
    moving.out.progress({ label: "Exporting", done: 1, total: 3 });
    const drawn = moving.stderr.chunks.length;
    vi.advanceTimersByTime(400);
    expect(moving.stderr.chunks.length).toBe(drawn + 5);
    moving.out.progress(null);

    const still = rig(richOptions(96, { motion: "reduced" }));
    still.out.progress({ label: "Exporting", done: 1, total: 30 });
    for (let done = 2; done < 12; done++) still.out.progress({ label: "Exporting", done, total: 30 });
    expect(still.stderr.chunks).toHaveLength(1);
    vi.advanceTimersByTime(1000);
    expect(still.stderr.chunks).toHaveLength(2);
    expect(still.lastFrame()).toContain("11 of 30");
    still.out.progress(null);
  });

  it("shows nothing with -q, and the plain line where stderr isn't a terminal look", () => {
    const quiet = rig(richOptions(96, {}, "quiet"));
    quiet.out.progress({ label: "Exporting", done: 1, total: 3 });
    quiet.out.progress(null);
    expect(quiet.stderr.text()).toBe("");

    const plain = rig({ ...richOptions(96), caps: undefined, colour: { stdout: false, stderr: false } });
    plain.out.progress({ label: "Exporting", done: 1, total: 3 });
    expect(plain.stderr.text()).toBe("\rExporting  1/3  ━━━━━━━─────────────");
  });

  it("shows nothing for a wait under 150 ms", async () => {
    const { out, stderr } = rig(richOptions(96));
    const task = new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 100));
    const waiting = out.working("Starting the engine", task);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe("ready");
    expect(stderr.text()).toBe("");
  });

  it("lights the lamp after 150 ms, counts the seconds, and takes it away when the task ends", async () => {
    const { out, stderr, lastFrame } = rig(richOptions(96, { motion: "full" }));
    const task = new Promise<string>((resolve) => setTimeout(() => resolve("ready"), 2200));
    const waiting = out.working("Starting the engine", task);
    await vi.advanceTimersByTimeAsync(149);
    expect(stderr.text()).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(lastFrame()).toBe("  ● Starting the engine…");
    await vi.advanceTimersByTimeAsync(1950);
    expect(lastFrame()).toMatch(/^ {2}● Starting the engine… {2}2\.[01] s$/);
    await vi.advanceTimersByTimeAsync(100);
    expect(await waiting).toBe("ready");
    expect(stderr.chunks[stderr.chunks.length - 1]).toBe(`\r${J}${SHOW}`);
  });

  it("takes the lamp away when the task fails, and passes the failure on", async () => {
    const { out, stderr } = rig(richOptions(96));
    const task = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("no engine")), 500));
    const waiting = out.working("Starting the engine", task);
    const caught = waiting.catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(500);
    expect(await caught).toBe("no engine");
    expect(stderr.chunks[stderr.chunks.length - 1]).toBe(`\r${J}${SHOW}`);
  });

  it("just runs the task where stderr isn't a terminal", async () => {
    const { out, stderr } = rig(richOptions(96, { rich: { stdout: true, stderr: false } }), { stdout: true, stderr: false });
    const waiting = out.working("Starting the engine", new Promise<number>((resolve) => setTimeout(() => resolve(7), 900)));
    await vi.advanceTimersByTimeAsync(900);
    expect(await waiting).toBe(7);
    expect(stderr.text()).toBe("");
  });

  it("writes an error above the lamp, as a card", async () => {
    const { out, stderr } = rig(richOptions(96));
    const waiting = out.working("Starting the engine", new Promise<void>((resolve) => setTimeout(resolve, 900)));
    await vi.advanceTimersByTimeAsync(200);
    out.error({ message: "Stopped." });
    expect(stderr.chunks.slice(-3)).toEqual([`\r${J}`, "  ‹lamp›✕‹/› Stopped.\n", `${HIDE}\r  ‹lamp›●‹/› Starting the engine…${K}`]);
    await vi.advanceTimersByTimeAsync(700);
    await waiting;
  });
});

describe("out.result on a terminal", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const result = {
    photo: "DSC_0412.NEF",
    step: 5,
    changes: [
      { label: "Exposure", value: "+3.00 EV", info: EXPOSURE, before: 0, after: 3 },
      { label: "Highlights", value: "−40", info: HIGHLIGHTS, before: 0, after: -40 },
    ],
  };
  const STATIC = [
    "  DSC_0412.NEF · step 5",
    "    exposure     0.00 → +3.00 EV   ──────────○━━━━━●────",
    "    highlights      0 → −40        ──────●╺━━○──────────",
    "",
  ].join("\n");

  it("prints the block at once when motion is reduced", () => {
    const { out, stdout } = rig(richOptions(96, { motion: "reduced" }));
    out.result(result);
    expect(untag(stdout.text())).toBe(STATIC);
  });

  it("slides the thumbs from old to new in 180 ms, and leaves exactly the static block behind", async () => {
    const { out, stdout } = rig(richOptions(96, { motion: "full" }));
    out.result(result);
    expect(untag(stdout.chunks[0])).toContain("exposure     0.00 → 0.00 EV");
    await vi.advanceTimersByTimeAsync(90);
    const midway = untag(stdout.chunks[stdout.chunks.length - 1]);
    expect(midway).toMatch(/exposure {5}0\.00 → \+2\.\d\d EV/);
    await vi.advanceTimersByTimeAsync(120);
    await settleOutput();
    const last = stdout.chunks[stdout.chunks.length - 1];
    expect(last.endsWith(SHOW)).toBe(true);
    expect(untag(last).slice(untag(last).indexOf("  DSC_0412"), -SHOW.length)).toBe(STATIC);
    const frames = stdout.chunks.length;
    await vi.advanceTimersByTimeAsync(500);
    expect(stdout.chunks).toHaveLength(frames);
  });

  it("jumps to the last frame the instant anything else is written", () => {
    const { out, stdout } = rig(richOptions(96, { motion: "full" }));
    out.result(result);
    out.print("next");
    const text = untag(stdout.chunks.slice(1).join(""));
    expect(text.slice(text.indexOf("  DSC_0412"))).toBe(`${STATIC}${SHOW}  next\n`);
  });

  it("jumps to the last frame when something outside this output writes to the terminal", async () => {
    const { out, stdout } = rig(richOptions(96, { motion: "full" }));
    out.result(result);
    stdout.stream.write("Iceland 2026 › ");
    expect(untag(stdout.chunks[1])).toContain(STATIC);
    expect(stdout.chunks[2]).toBe("Iceland 2026 › ");
    await settleOutput();
  });

  it("doesn't tween a result with nothing to move, or one too narrow for bars", () => {
    const flat = rig(richOptions(96, { motion: "full" }));
    flat.out.result({ photo: "a.NEF", changes: [{ label: "Paste settings", value: "" }], step: 2 });
    expect(untag(flat.stdout.text())).toBe("  a.NEF · step 2\n    Paste settings\n");
    const narrow = rig(richOptions(44, { motion: "full" }));
    narrow.out.result(result);
    expect(narrow.stdout.chunks).toHaveLength(1);
  });

  it("prints the plain line off a terminal, and nothing with -q", () => {
    const piped = rig({ ...richOptions(96), caps: undefined, colour: { stdout: false, stderr: false } }, { stdout: false, stderr: false });
    piped.out.result({ photo: "a.NEF", changes: [{ label: "Exposure", value: "+3.00 EV" }], step: 2 });
    expect(piped.stdout.text()).toBe("a.NEF  Exposure +3.00 EV   (step 2)\n");
    const quiet = rig(richOptions(96, {}, "quiet"));
    quiet.out.result(result);
    expect(quiet.stdout.text()).toBe("");
  });
});

describe("showHome", () => {
  const HOME: HomeStatus = {
    version: "3.3.0",
    cwd: String.raw`D:\Photos\Iceland 2026`,
    project: { root: String.raw`D:\Photos\Iceland 2026`, name: "Iceland 2026", photos: 412, edited: 38 },
    guiHasProjectOpen: false,
    graphics: "d3d11",
    settingsShared: true,
    extensions: { installed: 14, updates: 0 },
  };
  const streams = (rows = 60) => {
    const stdout = sink(true, 96, rows);
    return { stdout, streams: { stdout: stdout.stream, stderr: sink(true, 96).stream } };
  };

  it("writes exactly formatHome when it isn't warming up", async () => {
    for (const [options, warm] of [[richOptions(96, { motion: "full", tier: "256" }), false], [richOptions(96, { motion: "reduced", tier: "256" }), true]] as const) {
      const s = streams();
      await showHome(HOME, s.streams, options, warm);
      expect(s.stdout.text()).toBe(formatHome(HOME, options));
    }
  });

  it("starts from an ember, repaints the bulb eight times, and ends lit", async () => {
    const options = richOptions(96, { motion: "full", tier: "256" });
    const s = streams();
    const started = Date.now();
    await showHome(HOME, s.streams, options, true);
    expect(Date.now() - started).toBeLessThan(600);
    expect(s.stdout.chunks).toHaveLength(9);
    // The ember has none of the lit globe's reds, only the cube's darkest.
    expect(s.stdout.chunks[0]).toContain("38;5;52");
    expect(s.stdout.chunks[0]).not.toMatch(/38;5;(?:196|197|203)[;m]/);
    // Up from under home to the logo's first row, down through its rows, then back.
    const lines = homeLayout(HOME, taggedLook(96, { tier: "256" })).lines.length;
    const up = lines - 1;
    const last = s.stdout.chunks[8];
    expect(last.startsWith(`${HIDE}\x1b[${up}A\r\x1b[3C`)).toBe(true);
    expect(last.endsWith(`\x1b[${up - LOGO_ART.length + 1}B\r${SHOW}`)).toBe(true);
    expect(last).toMatch(/38;5;(?:196|197|203)[;m]/);
    for (const row of bulbRows(taggedLook(96, { tier: "256" }), 1)) expect(last).toContain(`\r\x1b[3C${row}`);
  });

  it("draws the same ASCII logo whatever images the terminal can show", async () => {
    const plain = richOptions(96, { motion: "reduced", tier: "truecolour" });
    const sixel = richOptions(96, { motion: "reduced", tier: "truecolour", graphics: "sixel" });
    expect(formatHome(HOME, sixel)).toBe(formatHome(HOME, plain));
    expect(formatHome(HOME, sixel)).not.toContain("\x1bP");
  });

  it("jumps to lit when a key is pressed", async () => {
    const options = richOptions(96, { motion: "full", tier: "256" });
    const s = streams();
    const skip = new AbortController();
    const shown = showHome(HOME, s.streams, options, true, skip.signal);
    skip.abort();
    await shown;
    expect(s.stdout.chunks).toHaveLength(2);
    for (const row of bulbRows(taggedLook(96, { tier: "256" }), 1)) expect(s.stdout.chunks[1]).toContain(`\r\x1b[3C${row}`);
  });

  it("skips the warm-up when home doesn't fit on screen, where it couldn't climb back to the bulb", async () => {
    const options = richOptions(96, { motion: "full", tier: "256" });
    const s = streams(12);
    await showHome(HOME, s.streams, options, true);
    expect(s.stdout.text()).toBe(formatHome(HOME, options));
  });

  it("writes the plain home off a terminal", async () => {
    const options: OutputOptions = { colour: { stdout: false, stderr: false }, unicode: true, width: 80, verbosity: "normal" };
    const s = streams();
    await showHome(HOME, s.streams, options, true);
    expect(s.stdout.text()).toBe(formatHome(HOME, options));
    expect(s.stdout.text()).not.toContain("\x1b");
  });
});
