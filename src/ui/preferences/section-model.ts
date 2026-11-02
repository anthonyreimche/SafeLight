// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Preferences window is data-driven: a list of sections grouped into
// "General" (core, each backed by a bespoke component) and "Extensions" (one per
// extension that registered settings, auto-rendered from its declarative fields).
//
// Two things feed the header search:
//   • `items` — the individual settings in a section (display label + the text
//     they're searchable by). The search results list shows these directly, each
//     tagged with its section, so a query surfaces specific settings and where
//     they live rather than a whole tab.
//   • `keywords` — extra section-level synonyms (e.g. "tone map", "plugins") that
//     match the section as a whole when no individual item label fits.

export type PrefGroup = "General" | "Extensions";

export interface PrefSetting {
  /** Display label shown in search results. */
  label: string;
  /** Lowercase text this setting matches against (label + hint + option labels). */
  terms: string;
}

export interface PrefSection {
  id: string;
  label: string;
  group: PrefGroup;
  items: PrefSetting[];
  keywords: string[];
  order?: number;
  render: (query: string) => React.ReactNode;
}

/** Build PrefSettings from a plain list of labels (core sections, no per-item hints). */
export const settings = (...labels: string[]): PrefSetting[] =>
  labels.map((label) => ({ label, terms: label.toLowerCase() }));

/** A section matches a (lowercased) query via its title, any setting, or a synonym. */
export const sectionMatches = (s: PrefSection, q: string): boolean =>
  s.label.toLowerCase().includes(q) ||
  s.items.some((it) => it.terms.includes(q)) ||
  s.keywords.some((k) => k.toLowerCase().includes(q));

/** One section's worth of search hits: the matching settings (empty = title/synonym match only). */
export interface SearchGroup {
  section: PrefSection;
  items: PrefSetting[];
}
