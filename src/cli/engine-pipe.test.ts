import { existsSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { enginePipePath, listenForEngine } from "./engine-pipe";

describe("enginePipePath", () => {
  it("names a Windows named pipe after the process and a random tag", () => {
    expect(enginePipePath("win32", 42, "ab12", "C:\\Temp")).toBe("\\\\.\\pipe\\safelight-engine-42-ab12");
  });

  it("puts a Unix socket in the temp folder elsewhere", () => {
    expect(enginePipePath("linux", 42, "ab12", "/tmp")).toBe("/tmp/safelight-engine-42-ab12.sock");
    expect(enginePipePath("darwin", 7, "ff", "/var/folders/x/T/")).toBe("/var/folders/x/T/safelight-engine-7-ff.sock");
  });

  it("gives a fresh path each call by default", () => {
    expect(enginePipePath()).not.toBe(enginePipePath());
  });
});

describe("listenForEngine", () => {
  it("accepts one connection, then stops listening", async () => {
    const pipe = await listenForEngine(enginePipePath());
    const first = connect(pipe.path);
    const accepted = await pipe.connection;
    accepted.write("hi\n");
    const got = await new Promise<string>((resolve) => first.once("data", (chunk) => resolve(String(chunk))));
    expect(got).toBe("hi\n");

    // Windows keeps the name while the first connection holds it, so a second
    // caller waits on a busy pipe instead of failing.
    const second = connect(pipe.path);
    const outcome = await new Promise<string>((resolve) => {
      second.once("error", () => resolve("refused"));
      second.once("connect", () => resolve("connected"));
      setTimeout(() => resolve("waiting"), 200);
    });
    expect(outcome).not.toBe("connected");
    second.destroy();
    first.destroy();
    accepted.destroy();
  });

  it("leaves no socket file behind once closed", async () => {
    if (process.platform === "win32") return;
    const path = enginePipePath(process.platform, process.pid, "test", tmpdir());
    const pipe = await listenForEngine(path);
    expect(existsSync(path)).toBe(true);
    pipe.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(existsSync(path)).toBe(false);
  });
});
