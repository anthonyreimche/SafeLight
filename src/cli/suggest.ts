// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length];
}

/** The candidate closest to `input` (case ignored) for a "Did you mean …?",
 *  or null when nothing is close enough to be a typo. */
export function closest(input: string, candidates: readonly string[]): string | null {
  const needle = input.toLowerCase();
  const limit = Math.max(1, Math.floor(needle.length / 3));
  let best: string | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const score = distance(needle, c.toLowerCase());
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return bestScore <= limit ? best : null;
}
