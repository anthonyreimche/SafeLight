export type LockOwner = "safelight" | "slu";

export interface LockInfo {
  app: LockOwner;
  pid: number;
  host: string;
  since: number;
  refreshedAt: number;
}

export type LockResult =
  | { ok: true; token: string; tookOverStale?: LockInfo }
  | { ok: false; heldBy: LockInfo };

export const STALE_MS: number;
export const REFRESH_MS: number;

export function acquireLock(
  file: string,
  owner: LockOwner,
  options?: { staleMs?: number; now?: () => number },
): Promise<LockResult>;
export function refreshLock(file: string, token: string): Promise<boolean>;
export function releaseLock(file: string, token: string): Promise<boolean>;
export function readLock(file: string): Promise<LockInfo | null>;
export function withLock<T>(
  file: string,
  owner: LockOwner,
  fn: () => Promise<T>,
  options?: { waitMs?: number; pollMs?: number; staleMs?: number; refreshMs?: number },
): Promise<T>;
