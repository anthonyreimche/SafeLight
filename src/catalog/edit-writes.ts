// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each write of a photo's edit reads what the catalogue holds and builds on it,
// one at a time per photo, so neither another window's steps nor an earlier
// write from this one are lost: Develop's commits, undo and redo, and the steps
// Paste Settings and Update processing append from the Library.

const editWrites = new Map<string, Promise<unknown>>();

/** Run `write` once every write queued for any of `photoIds` has finished, and
 *  hold theirs back until it has. `latest` says no later write is queued behind
 *  it for any of them. Keep `write` to the read and the store call; a slow save
 *  awaited inside holds every write behind it. */
export function writeInTurn<T>(
  photoIds: string | readonly string[],
  write: (latest: () => boolean) => Promise<T>,
): Promise<T> {
  const ids = typeof photoIds === "string" ? [photoIds] : [...new Set(photoIds)];
  const run: Promise<T> = Promise.all(ids.map((id) => editWrites.get(id)?.catch(() => undefined)))
    .then(() => write(() => ids.every((id) => editWrites.get(id) === run)));
  for (const id of ids) editWrites.set(id, run);
  const forget = () => {
    for (const id of ids) if (editWrites.get(id) === run) editWrites.delete(id);
  };
  run.then(forget, forget);
  return run;
}

/** True while a write of the photo's edit is queued or under way. */
export function writePending(photoId: string): boolean {
  return editWrites.has(photoId);
}
