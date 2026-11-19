// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which running extensions may run other extensions' console commands: those
// whose manifest declares `"permissions": { "commands": true }`. A leaf, so the
// loaders can note it without importing api.commands.

const mayRun = new Set<string>();

/** Note whether `manifest`'s extension may run commands. The loaders call it
 *  with each manifest they start. */
export function noteCommandPermission(manifest: { id: string; permissions?: { commands?: boolean } }): void {
  if (manifest.permissions?.commands === true) mayRun.add(manifest.id);
  else mayRun.delete(manifest.id);
}

export const mayRunCommands = (extensionId: string): boolean => mayRun.has(extensionId);
