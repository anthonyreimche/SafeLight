// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseBackgroundReply, probeTheme, probedSixel, probedTheme, rememberSixel, rememberTheme, resolveCapabilities } from "./capabilities";
import type { ProbeInput } from "./capabilities";
import { glyphSet } from "./glyphs";
import { createTheme } from "./theme";
import { cells, clip, clipStart, joinHorizontal, stripMarkup } from "./width";

const ESC = "\x1b[";

describe("createTheme", () => {
  it("leaves body text to the terminal in every tier", () => {
    for (const tier of ["truecolour", "256", "16", "mono", "tagged"] as const) {
      expect(createTheme({ tier, name: "dark" }).paint("text", "body")).toBe("body");
    }
  });

  it("writes 24-bit colour by background where it is known", () => {
    expect(createTheme({ tier: "truecolour", name: "dark" }).paint("amber", "x")).toBe(`${ESC}38;2;245;165;36mx${ESC}39m`);
    expect(createTheme({ tier: "truecolour", name: "light" }).paint("amber", "x")).toBe(`${ESC}38;2;168;90;0mx${ESC}39m`);
    expect(createTheme({ tier: "truecolour", name: "dark" }).paint("muted", "x")).toBe(`${ESC}38;2;168;159;152mx${ESC}39m`);
  });

  it("uses mid-tones that read on black and white when the background isn't known", () => {
    const theme = createTheme({ tier: "truecolour", name: "unknown" });
    expect(theme.paint("amber", "x")).toBe(`${ESC}38;5;166mx${ESC}39m`);
    expect(theme.paint("muted", "x")).toBe(`${ESC}2mx${ESC}22m`);
    expect(theme.paint("amberDim", "x")).toBe(`${ESC}2;38;5;166mx${ESC}22;39m`);
  });

  it("keeps the bulb the logo's red on any background", () => {
    for (const name of ["dark", "light", "unknown"] as const) {
      expect(createTheme({ tier: "truecolour", name }).paint("bulb", "x")).toBe(`${ESC}38;2;243;34;63mx${ESC}39m`);
    }
  });

  it("steps down to 256 and 16 colours", () => {
    expect(createTheme({ tier: "256", name: "dark" }).paint("lamp", "x")).toBe(`${ESC}38;5;197mx${ESC}39m`);
    expect(createTheme({ tier: "256", name: "light" }).paint("lamp", "x")).toBe(`${ESC}38;5;161mx${ESC}39m`);
    expect(createTheme({ tier: "16", name: "dark" }).paint("lamp", "x")).toBe(`${ESC}31mx${ESC}39m`);
    expect(createTheme({ tier: "16", name: "dark" }).paint("faint", "x")).toBe(`${ESC}2mx${ESC}22m`);
  });

  it("keeps weight, underline and reverse under NO_COLOR, and drops every colour", () => {
    const mono = createTheme({ tier: "mono", name: "dark" });
    expect(mono.paint("strong", "x")).toBe(`${ESC}1mx${ESC}22m`);
    expect(mono.paint("path", "x")).toBe(`${ESC}4mx${ESC}24m`);
    expect(mono.paint("invalid", "x")).toBe(`${ESC}4mx${ESC}24m`);
    expect(mono.paint("pill.lamp", " banned ")).toBe(`${ESC}1;7m banned ${ESC}22;27m`);
    expect(mono.paint("amber", "x")).toBe("x");
    expect(mono.paint("lamp", "x")).toBe("x");
    expect(mono.blend("ember", "lamp", 0.5, "x")).toBe("x");
  });

  it("draws an invalid token with a curly underline only where the terminal has one", () => {
    expect(createTheme({ tier: "truecolour", name: "dark", curly: true }).paint("invalid", "x"))
      .toBe(`${ESC}38;2;243;34;63;4:3;58:2::243:34:63mx${ESC}39;24;59m`);
    expect(createTheme({ tier: "truecolour", name: "dark" }).paint("invalid", "x")).toBe(`${ESC}38;2;243;34;63mx${ESC}39m`);
  });

  it("fills a pill with the token's colour", () => {
    expect(createTheme({ tier: "truecolour", name: "dark" }).paint("pill.lamp", " banned "))
      .toBe(`${ESC}1;48;2;243;34;63;38;2;255;255;255m banned ${ESC}22;49;39m`);
    expect(createTheme({ tier: "16", name: "dark" }).paint("pill.amber", " read only ")).toBe(`${ESC}1;43;30m read only ${ESC}22;49;39m`);
  });

  it("blends smoothly in 24-bit, in three steps in 256, and flat below", () => {
    const full = createTheme({ tier: "truecolour", name: "dark" });
    expect(full.blend("ember", "lamp", 0, "x")).toBe(full.paint("ember", "x"));
    expect(full.blend("ember", "lamp", 1, "x")).toBe(full.paint("lamp", "x"));
    expect(full.blend("ember", "lamp", 0.5, "x")).toBe(`${ESC}38;2;167;23;44mx${ESC}39m`);
    const cube = createTheme({ tier: "256", name: "dark" });
    const steps = new Set([0, 0.2, 0.4, 0.5, 0.6, 0.8, 1].map((t) => cube.blend("ember", "lamp", t, "x")));
    expect(steps.size).toBe(3);
    expect(createTheme({ tier: "16", name: "dark" }).blend("ember", "lamp", 0.1, "x")).toBe(`${ESC}31mx${ESC}39m`);
  });

  it("links only where the terminal follows them", () => {
    expect(createTheme({ tier: "256", name: "dark", links: true }).link("https://x.test", "docs")).toBe("\x1b]8;;https://x.test\x1b\\docs\x1b]8;;\x1b\\");
    expect(createTheme({ tier: "256", name: "dark" }).link("https://x.test", "docs")).toBe("docs");
  });

  it("writes tags in the tagged tier, so goldens read like the mockups", () => {
    const tagged = createTheme({ tier: "tagged", name: "dark" });
    expect(tagged.paint("amber", "✱")).toBe("‹amber›✱‹/›");
    expect(tagged.paint("amber", "")).toBe("");
    expect(tagged.blend("ember", "lamp", 0.3, "━")).toBe("‹lamp›━‹/›");
    expect(tagged.rgb([1, 2, 3], "x", "faint")).toBe("‹faint›x‹/›");
  });
});

