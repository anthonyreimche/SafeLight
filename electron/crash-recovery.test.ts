// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The decision logic behind mid-session GPU/renderer crash recovery
// (crash-recovery.cjs). The wiring in main.cjs reloads windows when these say
// so; the reported failure mode is VirtualBox's virtual GL driver killing the
// GPU process after a heavy import, leaving a black-but-draggable window.

import { describe, it, expect } from "vitest";
import { isRuntimeGpuCrash, isRendererCrash, createRecoveryGate } from "./crash-recovery.cjs";

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

    expect(gate.tryRecover()).toBe(true); // first crash recovers immediately
    t += 5_000;
    expect(gate.tryRecover()).toBe(false); // too soon — no reload storm
    t += 5_000;
    expect(gate.tryRecover()).toBe(true);
    t += 10_000;
    expect(gate.tryRecover()).toBe(true);
    t += 10_000;
    expect(gate.tryRecover()).toBe(false); // session budget of 3 spent
  });

  it("denied attempts consume neither budget nor the debounce clock", () => {
    let t = 0;
    const gate = createRecoveryGate({ max: 2, minIntervalMs: 10_000, now: () => t });
    expect(gate.tryRecover()).toBe(true);
    t += 1_000;
    expect(gate.tryRecover()).toBe(false);
    t += 9_000; // 10s after the successful recovery, not the denied one
    expect(gate.tryRecover()).toBe(true);
  });
});
