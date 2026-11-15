import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  detectGraphicsMode,
  encodeForTerminal,
  encodePng,
  parseProbeReply,
  supportsTrueColour,
  type TerminalImage,
} from "./terminal-image";
import type { CliEnv } from "./types";

function env(vars: Record<string, string> = {}, over: Partial<CliEnv> = {}): CliEnv {
  return {
    cwd: "/w", userData: "/u", appRoot: "/app", appVersion: "3.3.0", platform: "linux",
    isTTY: { stdin: true, stdout: true, stderr: true },
    env: vars,
    ...over,
  };
}

// red, green / blue, white
const RGBA = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255,
  0, 0, 255, 255, 255, 255, 255, 255,
]);
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("half-block encoder", () => {
  it("gives golden bytes for a 2x2 image", () => {
    const out = text(encodeForTerminal("blocks", { width: 2, height: 2, encoding: "rgba", bytes: RGBA }, env()));
    expect(out).toBe(
      "\x1b[38;2;255;0;0;48;2;0;0;255m▀\x1b[38;2;0;255;0;48;2;255;255;255m▀\x1b[0m\n",
    );
  });

  it("repeats no colour code for a run of equal cells and handles an odd last row", () => {
    const row = [10, 20, 30, 255, 10, 20, 30, 255];
    const out = text(encodeForTerminal("blocks", { width: 2, height: 1, encoding: "rgba", bytes: new Uint8Array(row) }, env()));
    expect(out).toBe("\x1b[38;2;10;20;30;49m▀▀\x1b[0m\n");
  });

  it("refuses PNG bytes", () => {
    expect(() => encodeForTerminal("blocks", { width: 1, height: 1, encoding: "png", bytes: new Uint8Array(1) }, env())).toThrow();
  });
});

describe("kitty encoder", () => {
  const png: TerminalImage = { width: 2, height: 2, encoding: "png", bytes: new Uint8Array([1, 2, 3, 4, 5]) };

  it("sends a small PNG in one chunk", () => {
    expect(text(encodeForTerminal("kitty", png, env()))).toBe("\x1b_Ga=T,f=100,q=2,m=0;AQIDBAU=\x1b\\\n");
  });

  it("splits into 4096-byte base64 chunks, continuing with m only", () => {
    const big: TerminalImage = { ...png, bytes: new Uint8Array(4096 * 3 / 4 + 3).fill(65) };
    const out = text(encodeForTerminal("kitty", big, env()));
    const chunks = out.trimEnd().split("\x1b\\").filter(Boolean);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startsWith("\x1b_Ga=T,f=100,q=2,m=1;")).toBe(true);
    expect(chunks[0].length - "\x1b_Ga=T,f=100,q=2,m=1;".length).toBe(4096);
    expect(chunks[1].startsWith("\x1b_Gm=0;")).toBe(true);
  });

  it("describes raw RGBA with its size", () => {
    const out = text(encodeForTerminal("kitty", { width: 2, height: 2, encoding: "rgba", bytes: RGBA }, env()));
    expect(out.startsWith("\x1b_Ga=T,f=32,s=2,v=2,q=2,m=0;")).toBe(true);
  });

  it("wraps every chunk for tmux passthrough", () => {
    const out = text(encodeForTerminal("kitty", png, env({ TMUX: "/tmp/tmux-1/default,1,0" })));
    expect(out).toBe("\x1bPtmux;\x1b\x1b_Ga=T,f=100,q=2,m=0;AQIDBAU=\x1b\x1b\\\x1b\\\n");
  });
});

describe("iTerm2 encoder", () => {
  it("sends a PNG inline", () => {
    const out = text(encodeForTerminal("iterm", { width: 2, height: 2, encoding: "png", bytes: new Uint8Array([1, 2, 3, 4, 5]) }, env()));
    expect(out).toBe("\x1b]1337;File=inline=1;size=5;width=2px;height=2px;preserveAspectRatio=1:AQIDBAU=\x07\n");
  });

  it("encodes RGBA to PNG first", () => {
    const out = text(encodeForTerminal("iterm", { width: 2, height: 2, encoding: "rgba", bytes: RGBA }, env()));
    const data = /:([A-Za-z0-9+/=]+)\x07/.exec(out)?.[1] ?? "";
    expect(Array.from(Buffer.from(data, "base64").subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe("encodePng", () => {
  it("writes chunks whose pixels inflate back to the input", () => {
    const png = encodePng(2, 2, RGBA);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(16)).toBe(2);
    expect(view.getUint32(20)).toBe(2);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(Array.from(raw)).toEqual([0, ...RGBA.subarray(0, 8), 0, ...RGBA.subarray(8, 16)]);
    expect(text(png.subarray(png.length - 8, png.length - 4))).toBe("IEND");
  });
});

describe("mode detection", () => {
  const never = async () => { throw new Error("probe must not run"); };

  it("honours the override first", async () => {
    expect((await detectGraphicsMode(env(), "kitty", never)).mode).toBe("kitty");
  });

  it("shows nothing when stdout isn't a terminal", async () => {
    expect((await detectGraphicsMode(env({}, { isTTY: { stdin: true, stdout: false, stderr: true } }), undefined, never)).mode).toBe("none");
  });

  it.each([
    [{ KITTY_WINDOW_ID: "1" }, "kitty"],
    [{ TERM: "xterm-ghostty" }, "kitty"],
    [{ TERM_PROGRAM: "WezTerm" }, "kitty"],
    [{ KONSOLE_VERSION: "230800" }, "kitty"],
    [{ TERM_PROGRAM: "iTerm.app" }, "iterm"],
    [{ TERM_PROGRAM: "vscode" }, "iterm"],
  ])("reads %j from the environment", async (vars, mode) => {
    expect((await detectGraphicsMode(env(vars), undefined, never)).mode).toBe(mode);
  });

  it("never probes on Windows and falls to blocks", async () => {
    const result = await detectGraphicsMode(env({ WT_SESSION: "x" }, { platform: "win32" }), undefined, never);
    expect(result.mode).toBe("blocks");
  });

  it("probes on Unix with 150 ms, 500 ms over SSH", async () => {
    const waits: number[] = [];
    const probe = async (ms: number) => { waits.push(ms); return "\x1b_Gi=31;OK\x1b\\\x1b[6;18;9t\x1b[?62c"; };
    const local = await detectGraphicsMode(env(), undefined, probe);
    await detectGraphicsMode(env({ SSH_TTY: "/dev/pts/1" }), undefined, probe);
    expect(waits).toEqual([150, 500]);
    expect(local).toMatchObject({ mode: "kitty", cell: { width: 9, height: 18 } });
  });

  it("falls to blocks when the terminal answers DA1 only", async () => {
    expect((await detectGraphicsMode(env(), undefined, async () => "\x1b[?62c")).mode).toBe("blocks");
  });
});

describe("probe reply and colour", () => {
  it("parses the kitty answer and the cell size", () => {
    expect(parseProbeReply("\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t\x1b[?1c")).toEqual({ kitty: true, cell: { width: 8, height: 16 } });
    expect(parseProbeReply("\x1b[?1c")).toEqual({ kitty: false, cell: undefined });
  });

  it("knows true colour from COLORTERM and Windows Terminal", () => {
    expect(supportsTrueColour(env({ COLORTERM: "truecolor" }))).toBe(true);
    expect(supportsTrueColour(env({ WT_SESSION: "1" }))).toBe(true);
    expect(supportsTrueColour(env({ TERM: "xterm-256color" }))).toBe(false);
  });
});
