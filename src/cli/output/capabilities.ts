// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What this terminal can take, found once per run. resolveCapabilities is
// pure: the environment and which streams are terminals go in, the answer
// comes out. The one thing that has to be asked, the background colour, is
// probeTheme, which reads the streams it is handed.

import type { GraphicsMode } from "../types";
import type { GlyphSetName } from "./glyphs";
import { luminance } from "./theme";
import type { ColourTier, ThemeName } from "./theme";

type Env = Readonly<Record<string, string | undefined>>;

export interface Capabilities {
  theme: ThemeName;
  tier: ColourTier;
  glyphs: GlyphSetName;
  /** "reduced": no warm-up or tweens, a still lamp, progress once a second. "none": neither stream is a terminal. */
  motion: "full" | "reduced" | "none";
  /** Stretches every clock interval; 2 over SSH, to spare a slow link. */
  clockScale: number;
  /** OSC 8 links are followed. */
  links: boolean;
  /** Frames are wrapped in synchronized output. Terminals that don't know the mode ignore it. */
  sync: boolean;
  /** Curly underlines with their own colour (SGR 4:3 and 58). */
  curly: boolean;
  /** The image protocol home draws the logo with; absent where it is drawn in blocks. */
  graphics?: GraphicsMode;
  /** Which streams are terminals that take the designed look. The others keep the plain one, byte for byte. */
  rich: { stdout: boolean; stderr: boolean };
}

export interface CapabilityInput {
  env: Env;
  tty: { stdout: boolean; stderr: boolean };
  /** What probeTheme heard, if it ran. */
  probed?: ThemeName | null;
  /** probeTheme's device-attributes reply listed sixel. */
  sixel?: boolean;
}

const set = (value: string | undefined): boolean => value !== undefined && value !== "" && value !== "0";

function themeOf(env: Env, probed: ThemeName | null | undefined): ThemeName {
  if (env.SAFELIGHT_THEME === "dark" || env.SAFELIGHT_THEME === "light") return env.SAFELIGHT_THEME;
  if (probed === "dark" || probed === "light") return probed;
  const last = env.COLORFGBG?.split(";").pop();
  if (last !== undefined && /^\d+$/.test(last)) return Number(last) <= 6 || Number(last) === 8 ? "dark" : "light";
  return env.TERM === "linux" ? "dark" : "unknown";
}

function tierOf(env: Env): ColourTier {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return "mono";
  if (env.COLORTERM === "truecolor" || env.COLORTERM === "24bit" || env.WT_SESSION !== undefined) return "truecolour";
  if (/^(iTerm\.app|vscode|WezTerm|ghostty)$/.test(env.TERM_PROGRAM ?? "") || /kitty|ghostty|direct/.test(env.TERM ?? "")) return "truecolour";
  // The Windows console has drawn 24-bit colour since Windows 10 1703, and says nothing about it.
  if (env.OS === "Windows_NT" && env.TERM === undefined) return "truecolour";
  if (env.TERM === "linux" || env.TERM === "xterm") return "16";
  return "256";
}

function glyphsOf(env: Env): GlyphSetName {
  const chosen = env.SAFELIGHT_GLYPHS;
  if (chosen === "full" || chosen === "basic" || chosen === "ascii") return chosen;
  if (env.TERM === "dumb" || env.TERM === "linux") return "ascii";
  if (env.OS === "Windows_NT") {
    const modern = env.WT_SESSION !== undefined || env.TERM_PROGRAM !== undefined || env.TERM !== undefined || env.ConEmuANSI === "ON";
    return modern ? "full" : "basic";
  }
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return locale === "" || /utf-?8/i.test(locale) ? "full" : "ascii";
}

function followsLinks(env: Env): boolean {
  if (env.TMUX !== undefined) return false;
  if (env.WT_SESSION !== undefined || Number(env.VTE_VERSION) >= 5000) return true;
  return /^(iTerm\.app|vscode|WezTerm|ghostty)$/.test(env.TERM_PROGRAM ?? "") || /kitty|ghostty/.test(env.TERM ?? "");
}

function drawsCurly(env: Env): boolean {
  if (env.TMUX !== undefined) return false;
  if (env.WT_SESSION !== undefined || Number(env.VTE_VERSION) >= 5200) return true;
  return /^(iTerm\.app|WezTerm|ghostty)$/.test(env.TERM_PROGRAM ?? "") || /kitty|ghostty/.test(env.TERM ?? "");
}

/**
 * The protocol a picture of known size in cells can be drawn with, or nothing.
 * Only terminals that take it as they come: tmux needs wrapping, WezTerm has
 * kitty's protocol off until it is configured and VS Code has iTerm2's off,
 * and sixel is only sized in cells by Windows Terminal, ten pixels by twenty.
 */
