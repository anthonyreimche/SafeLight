// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a failed file write means, worded for the user. The desktop bridge hands
// a Node error on with its own prefix and keeps the errno only in the message;
// the browser's file API names its failures instead.

import { failureReason } from "./catalog-errors";

/** What the failed operation was, where the errno alone reads two ways: a read
 *  refused isn't a file "not writable", and one missing file isn't a folder gone. */
export interface FsErrorContext {
  op?: "read" | "write";
  target?: "file" | "folder";
}

/** Why a file operation failed, worded for the user. A write to a folder unless
 *  `context` says otherwise. */
export function fsErrorText(error: unknown, context: FsErrorContext = {}): string {
  const reason = failureReason(error);
  if (reason === "EPERM" || reason === "EBUSY" || reason === "EACCES")
    return context.op === "read" ? "the file is locked or can't be read" : "the file is locked or not writable";
  if (reason === "ENOSPC" || reason === "QuotaExceededError") return "the disk is full";
  if (reason === "EROFS") return "the folder is read-only";
  if (reason === "ENOENT")
    return context.target === "file"
      ? "the file is no longer there"
      : "the folder is gone, or its drive or network share is disconnected";
  if (reason === "ENODEV" || reason === "EIO" || reason === "ENOTCONN" || reason === "ESTALE")
    return "the drive or network share is disconnected";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, "");
}

/** True for a failure that the next write to the same place will meet too: a full
 *  disk, a read-only folder, a drive that went away. A busy file is one file's
 *  trouble, not this kind. */
export function failsEveryWrite(error: unknown): boolean {
  if (error === undefined) return false;
  const reason = failureReason(error);
  return (
    reason === "ENOSPC" ||
    reason === "EROFS" ||
    reason === "QuotaExceededError" ||
    reason === "ENODEV" ||
    reason === "EIO" ||
    reason === "ENOTCONN" ||
    reason === "ESTALE"
  );
}

/** True for a refusal that may be the whole folder's (unwritable, a grant the user
 *  withdrew, a drive pulled out) or just one file's, which an antivirus scan or a
 *  viewer holds open on Windows, or a file that vanished. Only a second in a row
 *  says which. */
export function mayFailEveryWrite(error: unknown): boolean {
  if (error === undefined) return false;
  const reason = failureReason(error);
  return (
    reason === "EACCES" || reason === "EPERM" || reason === "NotAllowedError" || reason === "ENOENT"
  );
}
