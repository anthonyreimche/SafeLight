// Settings dialog for one extension, opened with the ⚙ button in the
// Extensions panel. Renders the declarative fields the extension registered
// via api.registerSettings(); extensions that didn't register a dialog get a
// generic editor over whatever they stored with api.settings.set. Values
// persist per-extension and apply immediately (api.settings.onChange fires as
// you edit).

import { useRegistry } from "./registry";
import {
  getAllExtSettings,
  getExtSetting,
  setExtSetting,
  useExtSettings,
} from "./ext-settings";
import type { SettingsField } from "./types";

export function ExtensionSettingsDialog({
  extensionId,
  extensionName,
  onClose,
}: {
  extensionId: string;
  extensionName: string;
  onClose: () => void;
}) {
  const contrib = useRegistry((s) => s.settings[extensionId]);
  useExtSettings((s) => s[extensionId]); // re-render on value changes

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-[420px] max-w-[92vw] flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-2xl">
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-2 px-3">
          <span className="truncate text-[11px] font-semibold uppercase tracking-widest text-text-secondary">
            {contrib?.title ?? extensionName}
          </span>
          <button
            onClick={onClose}
            className="rounded px-1.5 text-[14px] leading-none text-text-muted hover:text-text-primary"
          >
            ×
          </button>
        </div>
        <div className="flex flex-col gap-4 overflow-y-auto p-4">
          {contrib && contrib.fields.length > 0 ? (
            contrib.fields.map((f) => (
              <FieldRow key={f.key} extensionId={extensionId} field={f} />
            ))
          ) : (
            <GenericFields extensionId={extensionId} />
          )}
        </div>
        <div className="flex h-9 shrink-0 items-center justify-end border-t border-border bg-surface-2 px-3">
          <span className="text-[10px] text-text-muted">
            Changes apply immediately
          </span>
        </div>
      </div>
    </div>
  );
}

const labelCls = "text-[10px] uppercase tracking-widest text-text-muted";
const inputCls =
  "w-full rounded bg-surface-2 px-2 py-1 text-[11px] text-text-primary outline-none placeholder:text-text-muted focus:bg-surface-3";

// Fallback for extensions without a registered dialog: list every stored
// value with a control matched to its type.
function GenericFields({ extensionId }: { extensionId: string }) {
  const values = getAllExtSettings(extensionId);
  const keys = Object.keys(values).sort();
  if (keys.length === 0) {
    return (
      <p className="text-[11px] leading-relaxed text-text-muted">
        This extension has no settings.
      </p>
    );
  }
  return (
    <>
      {keys.map((k) => (
        <GenericRow key={k} extensionId={extensionId} k={k} value={values[k]} />
      ))}
    </>
  );
}

function GenericRow({
  extensionId,
  k,
  value,
}: {
  extensionId: string;
  k: string;
  value: unknown;
}) {
  const set = (v: unknown) => setExtSetting(extensionId, k, v);

  if (typeof value === "boolean") {
    return (
      <button
        onClick={() => set(!value)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="text-[11px] text-text-primary">{k}</span>
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
        <div className={labelCls}>{k}</div>
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
        <div className={labelCls}>{k}</div>
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
      <div className={labelCls}>{k}</div>
      <div className="mt-1.5 truncate rounded bg-surface-2 px-2 py-1 text-[11px] text-text-muted">
        {JSON.stringify(value)}
      </div>
    </div>
  );
}

function FieldRow({
  extensionId,
  field,
}: {
  extensionId: string;
  field: SettingsField;
}) {
  const set = (v: unknown) => setExtSetting(extensionId, field.key, v);

  if (field.type === "boolean") {
    const checked = getExtSetting(extensionId, field.key, field.default);
    return (
      <div>
        <button
          onClick={() => set(!checked)}
          className="flex w-full items-center justify-between gap-3 text-left"
        >
          <span className="text-[11px] text-text-primary">{field.label}</span>
          <span
            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
              checked ? "bg-slider-fill" : "bg-surface-3"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                checked ? "left-3.5" : "left-0.5"
              }`}
            />
          </span>
        </button>
        <Hint text={field.hint} />
      </div>
    );
  }

  if (field.type === "number") {
    const value = getExtSetting(extensionId, field.key, field.default);
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const pct = ((value - min) / (max - min || 1)) * 100;
    return (
      <div>
        <div className="flex items-center justify-between">
          <span className={labelCls}>{field.label}</span>
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
        <Hint text={field.hint} />
      </div>
    );
  }

  if (field.type === "select") {
    const value = getExtSetting(extensionId, field.key, field.default);
    return (
      <div>
        <div className={labelCls}>{field.label}</div>
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
        <Hint text={field.hint} />
      </div>
    );
  }

  // string
  const value = getExtSetting(extensionId, field.key, field.default);
  return (
    <div>
      <div className={labelCls}>{field.label}</div>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder={field.placeholder}
        spellCheck={false}
        className={`mt-1.5 ${inputCls}`}
      />
      <Hint text={field.hint} />
    </div>
  );
}

function Hint({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <p className="mt-1 text-[10px] leading-relaxed text-text-muted">{text}</p>
  );
}
