// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Why opening a project stopped at its catalogue. Each is thrown before anything is
// written, so the catalogue on disk is as it was. project-store turns them into
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
    super(`The catalogue can't be read (${reason}).`);
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
    super(`The catalogue is damaged and a copy of it couldn't be kept (${reason}).`);
    this.name = "CatalogDamagedError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** What listing a folder fails with when its drive or network share is gone:
 *  unplugged, unmounted, offline. */
const UNREACHABLE = new Set(["ENOENT", "ENODEV", "EIO", "ENOTCONN", "ESTALE", "NotFoundError"]);

/** True when a failure says the folder's drive or share isn't there. */
export function isUnreachable(error: unknown): boolean {
  return UNREACHABLE.has(failureReason(error));
}

/** The project folder isn't there: its drive was unplugged, its card taken out, or
 *  its network share unmounted. A folder that isn't there would read as one
 *  emptied, and the open would drop every photo from the catalogue. */
export class FolderUnavailableError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(cause: unknown) {
    const reason = failureReason(cause);
    super(`The project folder can't be reached (${reason}).`);
    this.name = "FolderUnavailableError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** macOS hasn't allowed Safelight into the volume the project folder is on (a
 *  removable or network volume, under Files and Folders), so the folder can't be
 *  listed. That refusal is EPERM, which a read-only folder gives too. */
export class FolderAccessDeniedError extends Error {
  readonly reason: string;
  readonly cause?: unknown;

  constructor(cause: unknown) {
    const reason = failureReason(cause);
    super(`macOS hasn't allowed Safelight to read the project folder (${reason}).`);
    this.name = "FolderAccessDeniedError";
    this.reason = reason;
    this.cause = cause;
  }
}

/** The newest catalogue version this build opens: a newer one is refused, as this
 *  build's next save would drop whatever that version added. */
export const CATALOG_VERSION = 1;

/** catalog.json was saved by a newer Safelight: opened here, its next save would
 *  drop what this version doesn't know. */
export class CatalogTooNewError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`The catalogue was saved by a newer version of Safelight (catalogue version ${version}).`);
    this.name = "CatalogTooNewError";
    this.version = version;
  }
}
