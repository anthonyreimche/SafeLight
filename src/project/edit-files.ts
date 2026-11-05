// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each photo's edit history in a file of its own, so a commit rewrites one small
// file instead of the whole catalogue:
//
//   <.safelight>/edits/<hh>/<name>.json   {format, photoId, stamp?, stack, currentIndex}
//
// <hh> spreads the files over 256 folders and <name> is safe on every file system
// (fileOf). A read that can't reach a file another program holds rejects: finding
// no edit would start the photo over, and its next write would replace the real
// history. A damaged file is kept aside as <name>.corrupt-<time>.json and restored
// from <name>.bak.json, the file as it was before the session's first write to it
// (kept by the main window only, so a pop-out doesn't replace it mid-session).

import { historyCursor } from "@/catalog/history-cursor";
import type { EditSnapshot, EditState } from "@/catalog/types";
import { failureReason } from "./catalog-errors";
import { readChangeStamps, type ChangeStamp } from "./change-stamps";
import {
  fileTimestamp,
  isNotFound,
  isPlainObject,
  listNames,
  parseJSONObject,
  readBlobIfThere,
  writeBlob,
} from "./fs";

/** The waits between reads of a file another program holds, before giving up
 *  (about four seconds in all). */
export const UNREADABLE_RETRY_DELAYS = [250, 500, 1000, 2000];
/** The waits before each try again of a write that keeps failing. catalog.json's
 *  repeats the last one; an edit file's gives up after it. */
export const SAVE_RETRY_DELAYS = [2000, 5000, 15_000, 30_000, 60_000];

/** The newest edit file format this build reads. */
const EDIT_FORMAT = 1;
const EDITS = "edits";
const BACKUP = ".bak.json";
/** How many photos' files are written at once. */
const WRITES_AT_ONCE = 8;
/** How many copies of a photo's damaged file are kept; older ones are removed as a
 *  new one is written. */
const KEPT_COPIES = 3;

/** A snapshot the readers can open: an object whose `params`, if it has any, are an
 *  object (normalizeParams fills in a snapshot that has none). */
export function isEditSnapshot(entry: unknown): entry is EditSnapshot {
  return isPlainObject(entry) && (entry.params == null || isPlainObject(entry.params));
}

/** An edit history with a list of snapshots, which may hold some that can't be opened. */
export function hasEditStack(entry: unknown): entry is EditState {
  return (
    isPlainObject(entry) &&
    typeof entry.photoId === "string" &&
    Array.isArray(entry.stack) &&
    typeof entry.currentIndex === "number"
  );
}

/** Whether `entry` is an edit history every reader can open. */
export function isEditState(entry: unknown): entry is EditState {
  return hasEditStack(entry) && entry.stack.every(isEditSnapshot);
}

/** `edit` with the snapshots that can't be opened left out, its cursor moved to
 *  keep the snapshot it was on (or the one before, if that was left out); null when
 *  none can be opened. `edit` itself if every one can. */
export function openableEdit(edit: EditState): EditState | null {
  const stack = edit.stack.filter(isEditSnapshot);
  if (stack.length === edit.stack.length) return edit;
  if (stack.length === 0) return null;
  const cursor = historyCursor(edit.currentIndex, edit.stack.length);
  const before = edit.stack.slice(0, cursor + 1).filter(isEditSnapshot).length;
  return { ...edit, stack, currentIndex: Math.max(before - 1, 0) };
}

/** Lower case only, as Windows and macOS don't tell names apart by case. */
const SAFE_NAME = /^[a-z0-9-]{1,64}$/;
/** Names Windows keeps for devices, with any extension. */
const DEVICE_NAME = /^(con|prn|aux|nul|com\d|lpt\d)$/;
/** Keeps a hashed name (x-<16 hex>-<hint>) within 64 characters. */
const HINT_LENGTH = 40;

/** 64-bit FNV-1a over the UTF-8 bytes, as 16 hex digits: 32 bits would make two of
 *  50,000 photo ids likely to meet. */
function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

/** Where a photo's edit file is: the shard folder under edits/ and the file's name
 *  before `.json`. */
export interface EditFileName {
  shard: string;
  name: string;
}

