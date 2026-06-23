// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared trust chips for the Extensions store — a green "Verified" mark for
// allowlisted repos and a red "Flagged unsafe" mark for banned ones. Kept in
// their own module so the browse list (ExtensionManagerPanel) and the detail
// page (ExtensionDetail) can both use them without a circular import.

/** Green check chip for extensions on the human-reviewed allowlist. `iconOnly`
 *  drops the "Verified" label (just the ✓) for tight spots like browse cards. */
export function VerifiedBadge({ large, iconOnly }: { large?: boolean; iconOnly?: boolean }) {
  return (
    <span
      title="Reviewed and verified by Safelight"
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full font-medium ${
        iconOnly ? "px-1 py-px text-[10px]" : large ? "px-1.5 py-0.5 text-[10px]" : "px-1 py-px text-[9px]"
      }`}
      style={{
        color: "var(--color-label-green, #27ae60)",
        background: "color-mix(in srgb, var(--color-label-green, #27ae60) 16%, transparent)",
      }}
    >
      {iconOnly ? "✓" : "✓ Verified"}
    </span>
  );
}

/** Red chip for banned extensions; `reason` is shown on hover. */
export function FlaggedBadge({ reason, large }: { reason: string; large?: boolean }) {
  return (
    <span
      title={reason}
      className={`inline-flex shrink-0 items-center rounded font-medium text-label-red ${
        large ? "px-1.5 py-0.5 text-[10px]" : "px-1 py-px text-[9px]"
      }`}
      style={{ background: "color-mix(in srgb, var(--color-label-red) 18%, transparent)" }}
    >
      Flagged unsafe
    </span>
  );
}
