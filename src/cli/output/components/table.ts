// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Columns for the designed look: cells are measured without their styling,
// so colour never moves a column. No rules and no header: the gap is the
// border.

import { cells } from "../width";

export interface GridColumn {
  align?: "left" | "right";
  /** Spaces before this column; 3 unless set. */
  gap?: number;
}

/** Lays styled cells out in columns. A column that is empty in every row takes no room. */
export function grid(rows: readonly (readonly string[])[], columns: readonly GridColumn[] = []): string[] {
  const count = Math.max(0, ...rows.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, i) => Math.max(0, ...rows.map((row) => cells(row[i] ?? ""))));
  return rows.map((row) => {
    let line = "";
    let started = false;
    for (let i = 0; i < count; i++) {
      if (widths[i] === 0) continue;
      const text = row[i] ?? "";
      const pad = " ".repeat(widths[i] - cells(text));
      if (started) line += " ".repeat(columns[i]?.gap ?? 3);
      line += columns[i]?.align === "right" ? pad + text : text + pad;
      started = true;
    }
    return line.trimEnd();
  });
}