describe("glyph sets", () => {
  it("gives every role a glyph in each set, and ASCII folds what it is handed", () => {
    for (const name of ["full", "basic", "ascii"] as const) {
      const set = glyphSet(name);
      for (const glyph of [set.barFill, set.barTrack, set.thumb, set.was, set.tick, set.ok, set.fail, set.warn, set.star, set.selected]) {
        expect(glyph).not.toBe("");
      }
    }
    expect(glyphSet("ascii").fold("−5…5 · ✱ → “x”")).toBe('-5...5 - * -> "x"');
    expect([...glyphSet("ascii").corners, glyphSet("ascii").barFill].join("")).toMatch(/^[\x20-\x7e]+$/);
    expect(glyphSet("basic").corners).toEqual(["┌", "┐", "└", "┘"]);
    expect(glyphSet("basic").halfLeft).toBe("");
  });
});

describe("width", () => {
  it("counts cells without escape codes, links or tags", () => {
    expect(cells("\x1b[1mbold\x1b[22m")).toBe(4);
    expect(cells("\x1b[38;2;1;2;3;4:3;58:2::1:2:3mx\x1b[39;24;59m")).toBe(1);
    expect(cells("\x1b]8;;https://x.test\x1b\\docs\x1b]8;;\x1b\\")).toBe(4);
    expect(cells("‹amber›✱‹/› ‹strong›set‹/›")).toBe(5);
    expect(stripMarkup("‹ No ›")).toBe("‹ No ›");
  });

  it("gives wide characters two cells and combining marks none", () => {
    expect(cells("写真.NEF")).toBe(8);
    expect(cells("e\u0301")).toBe(1);
    expect(cells("📷")).toBe(2);
  });

  it("clips from either end and joins blocks side by side", () => {
    expect(clip("DSC_0412.NEF", 8, "…")).toBe("DSC_041…");
    expect(clip("写真写真写真", 7, "…")).toBe("写真写…");
    expect(clipStart(String.raw`D:\Photos\Iceland 2026`, 12, "…")).toBe("…celand 2026");
    expect(joinHorizontal([["ab", "c"], ["x", "y", "z"]], 2)).toEqual(["ab  x", "c   y", "    z"]);
  });
});

