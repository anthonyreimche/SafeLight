// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useDevelopStore } from "@/state/develop-store";
import { usesSignedOutput } from "@/catalog/types";

// Develop's status-bar view toggles, handed to the Develop module.

/** Toggle for ISO 12646 color assessment (also bound to a shortcut). */
export function AssessmentToggle() {
  const on = useDevelopStore((s) => s.colorAssessment);
  const toggle = useDevelopStore((s) => s.toggleColorAssessment);
  return (
    <button
      onClick={toggle}
      title="Color assessment (ISO 12646): white frame + middle-grey surround"
      aria-label="Toggle color assessment"
      aria-pressed={on}
      className={`text-[10px] ${on ? "text-text-primary" : "text-text-muted hover:text-text-primary"}`}
    >
      Assess
    </button>
  );
}

/** Toggle for the soft proof (also bound to a shortcut). Only a photo with the
 *  version 3 output stage has one, so only it shows the button. */
export function ProofToggle() {
  const signed = useDevelopStore((s) => usesSignedOutput(s.params));
  const on = useDevelopStore((s) => s.proof);
  const toggle = useDevelopStore((s) => s.toggleProof);
  if (!signed) return null;
  return (
    <button
      onClick={toggle}
      title="Soft proof (S): preview the export color space"
      aria-label="Toggle soft proof"
      aria-pressed={on}
      className={`text-[10px] ${on ? "text-text-primary" : "text-text-muted hover:text-text-primary"}`}
    >
      Proof
    </button>
  );
}
