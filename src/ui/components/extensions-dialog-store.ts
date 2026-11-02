// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Open/close state of the Extensions window, and the deep links into it. Kept
// apart from the dialog so the store UI and Preferences can drive it without
// importing the component that renders them.

import { create } from "zustand";
import { useExtStoreUI } from "@/extensions/store-ui";

export const useExtensionsOpen = create<{ open: boolean }>(() => ({ open: false }));
export const openExtensions = () => useExtensionsOpen.setState({ open: true });
export const closeExtensions = () => useExtensionsOpen.setState({ open: false });
export const toggleExtensions = () =>
  useExtensionsOpen.setState((s) => ({ open: !s.open }));

/** Open the window on kit `kitId`'s page. Browse shows the store home until
 *  the kit has loaded, and stays there when the registry has no such kit. */
export function openExtensionsOnKit(kitId: string): void {
  const store = useExtStoreUI.getState();
  store.goHome();
  store.openKit(kitId);
  openExtensions();
}

/** Open the window on one extension's page: `selected` is a repo
 *  "owner/repo", or a built-in's id. A closed window opens on it rather than
 *  on the list. */
export function openExtensionsOn(selected: string): void {
  const store = useExtStoreUI.getState();
  store.goHome();
  if (useExtensionsOpen.getState().open) store.openDetail(selected);
  else useExtStoreUI.setState({ pendingDetail: selected });
  openExtensions();
}
