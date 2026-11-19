// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// How ProjectStorage.open reads a project and whether it takes the writer lock.
// The app and `slu` never write one catalogue at once: whoever saves last would
// replace the other's whole catalog.json.

export type LockOwner = "safelight" | "slu";
export interface LockInfo { app: LockOwner; pid: number; host: string; since: number; refreshedAt: number }

export interface StorageOpenOptions {
  /** Read catalog.json only; skip the folder walk and import. */
  recordsOnly?: boolean;
  /** Never create folders or write anything; put* and flush throw. Implies no lock. */
  readOnly?: boolean;
  /** Default when omitted: { owner: "safelight", whenHeld: "wait-then-take", waitMs: 3000 }.
   *  `verifyBeforeWrite` proves the lock is still this storage's before each
   *  catalog.json write: once another writer has taken it over, nothing more is
   *  written, the walk stops, and the open or the next flush rejects with LockLostError. */
  lock?:
    | { owner: LockOwner; whenHeld: "wait-then-take" | "fail"; waitMs: number; verifyBeforeWrite?: boolean }
    | false;
  /** Import only the new files named here, by path from the project root (folders
   *  with their own files, or every file under them when `recursive`; "" is the
   *  root). Other new files stay new. A named file removed from the catalogue is
   *  taken back. Moved photos are followed and gone ones dropped as in any open. */
  importOnly?: { files: string[]; folders: { relPath: string; recursive: boolean }[] };
  /** Keep the catalogue as opened as catalog.bak.json at the first save. Default:
   *  only in the main window. */
  keepBackup?: boolean;
}

/** A photo record the open walk put on the path its file was found at. */
export interface MovedPhoto { id: string; from: string; to: string }
/** A photo record the open walk dropped, with its edit history, because its file is gone. */
export interface DroppedPhoto { id: string; relPath: string }

/** Another writer took the writer lock over from a storage opened with
 *  `verifyBeforeWrite`, so it stopped writing. */
export class LockLostError extends Error {
  constructor() {
    super("another writer took the catalogue's writer lock over");
    this.name = "LockLostError";
  }
}

export class ProjectLockedError extends Error {
  readonly heldBy: LockInfo;
  constructor(heldBy: LockInfo) {
    super(`project held by ${heldBy.app}`);
    this.heldBy = heldBy;
  }
}