describe("resolveCapabilities", () => {
  const resolve = (env: Record<string, string | undefined>, tty = { stdout: true, stderr: true }, probed?: "dark" | "light" | null) =>
    resolveCapabilities({ env, tty, probed });

  it("marks only terminals rich, each stream on its own", () => {
    expect(resolve({}).rich).toEqual({ stdout: true, stderr: true });
    expect(resolve({}, { stdout: false, stderr: true }).rich).toEqual({ stdout: false, stderr: true });
    expect(resolve({ TERM: "dumb" }).rich).toEqual({ stdout: false, stderr: false });
  });

  it("draws pictures only where the terminal takes them as they come and sizes them in cells", () => {
    const graphics = (env: Record<string, string | undefined>, sixel = false, tty = { stdout: true, stderr: true }) =>
      resolveCapabilities({ env, tty, sixel }).graphics;
    expect(graphics({ WT_SESSION: "1", OS: "Windows_NT" }, true)).toBe("sixel");
    // An older Windows Terminal doesn't list sixel, and other sixel terminals size it in pixels.
    expect(graphics({ WT_SESSION: "1", OS: "Windows_NT" })).toBeUndefined();
    expect(graphics({ TERM: "xterm-256color" }, true)).toBeUndefined();
    expect(graphics({ KITTY_WINDOW_ID: "1" })).toBe("kitty");
    expect(graphics({ TERM: "xterm-ghostty" })).toBe("kitty");
    expect(graphics({ TERM_PROGRAM: "iTerm.app" })).toBe("iterm");
    expect(graphics({ TERM_PROGRAM: "WezTerm" })).toBe("iterm");
    expect(graphics({ TERM_PROGRAM: "vscode" })).toBeUndefined();
    expect(graphics({ KITTY_WINDOW_ID: "1", TMUX: "/tmp/tmux" })).toBeUndefined();
    expect(graphics({ KITTY_WINDOW_ID: "1" }, false, { stdout: false, stderr: true })).toBeUndefined();
  });

  it("picks the colour tier", () => {
    expect(resolve({ COLORTERM: "truecolor" }).tier).toBe("truecolour");
    expect(resolve({ WT_SESSION: "1", OS: "Windows_NT" }).tier).toBe("truecolour");
    expect(resolve({ OS: "Windows_NT" }).tier).toBe("truecolour");
    expect(resolve({ TERM: "xterm-256color" }).tier).toBe("256");
    expect(resolve({ TERM: "xterm" }).tier).toBe("16");
    expect(resolve({ TERM: "linux" }).tier).toBe("16");
    expect(resolve({ NO_COLOR: "1", COLORTERM: "truecolor" }).tier).toBe("mono");
    expect(resolve({ NO_COLOR: "" }).tier).toBe("256");
  });

  it("believes SAFELIGHT_THEME, then the probe, then COLORFGBG, and otherwise doesn't guess", () => {
    expect(resolve({ SAFELIGHT_THEME: "light" }, undefined, "dark").theme).toBe("light");
    expect(resolve({ COLORFGBG: "0;15" }, undefined, "dark").theme).toBe("dark");
    expect(resolve({ COLORFGBG: "0;15" }).theme).toBe("light");
    expect(resolve({ COLORFGBG: "15;0" }).theme).toBe("dark");
    expect(resolve({ COLORFGBG: "15;default;8" }).theme).toBe("dark");
    expect(resolve({}).theme).toBe("unknown");
    expect(resolve({ TERM: "linux" }).theme).toBe("dark");
  });

  it("picks the glyph set", () => {
    expect(resolve({ LANG: "en_CA.UTF-8" }).glyphs).toBe("full");
    expect(resolve({ LANG: "C" }).glyphs).toBe("ascii");
    expect(resolve({ OS: "Windows_NT", WT_SESSION: "1" }).glyphs).toBe("full");
    expect(resolve({ OS: "Windows_NT" }).glyphs).toBe("basic");
    expect(resolve({ TERM: "linux" }).glyphs).toBe("ascii");
    expect(resolve({ OS: "Windows_NT", SAFELIGHT_GLYPHS: "ascii", WT_SESSION: "1" }).glyphs).toBe("ascii");
  });

  it("reduces motion when asked, under CI, and has none off a terminal", () => {
    expect(resolve({}).motion).toBe("full");
    expect(resolve({ SAFELIGHT_REDUCED_MOTION: "1" }).motion).toBe("reduced");
    expect(resolve({ SAFELIGHT_REDUCED_MOTION: "0" }).motion).toBe("full");
    expect(resolve({ SAFELIGHT_REDUCED_MOTION: "" }).motion).toBe("full");
    expect(resolve({ CI: "true" }).motion).toBe("reduced");
    expect(resolve({}, { stdout: false, stderr: false }).motion).toBe("none");
    expect(resolve({ SSH_CONNECTION: "1 2 3 4" }).clockScale).toBe(2);
    expect(resolve({}).clockScale).toBe(1);
  });

  it("knows which terminals follow links and draw curly underlines", () => {
    expect(resolve({ WT_SESSION: "1" })).toMatchObject({ links: true, curly: true });
    expect(resolve({ TERM: "xterm-kitty" })).toMatchObject({ links: true, curly: true });
    expect(resolve({ TERM_PROGRAM: "vscode" })).toMatchObject({ links: true, curly: false });
    expect(resolve({ WT_SESSION: "1", TMUX: "/tmp/tmux" })).toMatchObject({ links: false, curly: false });
    expect(resolve({ TERM: "xterm-256color" })).toMatchObject({ links: false, curly: false });
  });
});

