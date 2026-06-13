// File System Access permission helpers.
//
// Dual-path access — same calling code, two backends:
//
//   • Browser: handles persist in IndexedDB but their permission resets to
//     "prompt" on reload. queryPermission() returns "prompt", so the silent
//     re-verify fails and the app falls back to the stored thumbnail until the
//     user clicks "Reconnect originals" (requestPermission needs a gesture).
//
//   • Electron: the main process auto-grants "fileSystem" via
//     setPermissionCheckHandler, so queryPermission() resolves "granted" with
//     no gesture. The silent re-verify below succeeds and originals reconnect
//     automatically; the click path is never reached except for moved files.
//
// Callers don't branch on platform — they always "try to access, then fall
// back on the click". Electron just makes the try succeed.

type AnyHandle = FileSystemFileHandle | FileSystemDirectoryHandle;

interface PermissionableHandle {
  queryPermission?(d: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(d: {
    mode: "read" | "readwrite";
  }): Promise<PermissionState>;
}

// Returns whether the handle is readable. With `request`, prompts for access
// (only valid inside a user gesture). Pass mode "readwrite" for project roots
// (the .safelight/ working directory needs writes).
export async function verifyPermission(
  handle: AnyHandle,
  request = false,
  mode: "read" | "readwrite" = "read",
): Promise<boolean> {
  const h = handle as unknown as PermissionableHandle;
  const opts = { mode };
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