/** The shard is the last two hex digits of the id's FNV-1a hash, its best-mixed
 *  (ids that differ only at the end share their first digits). The name is the id
 *  when it is a safe file name of its own, else x-<hash>-<hint>, the hint being the
 *  end of the id made a name (where a path-like id names its file); an id starting
 *  x- always takes the second, so the two never meet. */
export function fileOf(photoId: string): EditFileName {
  const hash = fnv1a64(photoId);
  const shard = hash.slice(-2);
  if (SAFE_NAME.test(photoId) && !DEVICE_NAME.test(photoId) && !photoId.startsWith("x-"))
    return { shard, name: photoId };
  const hint = photoId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(-HINT_LENGTH)
    .replace(/^-|-$/g, "");
  return { shard, name: hint ? `x-${hash}-${hint}` : `x-${hash}` };
}

/** What an edit file's bytes hold: an edit history (`partial` when snapshots that
 *  can't be opened were left out), nothing this build can open, or a format newer
 *  than it reads. */
export type ParsedEditFile =
  | { kind: "ok"; edit: EditState; stamp: ChangeStamp | undefined; partial: boolean }
  | { kind: "damaged" }
  | { kind: "too-new"; format: number };

export function parse(bytes: Uint8Array): ParsedEditFile {
  const saved = parseJSONObject(bytes);
  if (!saved) return { kind: "damaged" };
  const { format, photoId, stamp, stack, currentIndex } = saved;
  if (typeof format === "number" && format > EDIT_FORMAT) return { kind: "too-new", format };
  const stored = { photoId, stack, currentIndex };
  if (format !== EDIT_FORMAT || !hasEditStack(stored)) return { kind: "damaged" };
  const edit = openableEdit(stored);
  if (!edit) return { kind: "damaged" };
  // A stamp this build can't read only makes the edit the oldest.
  const read: ChangeStamp | undefined = readChangeStamps({ edits: { stamp } }).edits.stamp;
  return { kind: "ok", edit, stamp: read, partial: edit !== stored };
}

function encode(edit: EditState, stamp: ChangeStamp | undefined): Uint8Array<ArrayBuffer> {
  const { photoId, stack, currentIndex } = edit;
  return new TextEncoder().encode(
    JSON.stringify({ format: EDIT_FORMAT, photoId, stamp, stack, currentIndex }),
  );
}

/** A photo's edit as its file holds it. */
export interface EditFile {
  edit: EditState;
  stamp: ChangeStamp | undefined;
}

/** The edit `bytes` hold for `photoId`, or null when they hold none this build can
 *  open for it. */
function editFor(photoId: string, bytes: Uint8Array): EditFile | null {
  const parsed = parse(bytes);
  if (parsed.kind !== "ok" || parsed.edit.photoId !== photoId) return null;
  return { edit: parsed.edit, stamp: parsed.stamp };
}

/** A photo's edit file is there but couldn't be read, even after waiting a few
 *  seconds, or holds another photo's edit. */
export class EditUnreadableError extends Error {
  readonly photoId: string;
  readonly reason: string;
  readonly cause?: unknown;

  constructor(photoId: string, cause: unknown) {
    const reason = failureReason(cause);
    super(`The edit of ${photoId} can't be read (${reason}).`);
    this.name = "EditUnreadableError";
    this.photoId = photoId;
    this.reason = reason;
    this.cause = cause;
  }
}

/** A photo's edit file is damaged, and the copy of it that would have been kept
 *  before it is replaced couldn't be written. */
export class EditDamagedError extends Error {
  readonly photoId: string;
  readonly reason: string;
  readonly cause?: unknown;

  constructor(photoId: string, cause: unknown) {
    const reason = failureReason(cause);
    super(`The edit of ${photoId} is damaged and a copy of it couldn't be kept (${reason}).`);
    this.name = "EditDamagedError";
    this.photoId = photoId;
    this.reason = reason;
    this.cause = cause;
  }
}

/** The file a photo's edit would be written to holds another photo's edit: their ids
 *  share a file name. Written over, that photo's history would be lost. */
export class EditNameClashError extends Error {
  readonly photoId: string;
  readonly holder: string;

