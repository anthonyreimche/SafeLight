// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Always-on record of recent warnings, errors and crashes for Report an issue.
// Unlike the Developer Tools console (log-capture.ts, opt-in and in-memory),
// this keeps only what a bug report needs and survives a restart, so a
// crash-then-relaunch report still has the crash. It never leaves the machine
// on its own: the report dialog shows it and the user chooses to include it.
//
// Every window wraps its own console and saves into one shared localStorage
// list, merging by id so windows don't overwrite each other.

import { formatArg } from "./format-arg";
import type { NativeCrashRecord } from "@/extensions/types";

export type ErrorLevel = "warn" | "error" | "exception" | "crash";

export interface ErrorLogEntry {
  /** Unique across windows and launches. */
  id: string;
  level: ErrorLevel;
  message: string;
  stack?: string;
  time: number;
  /** How many times in a row this entry repeated. */
  count: number;
  /** The window that recorded it ("main", a detached module id, "devtools"),
   *  or "native" for main-process crash records. */
  source: string;
}

export const ERROR_LOG_KEY = "sl_error_log_v1";
// When the user last deleted the log: the main process still remembers this
// launch's crashes and would hand them back otherwise.
const CLEARED_KEY = "sl_error_log_cleared_v1";
export const ERROR_LOG_MAX = 150;

const LEVELS: ReadonlySet<string> = new Set<ErrorLevel>(["warn", "error", "exception", "crash"]);
const MAX_MESSAGE = 500;
const MAX_STACK_LINES = 10;
const MAX_STACK = 1500;
const SAVE_INTERVAL_MS = 1000;
const IGNORED = /^ResizeObserver loop/;

const RUN_TAG = Math.random().toString(36).slice(2, 8);
let nextId = 1;
let source = "main";
let memory: ErrorLogEntry[] = [];
let lastSave = 0;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

const sameEvent = (a: ErrorLogEntry, b: ErrorLogEntry): boolean =>
  a.level === b.level && a.message === b.message && a.stack === b.stack && a.source === b.source;

const newest = (list: ErrorLogEntry[], max: number): ErrorLogEntry[] =>
  list.length > max ? list.slice(list.length - max) : list;

export function appendEntry(
  list: readonly ErrorLogEntry[],
  next: ErrorLogEntry,
  max = ERROR_LOG_MAX,
): ErrorLogEntry[] {
  const last = list[list.length - 1];
  if (last && sameEvent(last, next)) {
    return [...list.slice(0, -1), { ...last, count: last.count + next.count, time: next.time }];
  }
  return newest([...list, next], max);
}

export function mergeLogs(
  a: readonly ErrorLogEntry[],
  b: readonly ErrorLogEntry[],
  max = ERROR_LOG_MAX,
): ErrorLogEntry[] {
  const byId = new Map<string, ErrorLogEntry>();
  for (const e of [...a, ...b]) {
    const have = byId.get(e.id);
    if (!have || e.count > have.count || (e.count === have.count && e.time > have.time)) byId.set(e.id, e);
  }
  return newest([...byId.values()].sort((x, y) => x.time - y.time), max);
}

function isEntry(v: unknown): v is ErrorLogEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === "string" &&
    typeof e.level === "string" &&
    LEVELS.has(e.level) &&
    typeof e.message === "string" &&
    (e.stack === undefined || typeof e.stack === "string") &&
    typeof e.time === "number" &&
    Number.isFinite(e.time) &&
    typeof e.count === "number" &&
    Number.isInteger(e.count) &&
    e.count > 0 &&
    typeof e.source === "string"
  );
}

/** Extensions share localStorage, so stored entries are checked field by field. */
export function parseStoredLog(raw: string | null): ErrorLogEntry[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? newest(parsed.filter(isEntry), ERROR_LOG_MAX) : [];
  } catch {
    return [];
  }
}

function framesOf(err: Error): string | undefined {
  const stack = err.stack;
  if (!stack) return undefined;
  const head = `${err.name}: ${err.message}`;
  const frames = stack.startsWith(head) ? stack.slice(head.length).replace(/^\n/, "") : stack;
  return frames || undefined;
}

export function summarizeArgs(args: readonly unknown[]): { message: string; stack?: string } {
  const err = args.find((a): a is Error => a instanceof Error);
  const message = args
    .map((a) => (a instanceof Error ? `${a.name}: ${a.message}` : formatArg(a)))
    .join(" ");
  const stack = err ? framesOf(err) : undefined;
  return stack ? { message, stack } : { message };
}

function clipStack(stack: string | undefined): string | undefined {
  if (!stack) return undefined;
  const lines = stack.split("\n").slice(0, MAX_STACK_LINES).join("\n");
  return lines.length > MAX_STACK ? lines.slice(0, MAX_STACK) : lines;
}

