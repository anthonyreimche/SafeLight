// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The top bar's word that installed extensions were turned off because one
// that replaces them is installed (its manifest's `supersedes`). They stay
// installed; Manage extensions opens the one turned off, to turn it back on.

import {
  dismissSupersededNotes,
  useSupersededNotes,
  type SupersededNote,
} from "@/extensions/supersedes";
import { openExtensions, openExtensionsOn } from "./extensions-dialog-store";
import { DismissButton } from "./DismissButton";

const listed = (names: string[]): string =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** One sentence per extension that replaced others, in the order noted. */
function sentences(notes: SupersededNote[]): string[] {
  const bySuccessor = new Map<string, string[]>();
  for (const n of notes) bySuccessor.set(n.by, [...(bySuccessor.get(n.by) ?? []), n.name]);
  return [...bySuccessor].map(
    ([by, names]) => `${listed(names)} ${names.length === 1 ? "was" : "were"} disabled — replaced by ${by}.`,
  );
}

export function SupersededNotice() {
  const notes = useSupersededNotes((s) => s.notes);
  if (notes.length === 0) return null;
  const manage = () => {
    dismissSupersededNotes();
    if (notes.length === 1) openExtensionsOn(notes[0].id);
    else openExtensions();
  };
  return (
    <div role="status" className="flex items-center gap-2 text-[11px] text-text-secondary">
      <span className="text-text-primary">{sentences(notes).join(" ")}</span>
      <button
        onClick={manage}
        className="rounded border border-border px-2.5 py-1 text-[11px] text-text-primary hover:bg-surface-3"
      >
        Manage extensions
      </button>
      <DismissButton onClick={dismissSupersededNotes} />
    </div>
  );
}
