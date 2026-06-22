// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared renderer for an extension's declarative settings fields. Used by the
// unified Preferences window (Extensions group) — one list per extension. Values
// persist per-extension via ext-settings and apply immediately
// (api.settings.onChange fires as you edit).
//
// Beyond rendering each SettingsField, this adds two things the standalone
// extension dialog never had:
//   • a per-field reset (↺), shown only when the value differs from the field's
//     declared default, and a left accent bar marking the same "differs" state;
//   • optional search: when `query` is set, non-matching fields are hidden and
//     the matched substring is highlighted in labels/hints.

import type { ReactNode } from "react";
import {
  getAllExtSettings,
  getExtSetting,
  setExtSetting,
  useExtSettings,
} from "./ext-settings";
import type { SettingsField } from "./types";

export const labelCls = "text-[10px] uppercase tracking-widest text-text-muted";
export const inputCls =
  "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3";

/** Terms a field is searchable by (label + hint + any option labels). */
function fieldTerms(f: SettingsField): string {
  const parts = [f.label, f.hint ?? ""];
  if (f.type === "select") parts.push(...f.options.map((o) => o.label));
  return parts.join(" ").toLowerCase();
}

export function fieldMatches(f: SettingsField, query: string): boolean {
  return !query || fieldTerms(f).includes(query);
}

/** Does any of this extension's fields match the query? (for nav filtering) */
export function anyFieldMatches(
  fields: SettingsField[],
  query: string,
): boolean {
  return !query || fields.some((f) => fieldMatches(f, query));
}

export function SettingsFieldList({
  extensionId,
  fields,
  query = "",
}: {
  extensionId: string;
  fields: SettingsField[];
  query?: string;
}) {
  useExtSettings((s) => s[extensionId]); // re-render on value changes
  const q = query.trim().toLowerCase();

  if (fields.length === 0) {
    return <GenericFields extensionId={extensionId} query={q} />;
  }

  const visible = fields.filter((f) => fieldMatches(f, q));
  if (visible.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-text-muted">
        No settings match “{query}”.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {visible.map((f) => (
        <FieldRow key={f.key} extensionId={extensionId} field={f} query={q} />
      ))}
    </div>
  );
}

// Highlight the matched substring of `text`. With no query it renders text as-is.
function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  if (!query) return text;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded bg-slider-fill/30 text-text-primary">
        {text.slice(i, i + query.length)}
      </mark>
      {text.slice(i + query.length)}
    </>
  );
}

// A field's left accent bar + (when differing from default) a reset button.
// Keeps a transparent bar on every row so layout doesn't jump.
function Row({
  differs,
  children,
}: {
  differs: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className="border-l-2 pl-2.5"
      style={{
        borderColor: differs ? "var(--color-slider-fill)" : "transparent",
      }}
    >
      {children}
    </div>
  );
}

function ResetButton({ onReset }: { onReset: () => void }) {
  return (
    <button
      onClick={onReset}
      title="Reset to default"
      className="rounded px-1 text-[10px] leading-none text-text-muted hover:text-text-primary"
    >
      ↺
    </button>
  );
}

