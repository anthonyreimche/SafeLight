// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Why opening a project stopped at its catalog. Each is thrown before anything is
// written, so the catalog on disk is as it was. project-store turns them into
// the message the user sees.

/** The short reason a file operation failed: its errno (EBUSY, EPERM), which the
 *  desktop bridge keeps only in the message text, in Node's "EBUSY: …" form,
 *  else the error's name (NotReadableError), else its message. */
export function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const errno = /\bE[A-Z]{2,}(?=:)/.exec(message)?.[0];
  if (errno) return errno;
  if (error instanceof Error && error.name !== "Error") return error.name;
  return message;
}

/** catalog.json is there but couldn't be read, even after waiting a few seconds:
 *  another program holds it (a sync client, a virus scanner, another window's
 *  save). */
export class CatalogUnreadableError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(cause: unknown) {
    const reason = failureReason(cause);
    super(`The catalog can't be read (${reason}).`);
    this.name = "CatalogUnreadableError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** catalog.json is damaged, and the copy of it that would have been kept before
 *  replacing it couldn't be written. */
export class CatalogDamagedError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(cause: unknown) {
    const reason = failureReason(cause);
    super(`The catalog is damaged and a copy of it couldn't be kept (${reason}).`);
    this.name = "CatalogDamagedError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** The newest catalog version this build opens: a newer one is refused, as this
 *  build's next save would drop whatever that version added. */
export const CATALOG_VERSION = 1;

/** catalog.json was saved by a newer Safelight: opened here, its next save would
 *  drop what this version doesn't know. */
export class CatalogTooNewError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`The catalog was saved by a newer version of Safelight (catalog version ${version}).`);
    this.name = "CatalogTooNewError";
    this.version = version;
  }
}
