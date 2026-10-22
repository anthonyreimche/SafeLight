// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorLogEntry } from "./error-log";

type ErrorLogModule = typeof import("./error-log");

const entry = (over: Partial<ErrorLogEntry>): ErrorLogEntry => ({
  id: "w-1",
  level: "error",
  message: "boom",
  time: 1000,
  count: 1,
  source: "main",
  ...over,
});

async function freshModule(): Promise<ErrorLogModule> {
  vi.resetModules();
  return import("./error-log");
}

const originalWarn = console.warn;
const originalError = console.error;
let uninstall: (() => void) | null = null;

beforeEach(() => {
  localStorage.clear();
  console.warn = vi.fn();
  console.error = vi.fn();
});

afterEach(() => {
  uninstall?.();
  uninstall = null;
  console.warn = originalWarn;
  console.error = originalError;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("appendEntry", () => {
  it("collapses a repeat of the last entry into a count with the newer time", async () => {
    const { appendEntry } = await freshModule();
    const list = appendEntry([entry({})], entry({ id: "w-2", time: 2000 }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "w-1", count: 2, time: 2000 });
  });

  it("keeps different messages apart", async () => {
    const { appendEntry } = await freshModule();
    const list = appendEntry([entry({})], entry({ id: "w-2", message: "other" }));
    expect(list.map((e) => e.id)).toEqual(["w-1", "w-2"]);
  });

  it("keeps only the newest entries past the cap", async () => {
    const { appendEntry } = await freshModule();
    let list: ErrorLogEntry[] = [];
    for (let i = 0; i < 5; i++) list = appendEntry(list, entry({ id: `w-${i}`, message: `m${i}` }), 3);
    expect(list.map((e) => e.message)).toEqual(["m2", "m3", "m4"]);
  });
});

describe("mergeLogs", () => {
  it("drops duplicate ids keeping the higher count, sorted by time", async () => {
    const { mergeLogs } = await freshModule();
    const merged = mergeLogs(
      [entry({ id: "a", time: 30 }), entry({ id: "b", time: 10, count: 1 })],
      [entry({ id: "b", time: 20, count: 4 }), entry({ id: "c", time: 5 })],
    );
    expect(merged.map((e) => [e.id, e.count])).toEqual([
      ["c", 1],
      ["b", 4],
      ["a", 1],
    ]);
  });
});

describe("parseStoredLog", () => {
  it("drops malformed entries and junk", async () => {
    const { parseStoredLog } = await freshModule();
    expect(parseStoredLog(null)).toEqual([]);
    expect(parseStoredLog("{not json")).toEqual([]);
    expect(parseStoredLog('{"a":1}')).toEqual([]);
    const good = entry({});
    const stored = JSON.stringify([good, { ...good, id: 7 }, { ...good, level: "nope" }, { ...good, count: 0 }, null]);
    expect(parseStoredLog(stored)).toEqual([good]);
  });
});

describe("summarizeArgs", () => {
  it("takes the stack from an Error argument without repeating its first line", async () => {
    const { summarizeArgs } = await freshModule();
    const err = new TypeError("bad thing");
    err.stack = "TypeError: bad thing\n    at f (app://bundle/a.js:1:2)";
    expect(summarizeArgs(["[render]", err])).toEqual({
      message: "[render] TypeError: bad thing",
      stack: "    at f (app://bundle/a.js:1:2)",
    });
  });

  it("formats other arguments", async () => {
    const { summarizeArgs } = await freshModule();
    expect(summarizeArgs(["count", 3, { a: 1 }])).toEqual({ message: 'count 3 {"a":1}' });
  });
});

describe("crashEntry", () => {
  it("gives the same id for the same crash", async () => {
    const { crashEntry } = await freshModule();
    const c = { time: 5, process: "GPU", reason: "crashed", exitCode: 1 };
    expect(crashEntry(c).id).toBe(crashEntry({ ...c }).id);
    expect(crashEntry(c)).toMatchObject({ level: "crash", message: "GPU process gone: crashed (exit 1)" });
  });
});

describe("recordError", () => {
  it("clips long messages and stacks", async () => {
    const { recordError, readErrorLog } = await freshModule();
    const stack = Array.from({ length: 30 }, (_, i) => `    at f${i} (a.js:1:${i})`).join("\n");
    recordError("error", "x".repeat(900), stack);
    const [e] = readErrorLog();
    expect(e.message.length).toBeLessThanOrEqual(500);
    expect(e.stack?.split("\n")).toHaveLength(10);
  });
});

describe("installErrorLog", () => {
  it("records warnings and errors and still passes them on", async () => {
    const { installErrorLog, readErrorLog } = await freshModule();
    const warnSpy = console.warn;
    uninstall = installErrorLog({ source: "main" });
    console.warn("[libraw] decode failed", 3);
    console.error("[render-worker]", "lost");
    expect(warnSpy).toHaveBeenCalledWith("[libraw] decode failed", 3);
    expect(readErrorLog().map((e) => [e.level, e.message, e.source])).toEqual([
      ["warn", "[libraw] decode failed 3", "main"],
      ["error", "[render-worker] lost", "main"],
    ]);
  });

  it("does not record log or info", async () => {
    const { installErrorLog, readErrorLog } = await freshModule();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    uninstall = installErrorLog({ source: "main" });
    console.log("hello");
    console.info("hi");
    expect(readErrorLog()).toEqual([]);
    log.mockRestore();
    info.mockRestore();
  });

  it("records uncaught errors and unhandled rejections", async () => {
    const { installErrorLog, readErrorLog } = await freshModule();
    uninstall = installErrorLog({ source: "main" });
    const err = new RangeError("out of range");
    window.dispatchEvent(new ErrorEvent("error", { error: err, message: err.message }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: "nope" });
    window.dispatchEvent(rejection);
    expect(readErrorLog().map((e) => [e.level, e.message])).toEqual([
      ["exception", "RangeError: out of range"],
      ["exception", "Unhandled rejection: nope"],
    ]);
  });

  it("ignores ResizeObserver loop errors", async () => {
    const { installErrorLog, readErrorLog } = await freshModule();
    uninstall = installErrorLog({ source: "main" });
    window.dispatchEvent(
      new ErrorEvent("error", { message: "ResizeObserver loop completed with undelivered notifications." }),
    );
    expect(readErrorLog()).toEqual([]);
  });

  it("keeps entries across a reload", async () => {
    const first = await freshModule();
    uninstall = first.installErrorLog({ source: "main" });
    console.error("before reload");
    first.flushErrorLog();
    uninstall();
    uninstall = null;
    const second = await freshModule();
    expect(second.readErrorLog().map((e) => e.message)).toEqual(["before reload"]);
  });

  it("writes the first entry of a burst at once and the rest a second later", async () => {
    vi.useFakeTimers();
    const { installErrorLog } = await freshModule();
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    uninstall = installErrorLog({ source: "main" });
    console.error("one");
    console.error("two");
    console.error("three");
    expect(setItem).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(setItem).toHaveBeenCalledTimes(2);
    setItem.mockRestore();
  });

  it("merges with entries another window saved", async () => {
    const { installErrorLog, readErrorLog, flushErrorLog, ERROR_LOG_KEY } = await freshModule();
    uninstall = installErrorLog({ source: "main" });
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify([entry({ id: "other-1", message: "from map", time: 1 })]));
    console.error("from main");
    flushErrorLog();
    const stored = JSON.parse(localStorage.getItem(ERROR_LOG_KEY) ?? "[]") as ErrorLogEntry[];
    expect(stored.map((e) => e.message)).toEqual(["from map", "from main"]);
    expect(readErrorLog().map((e) => e.message)).toEqual(["from map", "from main"]);
  });

  it("never breaks console.error when storage throws", async () => {
    const { installErrorLog } = await freshModule();
    const spy = console.error;
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    uninstall = installErrorLog({ source: "main" });
    expect(() => console.error("still works")).not.toThrow();
    expect(spy).toHaveBeenCalledWith("still works");
    setItem.mockRestore();
  });
});

describe("uninstalling", () => {
  it("restores the previous console method when on top", async () => {
    const { installErrorLog } = await freshModule();
    const before = console.error;
    const off = installErrorLog({ source: "main" });
    expect(console.error).not.toBe(before);
    off();
    expect(console.error).toBe(before);
  });

  it("leaves a later patch in place and stops recording", async () => {
    const { installErrorLog, readErrorLog } = await freshModule();
    const off = installErrorLog({ source: "main" });
    const below = console.error;
    const later = vi.fn((...a: unknown[]) => below(...a));
    console.error = later;
    off();
    expect(console.error).toBe(later);
    console.error("after");
    expect(later).toHaveBeenCalledWith("after");
    expect(readErrorLog()).toEqual([]);
  });
});

describe("clearErrorLog", () => {
  it("empties memory and storage", async () => {
    const { installErrorLog, readErrorLog, flushErrorLog, clearErrorLog, ERROR_LOG_KEY } = await freshModule();
    uninstall = installErrorLog({ source: "main" });
    console.error("gone soon");
    flushErrorLog();
    clearErrorLog();
    expect(readErrorLog()).toEqual([]);
    expect(localStorage.getItem(ERROR_LOG_KEY)).toBeNull();
  });

  it("follows a clear made in another window", async () => {
    const { installErrorLog, readErrorLog, ERROR_LOG_KEY } = await freshModule();
    uninstall = installErrorLog({ source: "main" });
    console.error("here");
    localStorage.removeItem(ERROR_LOG_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: ERROR_LOG_KEY, newValue: null }));
    expect(readErrorLog()).toEqual([]);
  });
});

