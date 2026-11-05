import { describe, expect, it } from "vitest";
import { failsEveryWrite, fsErrorText, mayFailEveryWrite } from "./fs-errors";

const ipc = (errno: string, text: string) =>
  new Error(`Error invoking remote method 'fs:write': Error: ${errno}: ${text}, open 'D:\\out\\a.jpg'`);

describe("fsErrorText", () => {
  it.each([
    ["ENOSPC", "the disk is full"],
    ["EROFS", "the folder is read-only"],
    ["EACCES", "the file is locked or not writable"],
    ["EPERM", "the file is locked or not writable"],
    ["EBUSY", "the file is locked or not writable"],
  ])("words %s for the user, whatever the bridge put before it", (errno, text) => {
    expect(fsErrorText(ipc(errno, "x"))).toBe(text);
    expect(fsErrorText(new Error(`${errno}: x`))).toBe(text);
  });

  it.each(["ENODEV", "EIO", "ENOTCONN", "ESTALE"])("words %s as a drive that went away", (errno) => {
    expect(fsErrorText(ipc(errno, "x"))).toBe("the drive or network share is disconnected");
  });

  it("words ENOENT as a folder that is gone or on a drive that went away", () => {
    expect(fsErrorText(ipc("ENOENT", "no such file or directory"))).toBe(
      "the folder is gone, or its drive or network share is disconnected",
    );
  });

  it.each(["EACCES", "EPERM", "EBUSY"])("words %s on a read as a file that can't be read", (errno) => {
    expect(fsErrorText(ipc(errno, "x"), { op: "read" })).toBe("the file is locked or can't be read");
  });

  it("words ENOENT on a file as that file being gone", () => {
    expect(fsErrorText(ipc("ENOENT", "no such file or directory"), { target: "file" })).toBe(
      "the file is no longer there",
    );
  });

  it("words a full browser quota the same as a full disk", () => {
    expect(fsErrorText(new DOMException("quota", "QuotaExceededError"))).toBe("the disk is full");
  });

  it("strips the bridge's prefix from any channel and error type", () => {
    expect(fsErrorText(new Error("Error invoking remote method 'fs:read': Error: file went away"))).toBe(
      "file went away",
    );
    expect(fsErrorText(new Error("Error invoking remote method 'fs:rename': TypeError: bad path"))).toBe(
      "bad path",
    );
  });

  it("leaves a plain message as it is", () => {
    expect(fsErrorText(new Error("close failed"))).toBe("close failed");
    expect(fsErrorText("odd")).toBe("odd");
  });
});

describe("failsEveryWrite", () => {
  it("is true for what will fail the next write in the same place the same way", () => {
    expect(failsEveryWrite(ipc("ENOSPC", "no space left on device"))).toBe(true);
    expect(failsEveryWrite(ipc("EROFS", "read-only file system"))).toBe(true);
    expect(failsEveryWrite(new DOMException("quota", "QuotaExceededError"))).toBe(true);
  });

  it.each(["ENODEV", "EIO", "ENOTCONN", "ESTALE"])("is true for %s, a drive that went away", (errno) => {
    expect(failsEveryWrite(ipc(errno, "x"))).toBe(true);
  });

  it("is false for what a locked file looks the same as", () => {
    expect(failsEveryWrite(ipc("EACCES", "permission denied"))).toBe(false);
    expect(failsEveryWrite(ipc("EPERM", "operation not permitted"))).toBe(false);
    expect(failsEveryWrite(new DOMException("denied", "NotAllowedError"))).toBe(false);
  });

  it("is false for what belongs to one file", () => {
    expect(failsEveryWrite(ipc("EBUSY", "resource busy"))).toBe(false);
    expect(failsEveryWrite(ipc("ENOENT", "no such file"))).toBe(false);
    expect(failsEveryWrite(new Error("close failed"))).toBe(false);
    expect(failsEveryWrite(undefined)).toBe(false);
  });
});

describe("mayFailEveryWrite", () => {
  it("is true for a refusal that one locked file also gives", () => {
    expect(mayFailEveryWrite(ipc("EACCES", "permission denied"))).toBe(true);
    expect(mayFailEveryWrite(ipc("EPERM", "operation not permitted"))).toBe(true);
    expect(mayFailEveryWrite(new DOMException("denied", "NotAllowedError"))).toBe(true);
  });

  it("is true for a missing folder, which one vanished file also gives", () => {
    expect(mayFailEveryWrite(ipc("ENOENT", "no such file or directory"))).toBe(true);
  });

  it("is false for the rest", () => {
    expect(mayFailEveryWrite(ipc("ENOSPC", "no space left on device"))).toBe(false);
    expect(mayFailEveryWrite(ipc("EBUSY", "resource busy"))).toBe(false);
    expect(mayFailEveryWrite(new Error("close failed"))).toBe(false);
    expect(mayFailEveryWrite(undefined)).toBe(false);
  });
});