describe("the background probe", () => {
  it("reads light and dark out of an OSC 11 reply of any digit count", () => {
    expect(parseBackgroundReply("\x1b]11;rgb:0f0f/0b0b/0b0b\x1b\\")).toBe("dark");
    expect(parseBackgroundReply("\x1b]11;rgb:f7f7/f3f3/eeee\x07")).toBe("light");
    expect(parseBackgroundReply("\x1b]11;rgb:ff/ff/ff\x1b\\")).toBe("light");
    expect(parseBackgroundReply("\x1b[?62;4c")).toBeNull();
  });

  function terminal(reply: string | null) {
    const raw: boolean[] = [];
    const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (on: boolean) => { raw.push(on); return stdin; } });
    const written: string[] = [];
    const stdout = {
      isTTY: true,
      write(text: string) {
        written.push(text);
        if (reply !== null) queueMicrotask(() => stdin.write(reply));
        return true;
      },
    };
    return { stdin: stdin as unknown as ProbeInput, stdout: stdout as unknown as NodeJS.WriteStream, written, raw };
  }

  it("asks once, stops at the device-attributes reply, and remembers the answer", async () => {
    const t = terminal("\x1b]11;rgb:f7f7/f3f3/eeee\x1b\\\x1b[?62;4;22c");
    const probe = await probeTheme(t.stdin, t.stdout, {}, 1000);
    expect(t.written).toEqual(["\x1b]11;?\x1b\\\x1b[c"]);
    expect(probe).toEqual({ theme: "light", sixel: true, pending: "" });
    expect(t.raw).toEqual([true, false]);
    expect(probedTheme()).toBe("light");
    expect(probedSixel()).toBe(true);
    rememberSixel(false);
    rememberTheme(null);
  });

  it("hands back keys typed while it listened, and learns nothing from a terminal that only answers attributes", async () => {
    const t = terminal("ph\x1b[?1;2c");
    expect(await probeTheme(t.stdin, t.stdout, {}, 1000)).toEqual({ theme: null, sixel: false, pending: "ph" });
  });

  it("gives up after the timeout", async () => {
    const t = terminal(null);
    expect(await probeTheme(t.stdin, t.stdout, {}, 5)).toEqual({ theme: null, sixel: false, pending: "" });
    expect(t.raw).toEqual([true, false]);
  });

  it("doesn't ask off a terminal, under CI, on a dumb terminal, or when the theme is set", async () => {
    for (const env of [{ CI: "1" }, { TERM: "dumb" }, { SAFELIGHT_THEME: "dark" }]) {
      const t = terminal("\x1b[?1c");
      expect((await probeTheme(t.stdin, t.stdout, env)).theme).toBeNull();
      expect(t.written).toEqual([]);
    }
    const piped = terminal("\x1b[?1c");
    await probeTheme({ ...piped.stdin, isTTY: false } as ProbeInput, piped.stdout, {});
    expect(piped.written).toEqual([]);
  });
});
