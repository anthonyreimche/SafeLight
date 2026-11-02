// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The decision logic behind mid-session GPU/renderer crash recovery
// (crash-recovery.cjs). The wiring in main.cjs reloads windows when these say
// so; the reported failure mode is VirtualBox's virtual GL driver killing the
// GPU process after a heavy import, leaving a black-but-draggable window.

import { describe, it, expect } from "vitest";
import {
  isRuntimeGpuCrash,
  isRendererCrash,
  createRecoveryGate,
  createCrashLog,
  isMainFrameLoadFailure,
  restartPrompt,
  RESTART,
} from "./crash-recovery.cjs";

describe("isRuntimeGpuCrash", () => {
  const gone = (type: string, reason: string) => ({ type, reason });

  it("recovers a GPU failure while a window is open", () => {
    expect(isRuntimeGpuCrash(gone("GPU", "crashed"), 1)).toBe(true);
    expect(isRuntimeGpuCrash(gone("GPU", "abnormal-exit"), 2)).toBe(true);
    expect(isRuntimeGpuCrash(gone("GPU", "launch-failed"), 1)).toBe(true);
  });

  it("leaves startup failures to the ANGLE fallback probe", () => {
    expect(isRuntimeGpuCrash(gone("GPU", "crashed"), 0)).toBe(false);
  });

  it("ignores clean exits and non-GPU processes", () => {
    expect(isRuntimeGpuCrash(gone("GPU", "clean-exit"), 1)).toBe(false);
    expect(isRuntimeGpuCrash(gone("Utility", "crashed"), 1)).toBe(false);
  });
});

describe("isRendererCrash", () => {
  it("recovers genuine renderer failures", () => {
    for (const reason of ["crashed", "oom", "abnormal-exit", "launch-failed", "integrity-failure"]) {
      expect(isRendererCrash({ reason })).toBe(true);
    }
  });

  it("ignores clean exits and external kills", () => {
    expect(isRendererCrash({ reason: "clean-exit" })).toBe(false);
    expect(isRendererCrash({ reason: "killed" })).toBe(false);
  });
});

describe("createRecoveryGate", () => {
  it("allows a bounded number of recoveries, spaced apart", () => {
    let t = 0;
    const gate = createRecoveryGate({ max: 3, minIntervalMs: 10_000, now: () => t });

    expect(gate.tryRecover()).toBe("ok"); // first crash recovers immediately
    t += 5_000;
    expect(gate.tryRecover()).toBe("debounced"); // too soon — no reload storm
    t += 5_000;
    expect(gate.tryRecover()).toBe("ok");
    t += 10_000;
    expect(gate.tryRecover()).toBe("ok");
    t += 10_000;
    expect(gate.tryRecover()).toBe("spent"); // session budget of 3 spent
  });

  it("denied attempts consume neither budget nor the debounce clock", () => {
    let t = 0;
    const gate = createRecoveryGate({ max: 2, minIntervalMs: 10_000, now: () => t });
    expect(gate.tryRecover()).toBe("ok");
    t += 1_000;
    expect(gate.tryRecover()).toBe("debounced");
    t += 9_000; // 10s after the successful recovery, not the denied one
    expect(gate.tryRecover()).toBe("ok");
  });

  // Two crashes in quick succession, or two windows dying together, are one
  // event, not a spent budget.
  it("tells a debounced attempt from a spent budget", () => {
    let t = 0;
    const gate = createRecoveryGate({ max: 1, minIntervalMs: 10_000, now: () => t });
    expect(gate.tryRecover()).toBe("ok");
    expect(gate.tryRecover()).toBe("spent");
    t += 20_000;
    expect(gate.tryRecover()).toBe("spent");
  });
});

describe("isMainFrameLoadFailure", () => {
  it("is a failed load of the window's own page", () => {
    expect(isMainFrameLoadFailure(-6, true)).toBe(true); // ERR_FILE_NOT_FOUND
    expect(isMainFrameLoadFailure(-2, true)).toBe(true); // ERR_FAILED
  });

  // ERR_ABORTED is a load another navigation replaced, such as the redirect
  // back to the app's index.
  it("ignores frames inside the page and replaced loads", () => {
    expect(isMainFrameLoadFailure(-6, false)).toBe(false);
    expect(isMainFrameLoadFailure(-3, true)).toBe(false);
  });
});

// Once reloading stops helping, the window would otherwise sit black or blank
// with nothing to say why and no way out but the task manager.
describe("restartPrompt", () => {
  it.each(["renderer", "gpu", "load"] as const)("offers Restart or Quit for %s", (kind) => {
    const prompt = restartPrompt(kind);
    expect(prompt.buttons).toEqual(["Restart", "Quit"]);
    expect(prompt.buttons[RESTART]).toBe("Restart");
    expect(prompt.defaultId).toBe(RESTART);
    expect(prompt.cancelId).toBe(1);
    expect(prompt.message).toMatch(/\S/);
    expect(prompt.detail).toMatch(/\S/);
  });

  // Only promise software when the next launch really draws in software.
  it("says the restart draws in software only when it will", () => {
    expect(restartPrompt("gpu", true).detail).toMatch(/software/);
    expect(restartPrompt("gpu", false).detail).not.toMatch(/software/);
    expect(restartPrompt("gpu").detail).not.toMatch(/software/);
  });

  it("says what went wrong", () => {
    expect(restartPrompt("renderer").message).toMatch(/keeps crashing/);
    expect(restartPrompt("gpu").message).toMatch(/graphics/i);
    expect(restartPrompt("load").message).toMatch(/load/);
  });
});

// Kept for Report an issue: the renderer reloads after a crash and loses its
// own memory, so the main process remembers what died this launch.
describe("createCrashLog", () => {
  it("records a crash with the time it happened", () => {
    const log = createCrashLog({ now: () => 42 });
    log.record("GPU", { type: "GPU", reason: "crashed", exitCode: 1 });
    expect(log.list()).toEqual([{ time: 42, process: "GPU", reason: "crashed", exitCode: 1 }]);
  });

  it("keeps a utility process's service name", () => {
    const log = createCrashLog({ now: () => 1 });
    log.record("Utility", { reason: "oom", exitCode: 3, name: "Audio Service" });
    expect(log.list()[0]).toMatchObject({ process: "Utility", name: "Audio Service" });
  });

  it("ignores clean exits", () => {
    const log = createCrashLog();
    log.record("renderer", { reason: "clean-exit", exitCode: 0 });
    expect(log.list()).toEqual([]);
  });

  it("keeps only the newest records", () => {
    let t = 0;
    const log = createCrashLog({ max: 2, now: () => ++t });
    for (const reason of ["crashed", "oom", "killed"]) log.record("renderer", { reason, exitCode: 1 });
    expect(log.list().map((c) => c.reason)).toEqual(["oom", "killed"]);
  });

  it("hands out copies", () => {
    const log = createCrashLog();
    log.record("GPU", { reason: "crashed", exitCode: 1 });
    log.list()[0].reason = "changed";
    expect(log.list()[0].reason).toBe("crashed");
  });
});
