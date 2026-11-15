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
  /** Default when omitted: { owner: "safelight", whenHeld: "wait-then-take", waitMs: 3000 }. */
  lock?: { owner: LockOwner; whenHeld: "wait-then-take" | "fail"; waitMs: number } | false;
}

export class ProjectLockedError extends Error {
  readonly heldBy: LockInfo;
  constructor(heldBy: LockInfo) {
    super(`project held by ${heldBy.app}`);
    this.heldBy = heldBy;
  }
}
