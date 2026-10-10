// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ExportResult } from "./export-image";

/** How many failed photos are named before the rest are only counted. */
const NAMED = 10;

/** The photos an export failed for a known reason, each named with that reason,
 *  shown under the export's result: the first few, then how many more. */
export function ExportFailureList({ failures }: { failures: ExportResult["failures"] }) {
  if (!failures || failures.length === 0) return null;
  const more = failures.length - NAMED;
  return (
    <ul className="mt-1 text-[11px] text-text-secondary">
      {failures.slice(0, NAMED).map(({ filename, reason }, i) => (
        <li key={`${filename}-${i}`} className="truncate" title={`${filename}: ${reason}`}>
          {filename}: {reason}
        </li>
      ))}
      {more > 0 && <li>and {more} more.</li>}
    </ul>
  );
}
