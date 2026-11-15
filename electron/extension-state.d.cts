export interface StateWriter {
  write(file: string, bytes: Uint8Array): Promise<void>;
}

export function readDisabled(userData: string): Promise<string[] | null>;
export function writeDisabled(userData: string, ids: string[], writer: StateWriter): Promise<void>;
export function writeSharedSettings(userData: string, doc: object, writer: StateWriter): Promise<void>;
export function writeDescriptors(userData: string, doc: object, writer: StateWriter): Promise<void>;
