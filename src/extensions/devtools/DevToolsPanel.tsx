// Developer Tools panel — a tabbed in-app inspector. Registered by the
// (disabled-by-default) "core.devtools" extension and opened from the View
// menu. Tabs: Console, Issues, System, Storage, Native. Nothing here runs
// unless the extension is enabled, which installs the log capture.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLog,
  formatArg,
  pushEntry,
  useDevLog,
  type LogEntry,
  type LogLevel,
} from "./log-capture";

type Tab = "Console" | "Issues" | "System" | "Storage" | "Native";
const TABS: Tab[] = ["Console", "Issues", "System", "Storage", "Native"];

const LEVEL_STYLE: Record<LogLevel, string> = {
  log: "text-text-primary",
  info: "text-sky-400",
  debug: "text-text-muted",
  warn: "text-amber-400",
  error: "text-red-400",
  exception: "text-red-400",
  input: "text-accent",
  result: "text-emerald-400",
};
const LEVEL_GLYPH: Record<LogLevel, string> = {
  log: "",
  info: "ⓘ",
  debug: "",
  warn: "▲",
  error: "✕",
  exception: "✕",
  input: "›",
  result: "‹",
};

export function DevToolsPanel() {
  const [tab, setTab] = useState<Tab>("Console");
  const entries = useDevLog((s) => s.entries);
  const issueCount = useMemo(
    () => entries.filter((e) => e.level === "warn" || e.level === "error" || e.level === "exception").length,
    [entries],
  );

  return (
    <div className="flex h-[420px] flex-col text-[11px]">
      {/* Tab strip */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border-subtle bg-surface-2 px-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`relative px-2.5 py-1.5 tracking-wide transition-colors ${
              tab === t
                ? "text-text-primary"
                : "text-text-muted hover:text-text-secondary"
            }`}
          >
            {t}
            {t === "Issues" && issueCount > 0 && (
              <span className="ml-1 rounded-full bg-red-500/80 px-1 text-[9px] text-white">
                {issueCount > 999 ? "999+" : issueCount}
              </span>
            )}
            {tab === t && (
              <span className="absolute inset-x-1.5 -bottom-px h-0.5 rounded bg-accent" />
            )}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === "Console" && <ConsoleTab entries={entries} />}
        {tab === "Issues" && <ConsoleTab entries={entries} issuesOnly />}
        {tab === "System" && <SystemTab />}
        {tab === "Storage" && <StorageTab />}
        {tab === "Native" && <NativeTab />}
      </div>
    </div>
  );
}

// ─── Console / Issues ───────────────────────────────────────────────────────

const ALL_LEVELS: LogLevel[] = ["log", "info", "warn", "error", "debug"];

