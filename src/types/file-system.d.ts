interface FileSystemFileHandle {
  getFile(): Promise<File>;
  createWritable(): Promise<FileSystemWritableFileStream>;
  kind: "file";
  name: string;
}

interface FileSystemDirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
  getFileHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemFileHandle>;
  getDirectoryHandle(
    name: string,
    options?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
}

interface OpenFilePickerOptions {
  multiple?: boolean;
  types?: {
    description?: string;
    accept: Record<string, string[]>;
  }[];
}

interface Window {
  showOpenFilePicker(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
  showDirectoryPicker(options?: {
    mode?: "read" | "readwrite";
    id?: string;
  }): Promise<FileSystemDirectoryHandle>;
}
