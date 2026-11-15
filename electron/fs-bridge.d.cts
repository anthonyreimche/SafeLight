import type { LockOwner, LockResult } from "./file-lock.cjs";

export interface ExternalCatalog {
  path: string;
  name: string;
  sourcePath: string | null;
  createdAt: number | null;
  bytes: number;
  mtimeMs: number;
  photoCount: number | null;
  lastOpenedAt: number | null;
  sampleNames: string[];
}

export interface FsBridge {
  read(
    path: string,
    range?: { start: number; end: number },
  ): Promise<{ data: Uint8Array; mtimeMs: number; size: number }>;
  readFileSlice(
    path: string,
    start: number,
    end: number,
  ): Promise<{ data: Uint8Array; mtimeMs: number; size: number }>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(
    path: string,
    root?: string,
    withSizes?: boolean,
  ): Promise<{ name: string; kind: "file" | "directory"; size?: number }[]>;
  mkdir(path: string): Promise<void>;
  externalCatalogDir(
    rootPath: string,
    baseOverride?: string | null,
    create?: boolean,
    variant?: number,
  ): Promise<string | null>;
  externalCatalogVariants(rootPath: string, baseOverride?: string | null): Promise<number[]>;
  sourceCatalogDir(key: string, name: string): Promise<string>;
  listExternalCatalogs(baseOverride?: string | null): Promise<ExternalCatalog[]>;
  setSpilloverPointer(rootPath: string, spilloverDir: string): Promise<void>;
  getSpilloverPointer(rootPath: string): Promise<string | null>;
  clearSpilloverPointer(rootPath: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  lockProject(workingDir: string, owner: LockOwner): Promise<LockResult>;
  refreshProjectLock(workingDir: string, token: string): Promise<boolean>;
  releaseProjectLock(workingDir: string, token: string): Promise<void>;
}

export function createFsBridge(deps: {
  userData: string | (() => string);
  baseOverride?: () => string;
  writer: { write(file: string, data: Uint8Array): Promise<void> };
}): FsBridge;

export function absolutePath(p: string): string;
export function notRoot(p: string): string;
