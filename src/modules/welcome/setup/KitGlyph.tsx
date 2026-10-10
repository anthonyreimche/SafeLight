// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Kit icons drawn by the app, picked by name from kits.json. A remote file
// never supplies markup or image URLs; an unknown name gets the puzzle piece.

import type { KitIcon } from "./kits";

const PATHS: Record<KitIcon | "puzzle", string[]> = {
  film: ["M4 5h16v14H4z", "M8 5v14", "M16 5v14", "M4 9h4", "M4 15h4", "M16 9h4", "M16 15h4"],
  palette: [
    "M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.9-.7-1.4-.7-2.2 0-.9.7-1.6 1.6-1.6H17a4 4 0 0 0 4-4c0-4.7-4-8.6-9-8.6z",
    "M7.5 11.5h.01",
    "M10 7.5h.01",
    "M14.5 7.5h.01",
  ],
  detail: ["M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z", "M20 20l-4-4"],
  organise: ["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"],
  speed: ["M13 3L5 14h6l-1 7 8-11h-6l1-7z"],
  import: ["M12 3v12", "M7 10l5 5 5-5", "M4 17v3h16v-3"],
  style: ["M4 20c3 0 5-2 5-5l9-9a2.1 2.1 0 0 0-3-3l-9 9c-3 0-5 2-5 5"],
  puzzle: [
    "M9 4h3a2 2 0 1 1 4 0h3v5a2 2 0 1 1 0 4v6h-6a2 2 0 1 0-4 0H4v-6a2 2 0 1 0 0-4V4z",
  ],
};

export function KitGlyph({ icon }: { icon: KitIcon | null }) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[icon ?? "puzzle"].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
