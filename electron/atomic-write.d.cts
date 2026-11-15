export interface AtomicWriter {
  /** Put `bytes` at `file` through a synced temp sibling and a rename. Writes to one
   *  file are queued; one waiting behind another is replaced by a newer one. */
  write(file: string, bytes: string | Uint8Array): Promise<void>;
  /** Resolves once nothing is in flight or waiting. */
  drain(): Promise<void>;
  activePaths(): number;
}

export function createAtomicWriter(deps: {
  fsp: typeof import("node:fs").promises;
  randomId: () => string;
  retry: <T>(op: () => Promise<T>) => Promise<T>;
}): AtomicWriter;

export function writeAtomicSync(file: string, text: string, options?: { durable?: boolean }): void;
