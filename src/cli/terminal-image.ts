// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which inline-image protocol the terminal speaks, and the encoders for it.

import { deflateSync } from "node:zlib";
import type { CliEnv, GraphicsMode } from "./types";

export interface TerminalImage { width: number; height: number; encoding: "png" | "rgba"; bytes: Uint8Array }

export interface CellSize { width: number; height: number }

export interface DetectedMode { mode: GraphicsMode; reason: string; cell?: CellSize }

/** Asks the terminal for its kitty-graphics support and cell size; resolves the raw reply, or null. */
export type TerminalProbe = (timeoutMs: number) => Promise<string | null>;

const ESC = "\x1b";
const ST = `${ESC}\\`;
const KITTY_CHUNK = 4096;
export const DEFAULT_CELL: CellSize = { width: 8, height: 16 };

const MODES: readonly GraphicsMode[] = ["kitty", "iterm", "blocks", "none"];

export function isGraphicsMode(value: string): value is GraphicsMode {
  return (MODES as readonly string[]).includes(value);
}

function modeFromEnvironment(env: CliEnv): { mode: GraphicsMode; reason: string } | null {
  const e = env.env;
  const program = e.TERM_PROGRAM ?? "";
  if (e.KITTY_WINDOW_ID || e.TERM === "xterm-kitty") return { mode: "kitty", reason: "kitty" };
  if (e.GHOSTTY_RESOURCES_DIR || program === "ghostty" || e.TERM === "xterm-ghostty") return { mode: "kitty", reason: "Ghostty" };
  if (program === "WezTerm" || e.WEZTERM_EXECUTABLE) return { mode: "kitty", reason: "WezTerm" };
  if (e.KONSOLE_VERSION) return { mode: "kitty", reason: "Konsole" };
  if (program === "iTerm.app" || e.LC_TERMINAL === "iTerm2") return { mode: "iterm", reason: "iTerm2" };
  if (program === "vscode") return { mode: "iterm", reason: "VS Code's terminal" };
  return null;
}

/** Whether half-blocks (or anything else) can show 24-bit colour in this terminal. */
export function supportsTrueColour(env: CliEnv): boolean {
  const e = env.env;
  if (e.COLORTERM === "truecolor" || e.COLORTERM === "24bit") return true;
  if (e.WT_SESSION) return true;
  return modeFromEnvironment(env) !== null;
}

