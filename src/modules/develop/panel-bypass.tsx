// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { DEFAULT_DEVELOP_PARAMS, type DevelopParams } from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";

// Per-panel bypass: which DevelopParams keys each adjustment panel governs.
// Toggling a panel "off" renders with these keys reset to their factory
// defaults — without mutating the stored edit — so the user can see the panel's
// before/after. Nested params (vignette, grain, colorGrading, hsl, toneCurve,
// lensCorrection) reset as whole sub-objects; array-valued params (masks,
// retouch) reset to []. The renderer re-derives all of its uniforms/textures
// from these each frame (e.g. an empty masks array yields uMaskCount = 0; an
// "off" lensCorrection forces the lens uniforms and auto-crop scale to neutral),
// so clearing them here is a complete, side-effect-free bypass with no shader or
// renderer changes.
//
// Crop & Straighten and Transform are intentionally excluded: the crop rect is
// authored relative to the *transformed* frame, so neutralizing one without the
// other reframes the image (and the interactive crop overlay reads the unbypassed
// edit, so it would desync). Those are framing tools, not tonal adjustments.
export const PANEL_BYPASS_KEYS: Record<string, (keyof DevelopParams)[]> = {
  "White Balance": ["temperature", "tint"],
  Basic: [
    "exposure", "contrast", "highlights", "shadows", "whites", "blacks",
    "texture", "clarity", "dehaze", "vibrance", "saturation",
  ],
  "Tone Curve": ["toneCurve"],
  "Color Grading": ["colorGrading"],
  Detail: [
    "sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking",
    "luminanceNR", "luminanceNRDetail", "luminanceNRContrast",
    "luminanceNRShadows", "luminanceNRHighlights",
    "colorNR", "colorNRDetail", "colorNRSmoothness",
  ],
  "Lens Correction": ["lensCorrection"],
  Effects: ["vignette", "grain"],
  HSL: ["hsl"],
  Masking: ["masks"],
  Heal: ["retouch"],
};

// Return a copy of `params` with every bypassed panel's keys reset to factory
// defaults. Returns the same object when nothing is bypassed (cheap no-op for
// the common case).
export function applyPanelBypass(
  params: DevelopParams,
  bypassed: Record<string, boolean>,
): DevelopParams {
  const titles = Object.keys(bypassed).filter(
    (t) => bypassed[t] && PANEL_BYPASS_KEYS[t],
  );
  if (titles.length === 0) return params;
  const next = { ...params } as unknown as Record<string, unknown>;
  const defaults = DEFAULT_DEVELOP_PARAMS as unknown as Record<string, unknown>;
  for (const t of titles) {
    for (const k of PANEL_BYPASS_KEYS[t]) {
      next[k] = structuredClone(defaults[k]);
    }
  }
  return next as unknown as DevelopParams;
}

// Eye toggle shown in an adjustment panel's header. Open eye = panel active;
// slashed eye = bypassed (rendered as if neutral). View-only and per-window —
// it never touches the saved edit or history, so slider values survive toggling.
export function PanelBypassButton({ title }: { title: string }) {
  const bypassed = useDevelopStore((s) => !!s.bypassedPanels[title]);
  const toggle = useDevelopStore((s) => s.togglePanelBypass);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        toggle(title);
      }}
      aria-pressed={bypassed}
      title={bypassed ? `${title} bypassed — click to enable` : `Bypass ${title}`}
      className={
        bypassed
          ? "text-text-muted hover:text-text-secondary"
          : "text-text-secondary hover:text-text-primary"
      }
    >
      {bypassed ? (
        // eye-off
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
          <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
          <path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
          <line x1="2" y1="2" x2="22" y2="22" />
        </svg>
      ) : (
        // eye
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      )}
    </button>
  );
}
