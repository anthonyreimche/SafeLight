// File System Access permission helpers.
//
// File/directory handles persist in IndexedDB across sessions, but their read
// permission resets to "prompt" — so on reload we can't read the originals
// until access is re-verified (and, on a user gesture, re-requested). Until
// then the app falls back to the stored thumbnail.

type AnyHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface PermissionableHandle {
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

// Returns whether the handle is readable. With `request`, prompts for access
// (only valid inside a user gesture).
export async function verifyPermission(
  handle: AnyHandle,
  request = false,
): Promise<boolean> {
  const h = handle as unknown as PermissionableHandle;
  const opts = { mode: "read" as const };
  try {
    if (!h.queryPermission) return true; // no permission API → assume readable
    if ((await h.queryPermission(opts)) === "granted") return true;
    if (
      request &&
      h.requestPermission &&
      (await h.requestPermission(opts)) === "granted"
    ) {
      return true;
    }
  } catch {
    // treat any failure as "not readable"
  }
  return false;
}
