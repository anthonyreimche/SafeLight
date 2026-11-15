import type { LockOwner } from "../file-lock.cjs";

export interface ExtensionStore {
  fetchTrustList(): Promise<{
    repos: string[];
    owners: string[];
    reason: Record<string, string>;
    unchecked?: boolean;
  }>;
  storeVocabulary(): Promise<unknown>;
  kits: unknown;
  searchExtensions(...args: unknown[]): Promise<unknown>;
  resolveThumbnails(...args: unknown[]): Promise<unknown>;
  fetchRepoMeta(...args: unknown[]): Promise<unknown>;
  fetchReadme(...args: unknown[]): Promise<unknown>;
  fetchReleases(...args: unknown[]): Promise<unknown>;
  fetchRemoteManifest(...args: unknown[]): Promise<unknown>;
  fetchReleasesForStore(...args: unknown[]): Promise<unknown>;
  fetchReleaseManifest(...args: unknown[]): Promise<unknown>;
  installPlugin(spec: string, version?: string): Promise<unknown>;
  settleUpdate(id: string, outcome: "keep" | "rollback"): Promise<unknown>;
  uninstallPlugin(id: string): Promise<unknown>;
}

export function createExtensionStore(deps: {
  net: { fetch(url: string, init?: object): Promise<Response> };
  userData: () => string;
  fileWriter: { write(file: string, data: Uint8Array): Promise<void> };
  appVersion: () => string;
  pluginsDir: () => string;
  pluginWorkDir: () => string;
  lockOwner?: LockOwner;
}): ExtensionStore;

export function pluginsLocker(lock: {
  lockFile: () => string;
  owner?: LockOwner;
  waitMs?: number;
  pollMs?: number;
}): <T>(work: () => Promise<T>) => Promise<T>;

export function pluginsLockFile(userDataDir: string): string;
export const PLUGINS_LOCK: string;