/** Reads `ESC_Gi=31;OK ESC\` (kitty answered) and `ESC[6;h;wt` (cell size) out of a probe reply. */
export function parseProbeReply(reply: string): { kitty: boolean; cell?: CellSize } {
  const kitty = reply.includes(`${ESC}_Gi=31;OK`);
  const size = /\x1b\[6;(\d+);(\d+)t/.exec(reply);
  const cell = size ? { width: Number(size[2]), height: Number(size[1]) } : undefined;
  return { kitty, cell: cell && cell.width > 0 && cell.height > 0 ? cell : undefined };
}

const PROBE_QUERY = `${ESC}_Gi=31,s=1,v=1,a=q,t=d,f=24;AAAA${ST}${ESC}[16t${ESC}[c`;

export const probeTerminal: TerminalProbe = (timeoutMs) => new Promise((resolve) => {
  const stdin = process.stdin;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") { resolve(null); return; }
  let reply = "";
  const finish = (value: string | null) => {
    clearTimeout(timer);
    stdin.off("data", onData);
    stdin.setRawMode(false);
    stdin.pause();
    resolve(value);
  };
  const onData = (chunk: Buffer) => {
    reply += chunk.toString("latin1");
    if (/\x1b\[\?[\d;]*c/.test(reply)) finish(reply);
  };
  const timer = setTimeout(() => finish(reply || null), timeoutMs);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", onData);
  process.stdout.write(PROBE_QUERY);
});

export async function detectGraphicsMode(
  env: CliEnv,
  override?: GraphicsMode,
  probe: TerminalProbe = probeTerminal,
): Promise<DetectedMode> {
  if (override) return { mode: override, reason: "chosen with --graphics" };
  if (!env.isTTY.stdout) return { mode: "none", reason: "stdout isn't a terminal" };
  const known = modeFromEnvironment(env);
  if (known) return known;
  if (env.platform !== "win32" && env.isTTY.stdin) {
    const reply = await probe(env.env.SSH_TTY ? 500 : 150);
    if (reply) {
      const { kitty, cell } = parseProbeReply(reply);
      if (kitty) return { mode: "kitty", reason: "the terminal answered the kitty query", cell };
      return { mode: "blocks", reason: "the terminal has no image protocol slu knows", cell };
    }
  }
  return { mode: "blocks", reason: "no image protocol detected" };
}

// ---- encoders ---------------------------------------------------------------

const textBytes = (text: string) => new TextEncoder().encode(text);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");

/** tmux forwards an escape sequence only when it is wrapped, with the inner ESCs doubled. */
function tmuxWrap(sequence: string): string {
  return `${ESC}Ptmux;${sequence.replaceAll(ESC, ESC + ESC)}${ST}`;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(textBytes(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit RGBA, unfiltered scanlines. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function encodeKitty(image: TerminalImage, env: CliEnv): Uint8Array {
  const wrap = env.env.TMUX ? tmuxWrap : (s: string) => s;
  const data = base64(image.bytes);
  // q=2 keeps the terminal from answering into the shell's input
  const control = image.encoding === "png"
    ? "a=T,f=100,q=2"
    : `a=T,f=32,s=${image.width},v=${image.height},q=2`;
  let out = "";
  for (let at = 0; at === 0 || at < data.length; at += KITTY_CHUNK) {
    const chunk = data.slice(at, at + KITTY_CHUNK);
    const more = at + KITTY_CHUNK < data.length ? 1 : 0;
    out += wrap(`${ESC}_G${at === 0 ? `${control},` : ""}m=${more};${chunk}${ST}`);
  }
  return textBytes(`${out}\n`);
}

function encodeIterm(image: TerminalImage, env: CliEnv): Uint8Array {
  const png = image.encoding === "png" ? image.bytes : encodePng(image.width, image.height, image.bytes);
  const sequence = `${ESC}]1337;File=inline=1;size=${png.length};width=${image.width}px;height=${image.height}px;preserveAspectRatio=1:${base64(png)}\x07`;
  return textBytes(`${env.env.TMUX ? tmuxWrap(sequence) : sequence}\n`);
}

/** One text row per two pixel rows: the upper half block, foreground the top pixel, background the bottom. */
function encodeBlocks(image: TerminalImage): Uint8Array {
  if (image.encoding !== "rgba") throw new Error("half-blocks need RGBA pixels");
  const { width, height, bytes } = image;
  const lines: string[] = [];
  for (let y = 0; y < height; y += 2) {
    let line = "";
    let last = "";
    for (let x = 0; x < width; x++) {
      const top = (y * width + x) * 4;
      const fg = `38;2;${bytes[top]};${bytes[top + 1]};${bytes[top + 2]}`;
      const bottom = ((y + 1) * width + x) * 4;
      const bg = y + 1 < height ? `48;2;${bytes[bottom]};${bytes[bottom + 1]};${bytes[bottom + 2]}` : "49";
      const sgr = `${fg};${bg}`;
      if (sgr !== last) { line += `${ESC}[${sgr}m`; last = sgr; }
      line += "▀";
    }
    lines.push(`${line}${ESC}[0m`);
  }
  return textBytes(`${lines.join("\n")}\n`);
}

export function encodeForTerminal(mode: GraphicsMode, image: TerminalImage, env: CliEnv): Uint8Array {
  switch (mode) {
    case "kitty": return encodeKitty(image, env);
    case "iterm": return encodeIterm(image, env);
    case "blocks": return encodeBlocks(image);
    case "none": return new Uint8Array(0);
  }
}