  constructor(photoId: string, holder: string) {
    super(`The edit of ${photoId} can't be stored: its file holds the edit of ${holder}.`);
    this.name = "EditNameClashError";
    this.photoId = photoId;
    this.holder = holder;
  }
}

/** A photo's edit file was saved by a newer Safelight. */
export class EditTooNewError extends Error {
  readonly photoId: string;
  readonly format: number;

  constructor(photoId: string, format: number) {
    super(
      `The edit of ${photoId} was saved by a newer version of Safelight (edit format ${format}).`,
    );
    this.name = "EditTooNewError";
    this.photoId = photoId;
    this.format = format;
  }
}

/** How a read opened an edit file it couldn't use as saved: from its backup, from
 *  the snapshots it could open, or as no edit. `kept` names the copy of the file
 *  kept beside it, or is null for an empty file. */
export interface EditRecovery {
  photoId: string;
  from: "backup" | "openable" | "none";
  kept: string | null;
}

export interface EditFilesOptions {
  /** Keep each file as it was before this session's first write to it. */
  keepBackups?: boolean;
  onRecovered?: (recovery: EditRecovery) => void;
}

/** A change of a photo's file waiting its turn: the bytes to write, or null to
 *  remove the file, and the callers each settles. */
interface PendingChange {
  bytes: Uint8Array<ArrayBuffer> | null;
  waiters: { resolve: () => void; reject: (error: unknown) => void }[];
}

