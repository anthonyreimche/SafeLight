import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  detectGraphicsMode,
  encodeForTerminal,
  encodePng,
  encodeItermJpeg,
  encodeSixel,
  parseProbeReply,
  speaksIterm,
  supportsTrueColour,
  type TerminalImage,
} from "./terminal-image";
import type { CliEnv } from "./types";

function env(vars: Record<string, string> = {}, over: Partial<CliEnv> = {}): CliEnv {
  return {
    cwd: "/w", userData: "/u", appRoot: "/app", electronBinary: null, appVersion: "3.3.0", platform: "linux",
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

describe("iTerm2 JPEG passthrough", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xd9]);

  it("sends the file's own bytes at a width in cells", () => {
    expect(text(encodeItermJpeg(jpeg, 28, env()))).toBe(
      "\x1b]1337;File=inline=1;size=6;width=28;preserveAspectRatio=1:/9j/4P/Z\x07\n",
    );
  });

  it("wraps for tmux", () => {
    expect(text(encodeItermJpeg(jpeg, 28, env({ TMUX: "x" }))).startsWith("\x1bPtmux;\x1b\x1b]1337;")).toBe(true);
  });

  it("is spoken only where the environment says iTerm2 or VS Code, never guessed", () => {
    expect(speaksIterm(env({ TERM_PROGRAM: "iTerm.app" }))).toBe(true);
    expect(speaksIterm(env({ TERM_PROGRAM: "vscode" }))).toBe(true);
    expect(speaksIterm(env({ KITTY_WINDOW_ID: "1" }))).toBe(false);
    expect(speaksIterm(env())).toBe(false);
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

  it("never probes on Windows without Windows Terminal, or without a terminal on stdin", async () => {
    expect((await detectGraphicsMode(env({}, { platform: "win32" }), undefined, never)).mode).toBe("blocks");
    const piped = env({ WT_SESSION: "x" }, { platform: "win32", isTTY: { stdin: false, stdout: true, stderr: true } });
    expect((await detectGraphicsMode(piped, undefined, never)).mode).toBe("blocks");
  });

  it("asks Windows Terminal with DA1 and uses sixel when it says 4", async () => {
    const win = env({ WT_SESSION: "x" }, { platform: "win32" });
    expect((await detectGraphicsMode(win, undefined, async () => "\x1b[?61;4;6;7c")).mode).toBe("sixel");
    expect((await detectGraphicsMode(win, undefined, async () => "\x1b[?61;6;7c")).mode).toBe("blocks");
    expect((await detectGraphicsMode(win, undefined, async () => null)).mode).toBe("blocks");
  });

  it("prefers kitty over sixel when both answer, and --graphics sixel overrides", async () => {
    const both = async () => "\x1b_Gi=31;OK\x1b\\\x1b[?62;4c";
    expect((await detectGraphicsMode(env(), undefined, both)).mode).toBe("kitty");
    expect((await detectGraphicsMode(env(), "sixel", never)).mode).toBe("sixel");
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

/** A reader for the sixel stream, so the encoder is checked by what a terminal would draw. */
function drawSixel(stream: string, width: number, height: number): { rgba: Uint8Array; colours: number } {
  const body = /^\x1bP[\d;]*q([\s\S]*)\x1b\\/.exec(stream.trimEnd())?.[1] ?? "";
  const palette = new Map<number, [number, number, number]>();
  const rgba = new Uint8Array(width * height * 4);
  let current = 0;
  let x = 0;
  let band = 0;
  const paint = (bits: number, times: number) => {
    for (let k = 0; k < times; k++, x++) {
      for (let bit = 0; bit < 6; bit++) {
        const y = band * 6 + bit;
        if (!(bits & (1 << bit)) || y >= height || x >= width) continue;
        const [r, g, b] = palette.get(current) ?? [0, 0, 0];
        rgba.set([r, g, b, 255], (y * width + x) * 4);
      }
    }
  };
  const token = /#(\d+);2;(\d+);(\d+);(\d+)|#(\d+)|!(\d+)(.)|(\$)|(-)|([?-~])|"[\d;]*/g;
  for (const m of body.matchAll(token)) {
    if (m[1] !== undefined) palette.set(Number(m[1]), [Math.round(Number(m[2]) * 2.55), Math.round(Number(m[3]) * 2.55), Math.round(Number(m[4]) * 2.55)]);
    else if (m[5] !== undefined) current = Number(m[5]);
    else if (m[6] !== undefined) paint(m[7].charCodeAt(0) - 63, Number(m[6]));
    else if (m[8]) x = 0;
    else if (m[9]) { x = 0; band++; }
    else if (m[10]) paint(m[10].charCodeAt(0) - 63, 1);
  }
  return { rgba, colours: palette.size };
}

describe("sixel encoder", () => {
  const sixel = (width: number, height: number, bytes: Uint8Array) =>
    text(encodeForTerminal("sixel", { width, height, encoding: "rgba", bytes }, env()));

  it("gives golden bytes for a 2x2 image", () => {
    expect(sixel(2, 2, RGBA)).toBe(
      "\x1bP0;1;0q\"1;1;2;2#0;2;100;0;0#1;2;0;100;0#2;2;0;0;100#3;2;100;100;100#0@$#1?@$#2A$#3?A\x1b\\\n",
    );
  });

  it("run-length encodes columns of the same sixel and ends each band with a dash", () => {
    const red = new Uint8Array(8 * 7 * 4);
    for (let i = 0; i < red.length; i += 4) red.set([255, 0, 0, 255], i);
    expect(sixel(8, 7, red)).toBe("\x1bP0;1;0q\"1;1;8;7#0;2;100;0;0#0!8~-#0!8@\x1b\\\n");
  });

  it("leaves transparent pixels undrawn", () => {
    const px = new Uint8Array([255, 0, 0, 255, 9, 9, 9, 0, 255, 0, 0, 255]);
    expect(sixel(3, 1, px)).toBe("\x1bP0;1;0q\"1;1;3;1#0;2;100;0;0#0@?@\x1b\\\n");
  });

  it("keeps at most 256 colours and draws a gradient close to the original", () => {
    const w = 64;
    const h = 40;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) px.set([x * 4, y * 6, ((x + y) * 2) % 256, 255], (y * w + x) * 4);
    }
    const drawn = drawSixel(sixel(w, h, px), w, h);
    expect(drawn.colours).toBeLessThanOrEqual(256);
    expect(drawn.colours).toBeGreaterThan(64);
    let worst = 0;
    for (let i = 0; i < px.length; i += 4) {
      worst = Math.max(worst, Math.abs(px[i] - drawn.rgba[i]), Math.abs(px[i + 1] - drawn.rgba[i + 1]), Math.abs(px[i + 2] - drawn.rgba[i + 2]));
    }
    expect(worst).toBeLessThan(40);
  });

  it("quantizes a 640x400 preview in well under a second", () => {
    const px = new Uint8Array(640 * 400 * 4);
    for (let i = 0; i < px.length; i += 4) {
      const p = i / 4;
      px.set([(p * 7) % 256, ((p * 13) >> 3) % 256, ((p * 31) >> 6) % 256, 255], i);
    }
    const started = performance.now();
    sixel(640, 400, px);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("refuses PNG bytes", () => {
    expect(() => encodeSixel({ width: 1, height: 1, encoding: "png", bytes: new Uint8Array(1) })).toThrow();
  });
});

describe("probe reply and colour", () => {
  it("parses the kitty answer and the cell size", () => {
    expect(parseProbeReply("\x1b_Gi=31;OK\x1b\\\x1b[6;16;8t\x1b[?1c")).toEqual({ kitty: true, sixel: false, cell: { width: 8, height: 16 } });
    expect(parseProbeReply("\x1b[?1c")).toEqual({ kitty: false, sixel: false, cell: undefined });
    expect(parseProbeReply("\x1b[?62;4;22c").sixel).toBe(true);
    expect(parseProbeReply("\x1b[?62;14c").sixel).toBe(false);
  });

  it("knows true colour from COLORTERM and Windows Terminal", () => {
    expect(supportsTrueColour(env({ COLORTERM: "truecolor" }))).toBe(true);
    expect(supportsTrueColour(env({ WT_SESSION: "1" }))).toBe(true);
    expect(supportsTrueColour(env({ TERM: "xterm-256color" }))).toBe(false);
  });
});
