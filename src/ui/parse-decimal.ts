// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Typed-number parsing for text fields. Keyboards on de/fr/nl/pl/ru layouts
// type "," from the numpad, so either "," or "." is the decimal separator, but
// only one of them, once: "1,234.5" or "2.048" with a grouping meaning can't be
// told apart from a decimal, so a second separator makes the entry invalid.

const DECIMAL = /^[+-]?(\d+[.,]?\d*|[.,]\d+)$/;

/** The typed number, or NaN when the text isn't a plain decimal. */
export function parseDecimal(text: string): number {
  const t = text.trim();
  if (!DECIMAL.test(t)) return NaN;
  return Number(t.replace(",", "."));
}
