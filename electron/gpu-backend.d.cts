export const SOFTWARE_BACKEND: string;

export interface BackendCache {
  backend: string | null;
  reason: string | null;
  since: number | null;
  launches: number;
  version?: string;
  /** A backend the user picked that this platform's ladder lacks. */
  elsewhere?: string;
}

export function backendChoices(platform: NodeJS.Platform, isWayland: boolean): string[];
export function parseBackendCache(text: string, backends: readonly string[]): BackendCache;
export function backendCacheFiles(
  userData: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): { file: string | null; legacy: string | null };
