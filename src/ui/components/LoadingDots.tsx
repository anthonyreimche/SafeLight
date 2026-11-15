// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { reducedMotion } from "@/ui/reduced-motion";

export interface LoadingDotsProps {
  /** Text before the dots, such as "Loading". Read out as written; the dots are not. */
  label?: string;
}

/** An ellipsis whose dots step in turn, for status text of a wait with no known end.
 *  Under Reduce motion it is a still "…". */
export function LoadingDots({ label }: LoadingDotsProps) {
  if (reducedMotion()) return <span>{`${label ?? ""}…`}</span>;
  return (
    <span>
      {label}
      <span className="sl-dots" aria-hidden="true">
        <span>.</span>
        <span>.</span>
        <span>.</span>
      </span>
    </span>
  );
}
