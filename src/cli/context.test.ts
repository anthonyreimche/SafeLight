import { describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/api/native-bridge";
import { DEFAULT_FACTORIES, createContext } from "./context";
import type { Output } from "./output/types";
import type { CliEnv, ExtensionService, ProjectRef, ProjectService, WriteSession } from "./types";

const env = { cwd: "/w", userData: "/u", appRoot: "/a", appVersion: "0", platform: "linux", isTTY: { stdin: false, stdout: false, stderr: false }, env: {} } as CliEnv;
const project: ProjectRef = { root: "/p", workingDir: "/p/.safelight", location: "in-folder" };

describe("dispose", () => {
  it("tells a write that is waiting for the lock to stop", async () => {
    let signal: AbortSignal | undefined;
    const projects = {
      find: async () => null,
      openRead: async () => { throw new Error("not used"); },
      openWrite: async (_ref: ProjectRef, _wait: number | null, s?: AbortSignal) => {
        signal = s;
        return { close: async () => undefined } as unknown as WriteSession;
      },
    } as ProjectService;
    const ctx = createContext(
      { env, out: {} as Output, json: false, verbosity: "normal", strict: false, yes: false, waitSeconds: null, stdin: process.stdin, bridge: {} as NativeFsBridge },
      { ...DEFAULT_FACTORIES, projects: () => projects },
    );
    await ctx.projects.openWrite(project, null);
    expect(signal?.aborted).toBe(false);
    await ctx.dispose();
    expect(signal?.aborted).toBe(true);
  });

  it("rolls back an install still waiting on its question", async () => {
    const abandon = vi.fn(async () => undefined);
    const ctx = createContext(
      { env, out: {} as Output, json: false, verbosity: "normal", strict: false, yes: false, waitSeconds: null, stdin: process.stdin, bridge: {} as NativeFsBridge },
      { ...DEFAULT_FACTORIES, extensions: () => ({ abandon } as unknown as ExtensionService) },
    );
    void ctx.extensions;
    await ctx.dispose();
    expect(abandon).toHaveBeenCalledOnce();
  });
});