/** The changes of one photo's file while one runs: the change waiting after it. */
interface ChangeChain {
  next: PendingChange | null;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Remove all but the newest KEPT_COPIES files named `prefix` + a time + .json. A
 *  copy that can't be removed stays; it is no reason to fail the read. */
async function pruneCopies(dir: FileSystemDirectoryHandle, prefix: string): Promise<void> {
  try {
    const copies: string[] = [];
    for await (const name of listNames(dir))
      if (name.startsWith(prefix) && name.endsWith(".json")) copies.push(name);
    for (const name of copies.sort().slice(0, -KEPT_COPIES)) await removeIfThere(dir, name);
  } catch (error) {
    console.warn("[project] old copies of a damaged edit couldn't be removed:", error);
  }
}

async function removeIfThere(dir: FileSystemDirectoryHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

export class EditFiles {
  private readonly sl: FileSystemDirectoryHandle;
  private readonly keepBackups: boolean;
  private readonly onRecovered: ((recovery: EditRecovery) => void) | undefined;
  private editsDir: FileSystemDirectoryHandle | null = null;
  private readonly shards = new Map<string, FileSystemDirectoryHandle>();
  private readonly reads = new Map<string, Promise<EditFile | undefined>>();
  /** The photos whose file a change is running for. */
  private readonly changes = new Map<string, ChangeChain>();
  /** How many changes of each photo's file this session has asked for. */
  private readonly asked = new Map<string, number>();
  /** The photos whose file this session looked at before its first change of it. */
  private readonly checked = new Set<string>();
  /** The photos whose damaged file this session has kept a copy of and reported. */
  private readonly damagedSeen = new Set<string>();
  private slotsTaken = 0;
  private readonly slotQueue: (() => void)[] = [];

  constructor(sl: FileSystemDirectoryHandle, options: EditFilesOptions = {}) {
    this.sl = sl;
    this.keepBackups = options.keepBackups ?? false;
    this.onRecovered = options.onRecovered;
  }

  /** A photo's edit, or undefined when it has no file (or a damaged one without a
   *  usable backup). Rejects when the file can't be read, holds another photo's
   *  edit, or is of a newer format. Reads of one photo that overlap share one. */
  read(photoId: string): Promise<EditFile | undefined> {
    const running = this.reads.get(photoId);
    if (running) return running;
    const read = this.load(photoId).finally(() => this.reads.delete(photoId));
    this.reads.set(photoId, read);
    return read;
  }

  /** Store `edit` as its photo's file. Resolves once it, or a newer change of that
   *  file asked for while it waited, has landed; rejects once the writes have kept
   *  failing through SAVE_RETRY_DELAYS. */
  write(edit: EditState, stamp?: ChangeStamp): Promise<void> {
    return this.queue(edit.photoId, encode(edit, stamp));
  }

  /** Remove a photo's file and its backup, after any write of it still running. */
  remove(photoId: string): Promise<void> {
    return this.queue(photoId, null);
  }

  private async load(photoId: string): Promise<EditFile | undefined> {
    // A change running as the read begins may land before it ends.
    const askedBefore = this.changes.has(photoId) ? null : (this.asked.get(photoId) ?? 0);
    const { shard, name } = fileOf(photoId);
    const bytes = await this.readBytes(photoId, shard, `${name}.json`);
    if (!bytes) return undefined;
    const parsed = parse(bytes);
    if (parsed.kind === "too-new") throw new EditTooNewError(photoId, parsed.format);
    if (parsed.kind === "ok") {
      if (parsed.edit.photoId !== photoId)
        throw new EditUnreadableError(
          photoId,
          new Error(`it holds the edit of ${parsed.edit.photoId}`),
        );
      if (parsed.partial) {
        const seen = await this.seeDamaged(photoId, shard, name, bytes);
        if (seen) this.onRecovered?.({ photoId, from: "openable", kept: seen.kept });
      }
      return { edit: parsed.edit, stamp: parsed.stamp };
    }
    const seen = await this.seeDamaged(photoId, shard, name, bytes);
    const backupBytes = await this.readBytes(photoId, shard, `${name}${BACKUP}`);
    const backup = backupBytes && editFor(photoId, backupBytes);
    if (!backupBytes || !backup) {
      if (seen) this.onRecovered?.({ photoId, from: "none", kept: seen.kept });
      return undefined;
    }
    // Written back only when no change of the file was running or asked for since
    // the read began: that one is newer than the backup.
    if ((this.asked.get(photoId) ?? 0) === askedBefore)
      this.queue(photoId, backupBytes).catch((error: unknown) =>
        console.warn(
          `[project] the edit of ${photoId} was restored but couldn't be written back:`,
          error,
        ),
      );
    if (seen) this.onRecovered?.({ photoId, from: "backup", kept: seen.kept });
    return backup;
  }

  /** Keep a copy of a damaged file (none of an empty one) the first time this session
   *  reads it; null when it already has, so it is kept and reported once. */
  private async seeDamaged(
    photoId: string,
    shard: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ kept: string | null } | null> {
    if (this.damagedSeen.has(photoId)) return null;
    const kept = bytes.length > 0 ? await this.keepAside(photoId, shard, name, bytes) : null;
    this.damagedSeen.add(photoId);
    return { kept };
  }

  /** A file's bytes, or null when it isn't there, waiting through
   *  UNREADABLE_RETRY_DELAYS for one another program holds. */
  private async readBytes(
    photoId: string,
    shard: string,
    file: string,
  ): Promise<Uint8Array<ArrayBuffer> | null> {
    for (let tries = 0; ; tries++) {
      try {
        const dir = await this.shardIfThere(shard);
        const blob = dir && (await readBlobIfThere(dir, file));
        return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
      } catch (error) {
        if (tries === UNREADABLE_RETRY_DELAYS.length) throw new EditUnreadableError(photoId, error);
        await wait(UNREADABLE_RETRY_DELAYS[tries]);
      }
    }
  }

  /** Keep a copy of a damaged file beside it and return the copy's name. A copy
   *  that can't be written rejects: the next write would replace the only one. */
  private async keepAside(
    photoId: string,
    shard: string,
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<string> {
    const kept = `${name}.corrupt-${fileTimestamp()}.json`;
    const dir = await this.shard(shard);
    try {
      await writeBlob(dir, kept, new Blob([bytes]));
    } catch (error) {
      throw new EditDamagedError(photoId, error);
    }
    await pruneCopies(dir, `${name}.corrupt-`);
    return kept;
  }

  private async shard(shard: string): Promise<FileSystemDirectoryHandle> {
    const held = this.shards.get(shard);
    if (held) return held;
    this.editsDir ??= await this.sl.getDirectoryHandle(EDITS, { create: true });
    const dir = await this.editsDir.getDirectoryHandle(shard, { create: true });
    this.shards.set(shard, dir);
    return dir;
  }

  /** A shard's folder, or null when it (or edits/) isn't there; not made. */
  private async shardIfThere(shard: string): Promise<FileSystemDirectoryHandle | null> {
    const held = this.shards.get(shard);
    if (held) return held;
    try {
      const edits = this.editsDir ?? (await this.sl.getDirectoryHandle(EDITS));
      const dir = await edits.getDirectoryHandle(shard);
      this.shards.set(shard, dir);
      return dir;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** Change `photoId`'s file to `bytes` (null: remove it): at once when no change of
   *  it is running, else once that one ends, in place of a change still waiting,
   *  whose callers then settle with this one. */
  private queue(photoId: string, bytes: Uint8Array<ArrayBuffer> | null): Promise<void> {
    this.asked.set(photoId, (this.asked.get(photoId) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const running = this.changes.get(photoId);
      if (running) {
        running.next = { bytes, waiters: [...(running.next?.waiters ?? []), waiter] };
        return;
      }
      const chain: ChangeChain = { next: { bytes, waiters: [waiter] } };
      this.changes.set(photoId, chain);
      void this.drain(photoId, chain);
    });
  }

  private async drain(photoId: string, chain: ChangeChain): Promise<void> {
    const waiting = () => chain.next;
    for (let change = waiting(); change; change = waiting()) {
      chain.next = null;
      try {
        await this.land(photoId, change.bytes, () => waiting() !== null);
        for (const waiter of change.waiters) waiter.resolve();
      } catch (error) {
        const newer = waiting();
        if (newer) newer.waiters.unshift(...change.waiters);
        else for (const waiter of change.waiters) waiter.reject(error);
      }
    }
    this.changes.delete(photoId);
  }

  /** Make one change, trying again after each of SAVE_RETRY_DELAYS; it gives up
   *  early once a newer change of the file waits, which then goes in its place. */
  private async land(
    photoId: string,
    bytes: Uint8Array<ArrayBuffer> | null,
    superseded: () => boolean,
  ): Promise<void> {
    for (let tries = 0; ; tries++) {
      try {
        await this.inSlot(() => this.change(photoId, bytes));
        return;
      } catch (error) {
        if (error instanceof EditNameClashError) throw error;
        if (tries === SAVE_RETRY_DELAYS.length || superseded()) throw error;
        await wait(SAVE_RETRY_DELAYS[tries]);
        if (superseded()) throw error;
      }
    }
  }

  private async change(photoId: string, bytes: Uint8Array<ArrayBuffer> | null): Promise<void> {
    const { shard, name } = fileOf(photoId);
    const file = `${name}.json`;
    const dir = bytes === null ? await this.shardIfThere(shard) : await this.shard(shard);
    if (!dir) return;
    if (!this.checked.has(photoId)) {
      const before = await readBlobIfThere(dir, file);
      if (before) {
        const found = new Uint8Array(await before.arrayBuffer());
        const parsed = parse(found);
        if (parsed.kind === "ok" && parsed.edit.photoId !== photoId)
          throw new EditNameClashError(photoId, parsed.edit.photoId);
        // A damaged file is no backup: the one there may still be good.
        if (parsed.kind === "ok" && this.keepBackups && bytes !== null)
          await writeBlob(dir, `${name}${BACKUP}`, new Blob([found]));
      }
      this.checked.add(photoId);
    }
    if (bytes === null)
      for (const entry of [file, `${name}${BACKUP}`]) await removeIfThere(dir, entry);
    else await writeBlob(dir, file, new Blob([bytes]));
  }

  /** Run `write` once fewer than WRITES_AT_ONCE are running; those that wait start
   *  in the order they began waiting. */
  private async inSlot(write: () => Promise<void>): Promise<void> {
    if (this.slotsTaken < WRITES_AT_ONCE) this.slotsTaken++;
    else await new Promise<void>((resolve) => this.slotQueue.push(resolve));
    try {
      await write();
    } finally {
      const next = this.slotQueue.shift();
      if (next) next();
      else this.slotsTaken--;
    }
  }
}
