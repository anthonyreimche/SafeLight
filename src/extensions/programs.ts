// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.programs: a native program the person allowed an extension to run. On
// the desktop the main process asks, keeps the answer and runs the program
// (electron/program-access.cjs); the privileged bridge core holds names the
// calling extension, and every answer is read here as untrusted. The browser
// build has no bridge and so no program.

import type { KeptProgram, ProgramRunOptions, ProgramRunResult, ProgramsAPI } from "./api/programs";
import type { NativeProgramsBridge } from "./api/native-bridge";
import { privilegedPrograms } from "@/native/privileged";

/** run id → where that run's output goes. One bridge listener serves every
 *  run in flight. */
const listeners = new Map<string, (stream: "stdout" | "stderr", text: string) => void>();
let unsubscribe: (() => void) | null = null;

function listen(bridge: NativeProgramsBridge, runId: string, onOutput: (stream: "stdout" | "stderr", text: string) => void): () => void {
  listeners.set(runId, onOutput);
  unsubscribe ??= bridge.onOutput((event) => {
    if (typeof event.runId !== "string" || typeof event.text !== "string") return;
    if (event.stream !== "stdout" && event.stream !== "stderr") return;
    const target = listeners.get(event.runId);
    if (!target) return;
    try {
      target(event.stream, event.text);
    } catch (e) {
      console.warn("[programs] an onOutput callback threw:", e);
    }
  });
  return () => {
    listeners.delete(runId);
    if (listeners.size === 0) {
      unsubscribe?.();
      unsubscribe = null;
    }
  };
}

function keptOf(value: unknown): KeptProgram | null {
  if (!value || typeof value !== "object") return null;
  const { token, path, name } = value as Record<string, unknown>;
  return typeof token === "string" && token !== "" && typeof path === "string" && typeof name === "string" ? { token, path, name } : null;
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  return value instanceof ArrayBuffer ? new Uint8Array(value) : null;
}

function resultOf(answer: unknown): ProgramRunResult {
  if (!answer || typeof answer !== "object") throw new Error("Safelight gave an answer to the run that it can't read.");
  const { exitCode, killed, stdout, stderr, files } = answer as Record<string, unknown>;
  const out: Record<string, Uint8Array> = {};
  if (files && typeof files === "object")
    for (const [name, value] of Object.entries(files)) {
      const bytes = bytesOf(value);
      if (bytes) out[name] = bytes;
    }
  return {
    exitCode: typeof exitCode === "number" && Number.isInteger(exitCode) ? exitCode : null,
    killed: killed === "timeout" || killed === "cancelled" ? killed : null,
    stdout: typeof stdout === "string" ? stdout : "",
    stderr: typeof stderr === "string" ? stderr : "",
    files: out,
  };
}

async function runVia(bridge: NativeProgramsBridge, extensionId: string, token: string, args: string[], options: ProgramRunOptions): Promise<ProgramRunResult> {
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new TypeError("A program's arguments are a list of text.");
  const { signal, onOutput } = options;
  if (signal?.aborted) return { exitCode: null, killed: "cancelled", stdout: "", stderr: "", files: {} };
  // Random, not counted: main keeps one table of runs for every window.
  const runId = `${extensionId}#${crypto.randomUUID()}`;
  const unlisten = onOutput ? listen(bridge, runId, onOutput) : () => {};
  const onAbort = () => void bridge.cancel(runId);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    return resultOf(
      await bridge.run(extensionId, runId, token, args, {
        files: options.files,
        outputs: options.outputs,
        timeoutMs: options.timeoutMs,
        stream: !!onOutput,
      }),
    );
  } finally {
    signal?.removeEventListener("abort", onAbort);
    unlisten();
  }
}

/** The programs API of extension `extensionId`. */
export function programsAPI(extensionId: string): ProgramsAPI {
  return {
    pick: async (options) => {
      const programs = privilegedPrograms();
      if (!programs) return null;
      return keptOf(await programs.pick(extensionId, { title: options?.title, replacing: options?.replacing ?? null }));
    },
    locate: async (name) => {
      const programs = privilegedPrograms();
      return programs ? keptOf(await programs.locate(extensionId, String(name))) : null;
    },
    list: async () => {
      const found = (await privilegedPrograms()?.list(extensionId)) ?? [];
      return found.map(keptOf).filter((p): p is KeptProgram => p !== null);
    },
    forget: async (token) => {
      await privilegedPrograms()?.forget(extensionId, String(token));
    },
    run: async (token, args, options = {}) => {
      const programs = privilegedPrograms();
      if (!programs) throw new DOMException("Programs can only be run in the Safelight desktop app.", "NotSupportedError");
      return runVia(programs, extensionId, String(token), args, options);
    },
  };
}
