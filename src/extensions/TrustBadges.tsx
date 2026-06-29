// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared trust chips for the Extensions store — a green "Verified" mark for
// allowlisted repos and a red "Flagged unsafe" mark for banned ones. Kept in
// their own module so the browse list (ExtensionManagerPanel) and the detail
// page (ExtensionDetail) can both use them without a circular import.

/** Check chip for extensions on the human-reviewed allowlist. Green when the code
 *  in play matches what was reviewed; amber ("stale") when the current version is
 *  newer than the reviewed version, so the running code is past the review point.
 *  `iconOnly` drops the label (just the ✓/✓*) for tight spots like browse cards. */
export function VerifiedBadge({
  large,
  iconOnly,
  reviewedVersion,
  stale,
}: {
  large?: boolean;
  iconOnly?: boolean;
  reviewedVersion?: string;
  stale?: boolean;
}) {
  const color = stale
    ? "var(--color-label-amber, #c77f00)"
    : "var(--color-label-green, #27ae60)";
  const title = stale
    ? `A maintainer reviewed ${
        reviewedVersion ? `version ${reviewedVersion}` : "an earlier version"
      }, but the current version is newer and has NOT been reviewed — treat it as unverified. It still runs with full access.`
    : `A maintainer code-reviewed this extension${
        reviewedVersion ? ` at version ${reviewedVersion}` : " at a point in time"
      }. Not an endorsement or a guarantee of safety — it still runs with full access, and later updates may not be re-reviewed.`;
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-full font-medium ${
        iconOnly ? "px-1 py-px text-[10px]" : large ? "px-1.5 py-0.5 text-[10px]" : "px-1 py-px text-[9px]"
      }`}
      style={{
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
      }}
    >
      {iconOnly ? (stale ? "✓*" : "✓") : stale ? "✓ Verified*" : "✓ Verified"}
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
