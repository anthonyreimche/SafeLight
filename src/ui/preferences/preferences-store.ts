// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Open/close state of the Preferences window, driven from the top bar, the
// layout menu, the storage banner, extensions and the keyboard hook.

import { create } from "zustand";

export const usePreferencesStore = create<{ open: boolean; target?: string }>(
  () => ({ open: false }),
);
/** Open Preferences, optionally deep-linked to a section id (a core section's
 *  id or an extension id). */
export const openPreferences = (sectionId?: string) =>
  usePreferencesStore.setState({ open: true, target: sectionId });
export const closePreferences = () =>
  usePreferencesStore.setState({ open: false, target: undefined });
export const togglePreferences = () =>
  usePreferencesStore.setState((s) => ({ open: !s.open, target: undefined }));
