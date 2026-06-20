// Shared log capture for the Developer Tools extension. Patches the global
// console plus window error / unhandledrejection handlers so the Console and
// Issues tabs can replay them. Installed only while the extension is active and
// fully removed on deactivate — disabling the extension restores the pristine
// console (the orchestrator rule: a disabled extension does no work).
//
// Entries are mirrored across windows over a BroadcastChannel, so the panel
// detached into its own OS window (see detach.ts) shows the main window's
// console too. Each window tags its entries with a per-window prefix so ids
// stay unique in the merged buffer.

import { create } from "zustand";

export type LogLevel =
  | "log"
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "exception" // uncaught error / unhandled rejection
  | "input" // a REPL command the user ran
  | "result"; // the value a REPL command returned

export interface LogEntry {
  /** Globally unique across windows: `${windowTag}-${counter}`. */
  id: string;
  level: LogLevel;
  /** Formatted argument strings, joined with spaces for display. */
  parts: string[];
  /** Stack trace for exceptions / errors, when available. */
  stack?: string;
  time: number;
}

const MAX_ENTRIES = 2000;

export const useDevLog = create<{ entries: LogEntry[] }>(() => ({
  entries: [],
}));

// ─── Cross-window mirroring ─────────────────────────────────────────────────

const LOG_CHANNEL = "safelight-devtools-log";
const WIN_TAG = Math.random().toString(36).slice(2, 8);
let nextId = 1;

type Wire =
  | { kind: "entry"; entry: LogEntry }
  | { kind: "sync-request" }
  | { kind: "sync-response"; entries: LogEntry[] };

let logChannel: BroadcastChannel | null = null;

/** Add entries to the store, de-duped by id and kept in time order. */
function ingest(input: LogEntry | LogEntry[]): void {
  const incoming = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (!incoming.length) return;
  useDevLog.setState((s) => {
    const have = new Set(s.entries.map((e) => e.id));
    const fresh = incoming.filter((e) => !have.has(e.id));
    if (!fresh.length) return s;
    const merged = [...s.entries, ...fresh].sort((a, b) => a.time - b.time);
    return {
      entries:
        merged.length > MAX_ENTRIES
          ? merged.slice(merged.length - MAX_ENTRIES)
          : merged,
    };
  });
}

/** Append a locally-captured entry and mirror it to other windows. */
export function pushEntry(
  level: LogLevel,
  parts: string[],
  stack?: string,
): void {
  const entry: LogEntry = {
    id: `${WIN_TAG}-${nextId++}`,
    level,
    parts,
    stack,
    time: Date.now(),
  };
  ingest(entry);
  logChannel?.postMessage({ kind: "entry", entry } satisfies Wire);
}

export function clearLog(): void {
  useDevLog.setState({ entries: [] });
}

// ─── Argument formatting ────────────────────────────────────────────────────

/** Render a single console argument to a compact, safe string. */
export function formatArg(value: unknown, depth = 0): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return value as string;
  if (t === "number" || t === "boolean" || t === "bigint") return String(value);
  if (t === "function") {
    const name = (value as { name?: string }).name;
    return `ƒ ${name || "anonymous"}()`;
  }
  if (t === "symbol") return (value as symbol).toString();
  if (value instanceof Error) {
    return value.stack || `${value.name}: ${value.message}`;
  }
  if (value instanceof Element) {
    const el = value as Element;
    const id = el.id ? `#${el.id}` : "";
    const cls = el.className && typeof el.className === "string"
      ? `.${el.className.trim().split(/\s+/).join(".")}`
      : "";
    return `<${el.tagName.toLowerCase()}${id}${cls}>`;
  }
  // Objects and arrays: depth-limited JSON with circular protection.
  if (depth > 2) return Array.isArray(value) ? "[…]" : "{…}";
  try {
    const seen = new WeakSet<object>();
    const json = JSON.stringify(
      value,
      (_k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return `${v}n`;
        if (typeof v === "function") return `ƒ ${v.name || "anonymous"}()`;
        return v;
      },
      0,
    );
    if (json === undefined) return String(value);
    return json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
  } catch {
    return String(value);
  }
}

const formatArgs = (args: unknown[]): string[] => args.map((a) => formatArg(a));

// ─── Install / uninstall ────────────────────────────────────────────────────

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
const PATCHED: ConsoleMethod[] = ["log", "info", "warn", "error", "debug"];

let installed = false;
const originals = new Map<ConsoleMethod, (...args: unknown[]) => void>();
let onError: ((e: ErrorEvent) => void) | null = null;
let onRejection: ((e: PromiseRejectionEvent) => void) | null = null;

export function isCaptureInstalled(): boolean {
  return installed;
}

export function installLogCapture(): void {
  if (installed) return;
  installed = true;

  // Mirror entries across windows and pull history from any peer already
  // capturing (so a freshly-detached window isn't blank).
  try {
    logChannel = new BroadcastChannel(LOG_CHANNEL);
    logChannel.onmessage = (e: MessageEvent<Wire>) => {
      const m = e.data;
      if (m.kind === "entry") ingest(m.entry);
      else if (m.kind === "sync-response") ingest(m.entries);
      else if (m.kind === "sync-request") {
        const cur = useDevLog.getState().entries;
        if (cur.length)
          logChannel?.postMessage({
            kind: "sync-response",
            entries: cur.slice(-500),
          } satisfies Wire);
      }
    };
    logChannel.postMessage({ kind: "sync-request" } satisfies Wire);
  } catch {
    logChannel = null;
  }

  for (const method of PATCHED) {
    const original = console[method].bind(console) as (...a: unknown[]) => void;
    originals.set(method, original);
    console[method] = (...args: unknown[]) => {
      try {
        pushEntry(method, formatArgs(args));
      } catch {
        /* never let capture break logging */
      }
      original(...args);
    };
  }

  onError = (e: ErrorEvent) => {
    const err = e.error instanceof Error ? e.error : null;
    pushEntry(
      "exception",
      [err ? `${err.name}: ${err.message}` : e.message || "Uncaught error"],
      err?.stack ?? (e.filename ? `at ${e.filename}:${e.lineno}:${e.colno}` : undefined),
    );
  };
  onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason;
    const err = r instanceof Error ? r : null;
    pushEntry(
      "exception",
      [`Unhandled rejection: ${err ? `${err.name}: ${err.message}` : formatArg(r)}`],
      err?.stack,
    );
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
}

export function uninstallLogCapture(): void {
  if (!installed) return;
  installed = false;
  for (const method of PATCHED) {
    const original = originals.get(method);
    if (original) console[method] = original;
  }
  originals.clear();
  if (onError) window.removeEventListener("error", onError);
  if (onRejection) window.removeEventListener("unhandledrejection", onRejection);
  onError = null;
  onRejection = null;
  logChannel?.close();
  logChannel = null;
}