function FieldRow({
  extensionId,
  field,
  query,
}: {
  extensionId: string;
  field: SettingsField;
  query: string;
}) {
  const set = (v: unknown) => setExtSetting(extensionId, field.key, v);
  const reset = () => set(field.default);
  const label = <Highlight text={field.label} query={query} />;

  if (field.type === "boolean") {
    const checked = getExtSetting(extensionId, field.key, field.default);
    const differs = checked !== field.default;
    return (
      <Row differs={differs}>
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-text-primary">
            {label}
            {differs && <ResetButton onReset={reset} />}
          </span>
          <button
            onClick={() => set(!checked)}
            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
              checked ? "bg-slider-fill" : "bg-surface-3"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                checked ? "left-3.5" : "left-0.5"
              }`}
            />
          </button>
        </div>
        <Hint text={field.hint} query={query} />
      </Row>
    );
  }

  if (field.type === "number") {
    const value = getExtSetting(extensionId, field.key, field.default);
    const differs = value !== field.default;
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const pct = ((value - min) / (max - min || 1)) * 100;
    return (
      <Row differs={differs}>
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center gap-1.5">
            <span className={labelCls}>{label}</span>
            {differs && <ResetButton onReset={reset} />}
          </span>
          <span className="text-[11px] text-text-primary">{value}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={field.step ?? 1}
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          className="sl-slider mt-2 w-full"
          style={{
            background: `linear-gradient(to right, var(--color-slider-fill) ${pct}%, var(--color-surface-3) ${pct}%)`,
          }}
        />
        <Hint text={field.hint} query={query} />
      </Row>
    );
  }

  if (field.type === "select") {
    const value = getExtSetting(extensionId, field.key, field.default);
    const differs = value !== field.default;
    return (
      <Row differs={differs}>
        <span className="inline-flex items-center gap-1.5">
          <span className={labelCls}>{label}</span>
          {differs && <ResetButton onReset={reset} />}
        </span>
        <select
          value={value}
          onChange={(e) => set(e.target.value)}
          className={`mt-1.5 ${inputCls}`}
        >
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Hint text={field.hint} query={query} />
      </Row>
    );
  }

  // string
  const value = getExtSetting(extensionId, field.key, field.default);
  const differs = value !== field.default;
  return (
    <Row differs={differs}>
      <span className="inline-flex items-center gap-1.5">
        <span className={labelCls}>{label}</span>
        {differs && <ResetButton onReset={reset} />}
      </span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={field.placeholder}
        spellCheck={false}
        className={`mt-1.5 ${inputCls}`}
      />
      <Hint text={field.hint} query={query} />
    </Row>
  );
}

function Hint({ text, query }: { text?: string; query?: string }) {
  if (!text) return null;
  return (
    <p className="mt-1 text-[10px] leading-relaxed text-text-muted">
      <Highlight text={text} query={query ?? ""} />
    </p>
  );
}

// Fallback for extensions that registered settings without declaring fields:
// list every stored value with a control matched to its type. No default is
// known here, so these rows have no reset / differs indicator.
function GenericFields({
  extensionId,
  query,
}: {
  extensionId: string;
  query: string;
}) {
  const values = getAllExtSettings(extensionId);
  const keys = Object.keys(values)
    .filter((k) => !query || k.toLowerCase().includes(query))
    .sort();
  if (keys.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-text-muted">
        {query ? `No settings match “${query}”.` : "This extension has no settings."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {keys.map((k) => (
        <GenericRow
          key={k}
          extensionId={extensionId}
          k={k}
          value={values[k]}
          query={query}
        />
      ))}
    </div>
  );
}

function GenericRow({
  extensionId,
  k,
  value,
  query,
}: {
  extensionId: string;
  k: string;
  value: unknown;
  query: string;
}) {
  const set = (v: unknown) => setExtSetting(extensionId, k, v);
  const key = <Highlight text={k} query={query} />;

  if (typeof value === "boolean") {
    return (
      <button
        onClick={() => set(!value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">{key}</span>
        <span
          className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
            value ? "bg-slider-fill" : "bg-surface-3"
          }`}
        >
          <span
            className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
              value ? "left-3.5" : "left-0.5"
            }`}
          />
        </span>
      </button>
    );
  }

  if (typeof value === "number") {
    return (
      <div>
        <div className={labelCls}>{key}</div>
        <input
          type="number"
          value={value}
          onChange={(e) => set(Number(e.target.value))}
          className={`mt-1.5 ${inputCls}`}
        />
      </div>
    );
  }

  if (typeof value === "string") {
    return (
      <div>
        <div className={labelCls}>{key}</div>
        <input
          value={value}
          onChange={(e) => set(e.target.value)}
          spellCheck={false}
          className={`mt-1.5 ${inputCls}`}
        />
      </div>
    );
  }

  // Arrays/objects: shown read-only — only the extension knows their shape.
  return (
    <div>
      <div className={labelCls}>{key}</div>
      <div className="mt-1.5 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-text-muted">
        {JSON.stringify(value)}
      </div>
    </div>
  );
}
