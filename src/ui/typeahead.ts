// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Type to jump, shared by the dropdown and the menus. Letters typed in quick
// succession build a prefix; pressing one letter again steps to the next label
// that starts with it, the way a native list does.

/** How long a pause starts a fresh prefix, in ms. */
const RESET_MS = 600;

type KeyLike = Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">;

/** A printable character that is not part of a shortcut chord. */
export function isTypeaheadKey(e: KeyLike): boolean {
  return e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;
}

export interface Typeahead {
  /** Index of the label the key moves to from `from`, or -1 for no match.
   *  `available` rules out entries (disabled options). */
  match(
    labels: readonly string[],
    key: string,
    from: number,
    now?: number,
    available?: (index: number) => boolean,
  ): number;
  /** Whether a prefix is still being typed, so a space belongs to it. */
  active(now?: number): boolean;
}

export function createTypeahead(): Typeahead {
  let typed = "";
  let at = -Infinity;
  const live = (now: number) => typed !== "" && now - at <= RESET_MS;

  return {
    active: (now = Date.now()) => live(now),
    match(labels, key, from, now = Date.now(), available = () => true) {
      typed = live(now) ? typed + key.toLowerCase() : key.toLowerCase();
      at = now;
      // One letter, however often pressed, steps past the current item; a
      // longer prefix may keep it while it still matches.
      const repeated = [...typed].every((c) => c === typed[0]);
      const query = repeated ? typed[0] : typed;
      const n = labels.length;
      const start = repeated ? from + 1 : Math.max(from, 0);
      for (let k = 0; k < n; k++) {
        const i = (((start + k) % n) + n) % n;
        if (available(i) && labels[i].trimStart().toLowerCase().startsWith(query)) return i;
      }
      return -1;
    },
  };
}
