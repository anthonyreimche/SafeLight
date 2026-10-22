// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Developer Tools ▸ Variables: every shared variable (api.variables) this
// window holds, with its writers, subscribers, value and recent history, plus
// an editor that writes through the same stale-write rule as any extension.

import { useMemo, useState, useSyncExternalStore } from "react";
import type { VariableWriter } from "../types";
import type { VariableHistoryItem, VariableInspection, VariableRegistry } from "../variables";
import { variableRegistry } from "../variables-host";

export const DEVTOOLS_WRITER = "core.devtools";
/** Characters of a value's JSON shown before it is cut off. */
const VALUE_DISPLAY_LIMIT = 200_000;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

function writerName(registry: VariableRegistry, w: VariableWriter): string {
  return `${w.extension} (${registry.windowName(w.window)})`;
}

export function VariablesTab({ registry = variableRegistry() }: { registry?: VariableRegistry }) {
  const count = useSyncExternalStore(registry.subscribeChanges, registry.changeCount);
  // `count` is the store's version: a new one means inspect() would differ.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const list = useMemo(() => registry.inspect(), [registry, count]);
  const [selected, setSelected] = useState<string | null>(null);
  const current = list.find((v) => v.snapshot.name === selected) ?? list[0] ?? null;

  if (!current)
    return (
      <div className="p-3 text-text-muted">
        No shared variables yet. Extensions create them with api.variables.register().
      </div>
    );

  return (
    <div className="flex h-full min-h-0">
      <ul aria-label="Variables" className="w-56 shrink-0 overflow-y-auto border-r border-border-subtle">
        {list.map((v) => {
          const name = v.snapshot.name;
          const problems = v.history.filter((h) => h.outcome !== "accepted").length;
          return (
            <li key={name}>
              <button
                type="button"
                onClick={() => setSelected(name)}
                aria-current={current.snapshot.name === name}
                className={`flex w-full flex-col px-2 py-1 text-left hover:bg-surface-3 ${
                  current.snapshot.name === name ? "bg-surface-3 text-text-primary" : "text-text-secondary"
                }`}
              >
                <span className="flex w-full items-center gap-1">
                  <span className="min-w-0 flex-1 truncate font-code">{name}</span>
                  <span className="shrink-0 text-text-muted">
                    rev {v.snapshot.revision.n} · {formatBytes(v.size)}
                  </span>
                  {problems > 0 && (
                    <span
                      aria-label={`${problems} refused or lost`}
                      className="shrink-0 rounded-full bg-amber-500/80 px-1 text-[9px] text-white"
                    >
                      {problems}
                    </span>
                  )}
                </span>
                <span className="block truncate text-text-muted">{writerName(registry, v.snapshot.writer)}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <VariableDetail key={current.snapshot.name} v={current} registry={registry} />
    </div>
  );
}

function VariableDetail({ v, registry }: { v: VariableInspection; registry: VariableRegistry }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const s = v.snapshot;
  const json = useMemo(() => JSON.stringify(s.value, null, 2), [s.value]);
  const shown =
    json.length > VALUE_DISPLAY_LIMIT
      ? `${json.slice(0, VALUE_DISPLAY_LIMIT)}\n… cut off: ${formatBytes(json.length)} of JSON`
      : json;
  const lastWrite = [...v.history].reverse().find((h) => h.outcome === "accepted");
  const devtools = registry.scoped(DEVTOOLS_WRITER);

  const startEdit = () => {
    const now = devtools.get(s.name); // what Save is checked against
    setDraft(JSON.stringify(now?.value ?? null, null, 2));
    setResult(null);
  };

  const save = () => {
    let value: unknown;
    try {
      value = JSON.parse(draft ?? "");
    } catch (err) {
      setResult(`Not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    const r = devtools.set(s.name, value);
    if (r.ok) {
      setDraft(null);
      setResult(`Saved as revision ${r.revision.n}.`);
    } else if (r.reason === "stale") {
      setResult(
        `${writerName(registry, r.current.writer)} changed it since you opened the editor. Cancel and edit again to start from the new value.`,
      );
    } else if (r.reason === "invalid") {
      setResult(`Refused: ${r.message}.`);
    } else {
      setResult("Refused: nobody has registered this variable.");
    }
  };

  const outcomeText = (h: VariableHistoryItem): string => {
    switch (h.outcome) {
      case "accepted":
        return "accepted";
      case "stale":
        return `refused: hadn't seen rev ${h.revision.n}${h.other ? ` by ${writerName(registry, h.other)}` : ""}`;
      case "invalid":
        return `refused: ${h.message ?? "not JSON data"}`;
      case "lost":
        return `lost to ${h.other ? writerName(registry, h.other) : "another window"}`;
    }
  };

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-2">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <dt className="text-text-muted">Name</dt>
        <dd className="font-code">{s.name}</dd>
        {s.description && (
          <>
            <dt className="text-text-muted">Description</dt>
            <dd>{s.description}</dd>
          </>
        )}
        <dt className="text-text-muted">Registered by</dt>
        <dd>{writerName(registry, s.registeredBy)}</dd>
        <dt className="text-text-muted">Last write</dt>
        <dd>
          {writerName(registry, s.writer)}, revision {s.revision.n}
          {lastWrite ? `, ${new Date(lastWrite.time).toLocaleTimeString()}` : ""}
        </dd>
        <dt className="text-text-muted">Subscribers here</dt>
        <dd>{v.subscribers.length > 0 ? v.subscribers.join(", ") : "none"}</dd>
      </dl>

      <details open>
        <summary className="cursor-pointer text-text-muted">Value</summary>
        <div className="my-1 flex items-center gap-2">
          {draft === null ? (
            <button type="button" onClick={startEdit} className="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary">
              Edit value
            </button>
          ) : (
            <>
              <button type="button" onClick={save} className="rounded px-1.5 py-0.5 text-accent hover:bg-surface-3">
                Save
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setResult(null);
                }}
                className="rounded px-1.5 py-0.5 text-text-secondary hover:bg-surface-3 hover:text-text-primary"
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {draft === null ? (
          <pre className="max-h-64 overflow-auto rounded bg-surface-2 p-1.5 font-code text-[10px]">{shown}</pre>
        ) : (
          <textarea
            aria-label="New value (JSON)"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="h-40 w-full rounded border border-border-subtle bg-surface-2 p-1.5 font-code text-[10px] text-text-primary"
          />
        )}
        {result && <p className="mt-1 text-text-secondary">{result}</p>}
      </details>

      <section>
        <div className="mb-1 text-text-muted">History (newest first)</div>
        <table className="w-full">
          <tbody>
            {[...v.history].reverse().map((h, i) => (
              <tr key={`${h.time}-${i}`} className={h.outcome === "accepted" ? "" : "text-amber-400"}>
                <td className="pr-2 align-top text-text-muted">{new Date(h.time).toLocaleTimeString()}</td>
                <td className="pr-2 align-top">{writerName(registry, h.writer)}</td>
                <td className="pr-2 align-top">rev {h.revision.n}</td>
                <td className="align-top">{outcomeText(h)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