function ConsoleTab({
  entries,
  issuesOnly = false,
}: {
  entries: LogEntry[];
  issuesOnly?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<Set<LogLevel>>(new Set(ALL_LEVELS));
  const [autoscroll, setAutoscroll] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries.filter((e) => {
      if (issuesOnly) {
        if (e.level !== "warn" && e.level !== "error" && e.level !== "exception")
          return false;
      } else if (
        !levels.has(e.level as LogLevel) &&
        e.level !== "exception" &&
        e.level !== "input" &&
        e.level !== "result"
      ) {
        return false;
      }
      if (q && !e.parts.join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [entries, filter, levels, issuesOnly]);

  useEffect(() => {
    if (autoscroll && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [shown.length, autoscroll]);

  const toggleLevel = (l: LogLevel) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border-subtle px-2 py-1.5">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          className="min-w-0 flex-1 rounded bg-surface-2 px-2 py-1 text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3"
        />
        {!issuesOnly &&
          ALL_LEVELS.map((l) => (
            <button
              key={l}
              onClick={() => toggleLevel(l)}
              title={`Toggle ${l}`}
              className={`rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${
                levels.has(l)
                  ? `bg-surface-3 ${LEVEL_STYLE[l]}`
                  : "bg-surface-1 text-text-muted opacity-50"
              }`}
            >
              {l}
            </button>
          ))}
        <button
          onClick={() => setAutoscroll((v) => !v)}
          title="Autoscroll to newest"
          className={`rounded px-1.5 py-0.5 text-[12px] leading-none ${
            autoscroll ? "text-accent" : "text-text-muted"
          }`}
        >
          ↓
        </button>
        <button
          onClick={clearLog}
          title="Clear log"
          className="rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
        >
          🗑
        </button>
      </div>

      {/* Log list */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto font-mono">
        {shown.length === 0 ? (
          <div className="px-3 py-4 text-center text-text-muted">
            {issuesOnly ? "No warnings or errors." : "No console output yet."}
          </div>
        ) : (
          shown.map((e) => {
            const text = e.parts.join(" ");
            const hasStack = !!e.stack;
            const isOpen = expanded === e.id;
            return (
              <div
                key={e.id}
                onClick={() => hasStack && setExpanded(isOpen ? null : e.id)}
                className={`flex gap-1.5 border-b border-border-subtle/50 px-2 py-1 ${
                  e.level === "error" || e.level === "exception"
                    ? "bg-red-500/5"
                    : e.level === "warn"
                      ? "bg-amber-500/5"
                      : ""
                } ${hasStack ? "cursor-pointer" : ""}`}
              >
                <span className={`w-3 shrink-0 text-center ${LEVEL_STYLE[e.level]}`}>
                  {LEVEL_GLYPH[e.level]}
                </span>
                <span className="shrink-0 text-text-muted">{clockTime(e.time)}</span>
                <div className="min-w-0 flex-1">
                  <span className={`whitespace-pre-wrap break-words ${LEVEL_STYLE[e.level]}`}>
                    {text}
                  </span>
                  {hasStack && isOpen && (
                    <pre className="mt-1 whitespace-pre-wrap break-words text-[10px] text-text-muted">
                      {e.stack}
                    </pre>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {!issuesOnly && <Repl />}
    </div>
  );
}

/** A best-effort REPL. Note: the Electron app shell ships a strict CSP without
 *  'unsafe-eval', so eval() is refused there — the error is surfaced inline and
 *  points the user at the Native tab's full DevTools console. */
function Repl() {
  const [code, setCode] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);

  const run = () => {
    const src = code.trim();
    if (!src) return;
    pushEntry("input", [src]);
    setHistory((h) => [...h, src]);
    setHi(-1);
    setCode("");
    try {
      // Indirect eval → runs in global scope.
      const result = (0, eval)(src); // eslint-disable-line no-eval
      pushEntry("result", [formatArg(result)]);
    } catch (err) {
      pushEntry(
        "exception",
        [err instanceof Error ? `${err.name}: ${err.message}` : formatArg(err)],
        err instanceof Error ? err.stack : undefined,
      );
    }
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    } else if (e.key === "ArrowUp" && history.length) {
      e.preventDefault();
      const idx = hi < 0 ? history.length - 1 : Math.max(0, hi - 1);
      setHi(idx);
      setCode(history[idx]);
    } else if (e.key === "ArrowDown" && hi >= 0) {
      e.preventDefault();
      const idx = hi + 1;
      if (idx >= history.length) {
        setHi(-1);
        setCode("");
      } else {
        setHi(idx);
        setCode(history[idx]);
      }
    }
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5 border-t border-border-subtle bg-surface-2 px-2 py-1">
      <span className="text-accent">›</span>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value)}
        onKeyDown={onKey}
        placeholder="Evaluate JavaScript…"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 bg-transparent font-mono text-text-primary outline-none placeholder:text-text-muted"
      />
    </div>
  );
}

// ─── System ─────────────────────────────────────────────────────────────────

interface SysRow {
  label: string;
  value: string;
}

function SystemTab() {
  const [rows, setRows] = useState<SysRow[]>([]);
  const [gpu, setGpu] = useState<Record<string, string> | null>(null);

  const collect = useCallback(async () => {
    const native = window.safelightNative;
    const out: SysRow[] = [];

    let appVersion = __APP_VERSION__;
    try {
      if (native?.appVersion) appVersion = await native.appVersion();
    } catch {
      /* keep build-time value */
    }
    out.push({ label: "App version", value: appVersion || "unknown" });
    out.push({
      label: "Runtime",
      value: native
        ? `Electron ${native.versions.electron} · Chromium ${native.versions.chrome}`
        : "Browser (no Electron bridge)",
    });
    out.push({ label: "Platform", value: native?.platform ?? navigator.platform });
    out.push({ label: "User agent", value: navigator.userAgent });
    out.push({ label: "Language", value: navigator.language });
    out.push({
      label: "Cross-origin isolated",
      value: String(crossOriginIsolated) + (crossOriginIsolated ? " (SharedArrayBuffer OK)" : " — RAW decode degraded"),
    });
    out.push({ label: "Hardware threads", value: String(navigator.hardwareConcurrency ?? "?") });
    out.push({
      label: "Screen",
      value: `${screen.width}×${screen.height} · DPR ${window.devicePixelRatio} · ${window.innerWidth}×${window.innerHeight} viewport`,
    });

    const gl = readWebGLInfo();
    if (gl) {
      out.push({ label: "WebGL vendor", value: gl.vendor });
      out.push({ label: "WebGL renderer", value: gl.renderer });
      out.push({ label: "GLSL version", value: gl.glsl });
      out.push({ label: "Max texture size", value: String(gl.maxTexture) });
    } else {
      out.push({ label: "WebGL", value: "unavailable" });
    }

    const mem = (performance as { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (mem) {
      out.push({
        label: "JS heap",
        value: `${mb(mem.usedJSHeapSize)} / ${mb(mem.jsHeapSizeLimit)} limit`,
      });
    }
    out.push({ label: "localStorage keys", value: String(localStorage.length) });

    setRows(out);

    if (native?.diagnostics?.gpuInfo) {
      try {
        setGpu(await native.diagnostics.gpuInfo());
      } catch {
        setGpu(null);
      }
    }
  }, []);

  useEffect(() => {
    void collect();
  }, [collect]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="flex items-center justify-between border-b border-border-subtle px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-widest text-text-muted">Environment</span>
        <button
          onClick={() => void collect()}
          className="rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
        >
          ↻ Refresh
        </button>
      </div>
      <table className="w-full">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-border-subtle/50 align-top">
              <td className="w-36 shrink-0 px-2 py-1 text-text-secondary">{r.label}</td>
              <td className="px-2 py-1 font-mono text-text-primary">
                <span className="break-all">{r.value}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {gpu && (
        <>
          <div className="border-b border-t border-border-subtle px-2 py-1.5 text-[10px] uppercase tracking-widest text-text-muted">
            GPU feature status
          </div>
          <table className="w-full">
            <tbody>
              {Object.entries(gpu).map(([k, v]) => (
                <tr key={k} className="border-b border-border-subtle/50">
                  <td className="w-36 px-2 py-1 text-text-secondary">{k}</td>
                  <td
                    className={`px-2 py-1 font-mono ${
                      /software|disabled|unavailable/i.test(v) ? "text-amber-400" : "text-emerald-400"
                    }`}
                  >
                    {v}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ─── Storage ────────────────────────────────────────────────────────────────

function StorageTab() {
  const [keys, setKeys] = useState<string[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const refresh = useCallback(() => {
    const all: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) all.push(k);
    }
    all.sort();
    setKeys(all);
  }, []);

  useEffect(refresh, [refresh]);

  const select = (k: string) => {
    setSel(k);
    setDraft(localStorage.getItem(k) ?? "");
  };
  const save = () => {
    if (sel == null) return;
    try {
      localStorage.setItem(sel, draft);
      refresh();
    } catch {
      /* quota / serialization */
    }
  };
  const remove = (k: string) => {
    localStorage.removeItem(k);
    if (sel === k) setSel(null);
    refresh();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-widest text-text-muted">
          localStorage · {keys.length} keys
        </span>
        <button
          onClick={refresh}
          className="rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
        >
          ↻
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-1/2 shrink-0 overflow-y-auto border-r border-border-subtle">
          {keys.map((k) => (
            <div
              key={k}
              onClick={() => select(k)}
              className={`group flex items-center justify-between gap-1 px-2 py-1 ${
                sel === k ? "bg-surface-3" : "hover:bg-surface-2"
              }`}
            >
              <span
                className={`min-w-0 flex-1 cursor-pointer truncate font-mono ${
                  k.startsWith("sl_") ? "text-text-primary" : "text-text-muted"
                }`}
                title={k}
              >
                {k}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  remove(k);
                }}
                title="Delete key"
                className="shrink-0 px-1 text-text-muted opacity-0 hover:text-red-400 group-hover:opacity-100"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-2">
          {sel == null ? (
            <div className="m-auto text-text-muted">Select a key to inspect.</div>
          ) : (
            <>
              <div className="mb-1 truncate font-mono text-text-secondary" title={sel}>
                {sel}
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                spellCheck={false}
                className="min-h-0 flex-1 resize-none rounded bg-surface-2 p-2 font-mono text-[10px] text-text-primary outline-none focus:bg-surface-3"
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button
                  onClick={() => navigator.clipboard?.writeText(draft)}
                  className="rounded bg-surface-3 px-2 py-1 text-text-secondary hover:text-text-primary"
                >
                  Copy
                </button>
                <button
                  onClick={save}
                  className="rounded bg-slider-fill px-2 py-1 font-medium text-white hover:opacity-80"
                >
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Native (Electron) ──────────────────────────────────────────────────────

type Metric = { type: string; pid: number; cpuPercent: number; memoryMB: number };

function NativeTab() {
  const native = window.safelightNative;
  const dt = native?.devtools;
  const [metrics, setMetrics] = useState<Metric[] | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadMetrics = useCallback(async () => {
    if (!native?.diagnostics?.metrics) return;
    try {
      setMetrics(await native.diagnostics.metrics());
    } catch {
      setMetrics(null);
    }
  }, [native]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  if (!native) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-text-muted">
        Native tools require the SafeLight desktop app. In a browser, use your
        browser's own DevTools (F12).
      </div>
    );
  }

  const act = async (fn: () => Promise<void> | undefined, label: string) => {
    try {
      await fn();
      setNote(null);
    } catch (e) {
      setNote(`${label} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const Btn = ({ onClick, children }: { onClick: () => void; children: React.ReactNode }) => (
    <button
      onClick={onClick}
      className="rounded bg-surface-3 px-2.5 py-1 text-text-secondary hover:bg-surface-4 hover:text-text-primary"
    >
      {children}
    </button>
  );

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="border-b border-border-subtle px-2 py-1.5 text-[10px] uppercase tracking-widest text-text-muted">
        Chrome DevTools
      </div>
      <div className="flex flex-wrap gap-1.5 p-2">
        {dt ? (
          <>
            <Btn onClick={() => void act(() => dt.open("detach"), "Open DevTools")}>Open ⧉</Btn>
            <Btn onClick={() => void act(() => dt.open("bottom"), "Dock bottom")}>Dock ▾</Btn>
            <Btn onClick={() => void act(() => dt.toggle(), "Toggle")}>Toggle</Btn>
            <Btn onClick={() => void act(() => dt.close(), "Close")}>Close</Btn>
          </>
        ) : (
          <span className="text-text-muted">
            DevTools control unavailable (older desktop build).
          </span>
        )}
      </div>

      <div className="border-b border-t border-border-subtle px-2 py-1.5 text-[10px] uppercase tracking-widest text-text-muted">
        Renderer
      </div>
      <div className="flex flex-wrap gap-1.5 p-2">
        <Btn onClick={() => (dt ? void act(() => dt.reload(false), "Reload") : location.reload())}>
          Reload
        </Btn>
        {dt && <Btn onClick={() => void act(() => dt.reload(true), "Hard reload")}>Hard reload</Btn>}
      </div>

      <div className="flex items-center justify-between border-b border-t border-border-subtle px-2 py-1.5">
        <span className="text-[10px] uppercase tracking-widest text-text-muted">Process metrics</span>
        <button
          onClick={() => void loadMetrics()}
          className="rounded px-1.5 py-0.5 text-text-muted hover:text-text-primary"
        >
          ↻
        </button>
      </div>
      {metrics ? (
        <table className="w-full font-mono">
          <thead>
            <tr className="text-text-muted">
              <th className="px-2 py-1 text-left font-normal">Process</th>
              <th className="px-2 py-1 text-right font-normal">PID</th>
              <th className="px-2 py-1 text-right font-normal">CPU %</th>
              <th className="px-2 py-1 text-right font-normal">Memory</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.pid} className="border-t border-border-subtle/50">
                <td className="px-2 py-1 text-text-primary">{m.type}</td>
                <td className="px-2 py-1 text-right text-text-secondary">{m.pid}</td>
                <td className="px-2 py-1 text-right text-text-secondary">{m.cpuPercent.toFixed(1)}</td>
                <td className="px-2 py-1 text-right text-text-secondary">{m.memoryMB.toFixed(0)} MB</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="px-2 py-2 text-text-muted">Metrics unavailable (older desktop build).</div>
      )}

      {note && <div className="px-2 py-2 text-amber-400">{note}</div>}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────────

function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

function readWebGLInfo(): {
  vendor: string;
  renderer: string;
  glsl: string;
  maxTexture: number;
} | null {
  try {
    const canvas = document.createElement("canvas");
    const gl = (canvas.getContext("webgl2") ||
      canvas.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return null;
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const vendor = dbg
      ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL))
      : String(gl.getParameter(gl.VENDOR));
    const renderer = dbg
      ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL))
      : String(gl.getParameter(gl.RENDERER));
    return {
      vendor,
      renderer,
      glsl: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION)),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
    };
  } catch {
    return null;
  }
}