function graphicsOf(env: Env, sixel: boolean): GraphicsMode | undefined {
  if (env.TMUX !== undefined) return undefined;
  const program = env.TERM_PROGRAM ?? "";
  if (env.KITTY_WINDOW_ID !== undefined || /kitty|ghostty/.test(env.TERM ?? "") || program === "ghostty" || env.KONSOLE_VERSION !== undefined) return "kitty";
  if (program === "iTerm.app" || env.LC_TERMINAL === "iTerm2" || program === "WezTerm") return "iterm";
  return sixel && env.WT_SESSION !== undefined ? "sixel" : undefined;
}

export function resolveCapabilities(input: CapabilityInput): Capabilities {
  const { env, tty } = input;
  const dumb = env.TERM === "dumb";
  const rich = { stdout: tty.stdout && !dumb, stderr: tty.stderr && !dumb };
  const onTerminal = rich.stdout || rich.stderr;
  return {
    theme: themeOf(env, input.probed),
    tier: tierOf(env),
    glyphs: glyphsOf(env),
    motion: !onTerminal ? "none" : set(env.SAFELIGHT_REDUCED_MOTION) || env.CI !== undefined ? "reduced" : "full",
    clockScale: env.SSH_CONNECTION !== undefined ? 2 : 1,
    links: onTerminal && followsLinks(env),
    sync: onTerminal && env.TERM !== "linux",
    curly: drawsCurly(env),
    graphics: rich.stdout ? graphicsOf(env, input.sixel === true) : undefined,
    rich,
  };
}

/** Reads the background out of an OSC 11 reply (`rgb:RRRR/GGGG/BBBB`, any digit count). */
export function parseBackgroundReply(reply: string): ThemeName | null {
  const match = /\x1b\]11;rgba?:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i.exec(reply);
  if (!match) return null;
  const channel = (hex: string): number => (Number.parseInt(hex, 16) / (16 ** hex.length - 1)) * 255;
  return luminance([channel(match[1]), channel(match[2]), channel(match[3])]) > 0.5 ? "light" : "dark";
}

const BACKGROUND_REPLY = /\x1b\]11;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ATTRIBUTES_REPLY = /\x1b\[\?[\d;]*c/g;

// Every terminal answers the device-attributes query, so the read stops at
// its reply and never sits out the timeout on one that ignores OSC 11.
const THEME_QUERY = "\x1b]11;?\x1b\\\x1b[c";

export type ProbeInput = Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "on" | "off" | "resume" | "pause">;
export type ProbeOutput = Pick<NodeJS.WriteStream, "isTTY" | "write">;

export interface ThemeProbe {
  theme: ThemeName | null;
  /** The device-attributes reply lists sixel ("4"). */
  sixel: boolean;
  /** Anything typed while the probe was listening, to feed to the prompt. */
  pending: string;
}

let probed: ThemeName | null = null;
let sixelProbed = false;

/** What the last probeTheme heard; resolveOutputOptions reads it. */
export function probedTheme(): ThemeName | null {
  return probed;
}

export function rememberTheme(theme: ThemeName | null): void {
  probed = theme;
}

/** Whether the last probeTheme heard the terminal list sixel; resolveOutputOptions reads it. */
export function probedSixel(): boolean {
  return sixelProbed;
}

export function rememberSixel(sixel: boolean): void {
  sixelProbed = sixel;
}

/**
 * Asks the terminal for its background, once, before the prompt takes the
 * keyboard. Resolves with nothing learned when either stream isn't a terminal,
 * under CI or TERM=dumb, or when SAFELIGHT_THEME already answers.
 */
export function probeTheme(stdin: ProbeInput, stdout: ProbeOutput, env: Env, timeoutMs = 150): Promise<ThemeProbe> {
  const nothing: ThemeProbe = { theme: null, sixel: false, pending: "" };
  const skip = stdin.isTTY !== true || stdout.isTTY !== true || typeof stdin.setRawMode !== "function"
    || env.CI !== undefined || env.TERM === "dumb" || env.SAFELIGHT_THEME === "dark" || env.SAFELIGHT_THEME === "light";
  if (skip) return Promise.resolve(nothing);

  return new Promise((resolve) => {
    let reply = "";
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      const theme = parseBackgroundReply(reply);
      const attributes = reply.match(ATTRIBUTES_REPLY)?.[0] ?? "";
      const sixel = /[?;]4[;c]/.test(attributes);
      rememberTheme(theme);
      rememberSixel(sixel);
      resolve({
        theme,
        sixel,
        pending: reply.replace(BACKGROUND_REPLY, "").replace(ATTRIBUTES_REPLY, ""),
      });
    };
    const onData = (chunk: Buffer | string): void => {
      reply += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      ATTRIBUTES_REPLY.lastIndex = 0;
      if (ATTRIBUTES_REPLY.test(reply)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    stdout.write(THEME_QUERY);
  });
}
