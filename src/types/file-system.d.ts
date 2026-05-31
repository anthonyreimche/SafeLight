interface FileSystemFileHandle {
  getFile(): Promise<File>;
  kind: "file";
  name: string;
}

interface FileSystemDirectoryHandle {
  kind: "directory";
  name: string;
  values(): AsyncIterableIterator<FileSystemFileHandle | FileSystemDirectoryHandle>;
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
  showDirectoryPicker(): Promise<FileSystemDirectoryHandle>;
}