const clipMessage = (m: string): string =>
  m.length > MAX_MESSAGE ? `${m.slice(0, MAX_MESSAGE - 1)}…` : m;

export function crashEntry(c: NativeCrashRecord): ErrorLogEntry {
  const proc = c.name ? `${c.process} process (${c.name})` : `${c.process} process`;
  return {
    id: `native-${c.time}-${c.process}-${c.exitCode}`,
    level: "crash",
    message: `${proc} gone: ${c.reason} (exit ${c.exitCode})`,
    time: c.time,
    count: 1,
    source: "native",
  };
}

function readStored(): ErrorLogEntry[] {
  try {
    return parseStoredLog(localStorage.getItem(ERROR_LOG_KEY));
  } catch {
    return [];
  }
}

function save(): void {
  lastSave = Date.now();
  try {
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(mergeLogs(readStored(), memory)));
  } catch {
    /* storage full or blocked: the in-memory list still serves this session */
  }
}

function scheduleSave(): void {
  if (saveTimer !== null) return;
  const wait = lastSave + SAVE_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    save();
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    save();
  }, wait);
}

export function flushErrorLog(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  save();
}

export function recordError(level: ErrorLevel, message: string, stack?: string): void {
  const clipped = clipStack(stack);
  const next: ErrorLogEntry = {
    id: `${RUN_TAG}-${nextId++}`,
    level,
    message: clipMessage(message),
    ...(clipped ? { stack: clipped } : {}),
    time: Date.now(),
    count: 1,
    source,
  };
  memory = appendEntry(memory, next);
  scheduleSave();
}

function clearedAt(): number {
  try {
    return Number(localStorage.getItem(CLEARED_KEY)) || 0;
  } catch {
    return 0;
  }
}

export function ingestNativeCrashes(list: readonly NativeCrashRecord[]): void {
  const since = clearedAt();
  const fresh = list.filter((c) => c.time > since);
  if (fresh.length === 0) return;
  memory = mergeLogs(memory, fresh.map(crashEntry));
  scheduleSave();
}

export async function syncNativeCrashes(): Promise<void> {
  try {
    const list = await window.safelightNative?.diagnostics?.crashes?.();
    if (list) ingestNativeCrashes(list);
  } catch {
    /* an older main process without the channel */
  }
}

/** Saved and this window's unsaved entries, oldest first. */
export function readErrorLog(): ErrorLogEntry[] {
  return mergeLogs(readStored(), memory);
}

export function clearErrorLog(): void {
  memory = [];
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    localStorage.removeItem(ERROR_LOG_KEY);
    localStorage.setItem(CLEARED_KEY, String(Date.now()));
  } catch {
    /* storage blocked: nothing was saved either */
  }
}

type WrappedMethod = "warn" | "error";
let installed = false;

/** Starts recording in this window. The returned function stops it. The
 *  console wrappers chain to whatever was there before; boot installs them
 *  ahead of Developer Tools' capture, which then stacks on top and puts them
 *  back when it is turned off. */
export function installErrorLog(opts: { source: string }): () => void {
  if (installed) return () => {};
  installed = true;
  source = opts.source;
  let active = true;
  let busy = false;

  const restores = (["warn", "error"] as const).map((method: WrappedMethod) => {
    const prev = console[method];
    const wrapper = (...args: unknown[]): void => {
      if (active && !busy) {
        busy = true;
        try {
          const { message, stack } = summarizeArgs(args);
          recordError(method, message, stack);
        } catch {
          /* recording must never break logging */
        } finally {
          busy = false;
        }
      }
      prev.apply(console, args);
    };
    console[method] = wrapper;
    return () => {
      if (console[method] === wrapper) console[method] = prev;
    };
  });

  const onError = (e: ErrorEvent): void => {
    const err = e.error instanceof Error ? e.error : null;
    const message = err ? `${err.name}: ${err.message}` : e.message || "Uncaught error";
    if (IGNORED.test(message)) return;
    recordError(
      "exception",
      message,
      err ? framesOf(err) : e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : undefined,
    );
  };
  const onRejection = (e: PromiseRejectionEvent): void => {
    const r: unknown = e.reason;
    const err = r instanceof Error ? r : null;
    recordError(
      "exception",
      `Unhandled rejection: ${err ? `${err.name}: ${err.message}` : formatArg(r)}`,
      err ? framesOf(err) : undefined,
    );
  };
  const onStorage = (e: StorageEvent): void => {
    if (e.key === ERROR_LOG_KEY && e.newValue === null) memory = [];
  };
  const onPageHide = (): void => flushErrorLog();

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  window.addEventListener("storage", onStorage);
  window.addEventListener("pagehide", onPageHide);

  return () => {
    active = false;
    installed = false;
    for (const restore of restores) restore();
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("pagehide", onPageHide);
  };
}
