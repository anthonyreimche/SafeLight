// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
  if (typeof Element !== "undefined" && value instanceof Element) {
    const id = value.id ? `#${value.id}` : "";
    const cls = value.className && typeof value.className === "string"
      ? `.${value.className.trim().split(/\s+/).join(".")}`
      : "";
    return `<${value.tagName.toLowerCase()}${id}${cls}>`;
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
