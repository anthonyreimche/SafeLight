// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// While a command runs, the line under its output says so: "● Running export…
// 4.2 s · ctrl+c stops". It comes up only after a quiet moment, lifts out of
// the way of anything the command writes on either stream, and stays down
// while the command leaves a line open (a question, its own live region), so
// it never lands inside one.

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const ERASE_LINE = "\x1b[K";
const ERASE_BELOW = "\x1b[J";
const TRAILING_CONTROLS = /(?:\x1b\[[0-9;?]*[ -/]*[@-~])+$/;

type Write = NodeJS.WriteStream["write"];

export interface RunningFooter {
  /** Takes the line away and gives the streams back. */
  stop(): void;
}

export interface RunningTiming {
  /** How long the command must have written nothing before the line shows. */
  after: number;
  /** How often the line is drawn again, for its clock. */
  tick: number;
}

const TIMING: RunningTiming = { after: 400, tick: 100 };

function text(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  return chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1") : "";
}

/** Shows `row()` under what a command writes until stopped. `row` is one terminal row, already styled. */
export function showWhileRunning(
  streams: { stdout: NodeJS.WriteStream; stderr: NodeJS.WriteStream },
  row: () => string,
  timing: RunningTiming = TIMING,
): RunningFooter {
  const { stdout, stderr } = streams;
  const originals = new Map<NodeJS.WriteStream, Write>([[stdout, stdout.write], [stderr, stderr.write]]);
  const writeOut = stdout.write;
  let showing = false;
  // Whether the cursor sits at the start of a line: the prompt left it there.
  let lineStart = true;
  let quietSince = Date.now();

  const raw = (chunk: string): void => {
    writeOut.call(stdout, chunk);
  };
  const erase = (): void => {
    if (!showing) return;
    raw(`\r${ERASE_BELOW}${SHOW_CURSOR}`);
    showing = false;
  };
  const draw = (): void => {
    raw(`${HIDE_CURSOR}\r${row()}${ERASE_LINE}\r`);
    showing = true;
  };

  const wrapped = new Map<NodeJS.WriteStream, Write>();
  for (const [stream, original] of originals) {
    const intercepted = (...args: Parameters<Write>): boolean => {
      erase();
      // A write of controls only (cursor moves, colours) leaves the line where it was.
      const tail = text(args[0]).replace(TRAILING_CONTROLS, "");
      if (tail !== "") lineStart = /[\r\n]$/.test(tail);
      quietSince = Date.now();
      return (original as (...a: Parameters<Write>) => boolean).apply(stream, args);
    };
    wrapped.set(stream, intercepted as Write);
    stream.write = intercepted as Write;
  }

  const timer = setInterval(() => {
    if (showing || (lineStart && Date.now() - quietSince >= timing.after)) draw();
  }, timing.tick);
  timer.unref?.();

  return {
    stop() {
      clearInterval(timer);
      erase();
      for (const [stream, original] of originals) {
        if (stream.write === wrapped.get(stream)) stream.write = original;
      }
    },
  };
}
