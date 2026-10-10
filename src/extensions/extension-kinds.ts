// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What each extension has been seen doing, kept across launches. A disabled
// extension registers nothing, so whether one that is off renders into photos
// can only come from what it registered while it ran. Saved layouts use this to
// switch only the extensions that add interface (panels, tools, themes) and
// never one that changes how a photo looks or exports.

/** "pixels": it has registered a processing stage, a display transform or an
 *  export processor at some point. "interface": it has run without doing so. */
export type ExtensionKind = "interface" | "pixels";

const KINDS_KEY = "sl_ext_kinds";

function readKinds(): Record<string, ExtensionKind> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KINDS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    return Object.fromEntries(
      Object.entries(raw).filter(
        (e): e is [string, ExtensionKind] => e[1] === "interface" || e[1] === "pixels",
      ),
    );
  } catch {
    return {};
  }
}

function writeKinds(kinds: Record<string, ExtensionKind>): void {
  try {
    localStorage.setItem(KINDS_KEY, JSON.stringify(kinds));
  } catch {}
}

/** The kind recorded for every extension seen running, by id. Look ids up
 *  with Object.hasOwn: "constructor" is as valid an id as any. */
export function extensionKinds(): Record<string, ExtensionKind> {
  return readKinds();
}

/** `id` has started. Keeps an earlier "pixels": an extension that renders into
 *  photos only some of the time is still one that does. */
export function noteExtensionRunning(id: string): void {
  const kinds = readKinds();
  if (Object.hasOwn(kinds, id)) return;
  writeKinds({ ...kinds, [id]: "interface" });
}

/** `id` registered something that renders into photos. */
export function noteRendersPixels(id: string): void {
  const kinds = readKinds();
  if (Object.hasOwn(kinds, id) && kinds[id] === "pixels") return;
  writeKinds({ ...kinds, [id]: "pixels" });
}

/** Drop what is known about `id` (it was uninstalled); a reinstall starts over. */
export function forgetExtension(id: string): void {
  const kinds = readKinds();
  if (!Object.hasOwn(kinds, id)) return;
  delete kinds[id];
  writeKinds(kinds);
}
