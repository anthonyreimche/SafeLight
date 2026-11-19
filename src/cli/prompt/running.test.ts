import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { showWhileRunning } from "./running";

function streams() {
  const written: string[] = [];
  const make = (name: string) => {
    const stream = Object.assign(new PassThrough(), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream & PassThrough;
    stream.on("data", (chunk: Buffer) => written.push(`${name}:${chunk.toString()}`));
    return stream;
  };
  return { stdout: make("out"), stderr: make("err"), written, text: () => written.join("") };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TIMING = { after: 30, tick: 10 };

describe("the running footer", () => {
  it("shows after a quiet moment and goes when the command ends, putting write back", async () => {
    const s = streams();
    const write = s.stdout.write;
    const footer = showWhileRunning(s, () => "RUNNING", TIMING);
    await wait(10);
    expect(s.text()).not.toContain("RUNNING");
    await wait(40);
    expect(s.text()).toContain("RUNNING");
    footer.stop();
    expect(s.stdout.write).toBe(write);
    expect(s.text().endsWith("\r\x1b[J\x1b[?25h")).toBe(true);
  });

  it("lifts out of the way of what the command writes, on either stream", async () => {
    const s = streams();
    const footer = showWhileRunning(s, () => "RUNNING", TIMING);
    await wait(50);
    s.written.length = 0;
    s.stderr.write("warning\n");
    await wait(5);
    expect(s.written[0]).toBe("out:\r\x1b[J\x1b[?25h");
    expect(s.written[1]).toBe("err:warning\n");
    footer.stop();
  });

  it("stays down while a line is left open, as a question is", async () => {
    const s = streams();
    const footer = showWhileRunning(s, () => "RUNNING", TIMING);
    s.stderr.write("Sure? ");
    await wait(60);
    expect(s.text()).not.toContain("RUNNING");
    s.stderr.write("y\r\n");
    await wait(60);
    expect(s.text()).toContain("RUNNING");
    footer.stop();
  });

  it("can be stopped for good before the command ends", async () => {
    const s = streams();
    const footer = showWhileRunning(s, () => "RUNNING", TIMING);
    footer.stop();
    await wait(60);
    expect(s.text()).not.toContain("RUNNING");
  });
});