describe("native crashes", () => {
  it("adds each crash once however often the list is imported", async () => {
    const { ingestNativeCrashes, readErrorLog } = await freshModule();
    const list = [{ time: 5, process: "GPU", reason: "crashed", exitCode: 1 }];
    ingestNativeCrashes(list);
    ingestNativeCrashes(list);
    expect(readErrorLog().map((e) => e.message)).toEqual(["GPU process gone: crashed (exit 1)"]);
  });

  it("keeps a cleared log clear of crashes the main process still remembers", async () => {
    const { ingestNativeCrashes, clearErrorLog, readErrorLog } = await freshModule();
    const old = [{ time: Date.now() - 1000, process: "GPU", reason: "crashed", exitCode: 1 }];
    ingestNativeCrashes(old);
    clearErrorLog();
    ingestNativeCrashes(old);
    expect(readErrorLog()).toEqual([]);
    const reloaded = await freshModule();
    reloaded.ingestNativeCrashes(old);
    expect(reloaded.readErrorLog()).toEqual([]);
    reloaded.ingestNativeCrashes([{ time: Date.now() + 1000, process: "GPU", reason: "oom", exitCode: 2 }]);
    expect(reloaded.readErrorLog().map((e) => e.message)).toEqual(["GPU process gone: oom (exit 2)"]);
  });

  it("pulls crashes from the main process", async () => {
    vi.stubGlobal("safelightNative", {
      diagnostics: {
        crashes: () => Promise.resolve([{ time: 9, process: "renderer", reason: "oom", exitCode: -1 }]),
      },
    });
    const { syncNativeCrashes, readErrorLog } = await freshModule();
    await syncNativeCrashes();
    expect(readErrorLog().map((e) => e.message)).toEqual(["renderer process gone: oom (exit -1)"]);
  });
});
