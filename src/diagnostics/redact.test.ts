// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { makeRedactor } from "./redact";

describe("makeRedactor: home folders", () => {
  const redact = makeRedactor();

  it("replaces a Windows home folder in either slash style and hides the folders under it", () => {
    expect(redact("at C:\\Users\\ann\\AppData\\Local\\x.js")).toBe("at ~/…/x.js");
    expect(redact("at c:/users/ann/AppData/x.js")).toBe("at ~/…/x.js");
  });

  it("replaces a Windows home folder inside a file URL", () => {
    expect(redact("file:///C:/Users/ann/Pictures/a")).toBe("file:///~/…/a");
  });

  it("replaces macOS and Linux home folders", () => {
    expect(redact("/Users/ann/Library/x")).toBe("~/…/x");
    expect(redact("/home/ann/.config/safelight")).toBe("~/…/safelight");
    expect(redact("/var/home/ann/.config")).toBe("~/.config");
  });

  it("leaves text without paths alone", () => {
    expect(redact("render failed: shader 'x' : undeclared identifier")).toBe(
      "render failed: shader 'x' : undeclared identifier",
    );
    expect(redact("drive C: is full")).toBe("drive C: is full");
  });
});

describe("makeRedactor: other absolute paths", () => {
  const redact = makeRedactor();

  it("hides every folder of a path outside the project, spaces and all", () => {
    expect(redact("skipped D:\\Clients\\Smith Wedding\\notes.txt")).toBe("skipped …/notes.txt");
    expect(redact("at /Volumes/Photos/Smith Wedding/notes.txt")).toBe("at …/notes.txt");
    expect(redact("at /mnt/nas/Smith Wedding/notes.txt")).toBe("at …/notes.txt");
    expect(redact("at \\\\nas\\share\\Smith Wedding\\notes.txt")).toBe("at …/notes.txt");
  });

  it("keeps two paths on one line apart", () => {
    expect(redact("moved D:\\a b\\x.txt → E:\\c\\y.txt")).toBe("moved …/x.txt → …/y.txt");
  });

  it("leaves web and app URLs alone", () => {
    for (const text of [
      "see https://github.com/anthonyreimche/SafeLight/issues",
      "at f (app://bundle/assets/index-abc.js:1:2)",
      "at g (/__plugins__/acme.film/dist/index.js:4:9)",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });
});

describe("makeRedactor: project folder", () => {
  it("replaces the project folder before the home rule and collapses subfolders", () => {
    const redact = makeRedactor({ roots: ["C:\\Users\\ann\\Shoot"] });
    expect(redact("skipped C:\\Users\\ann\\Shoot\\day1\\raw\\notes.txt")).toBe(
      "skipped <folder>/…/notes.txt",
    );
    expect(redact("opened C:\\Users\\ann\\Shoot\\notes.txt")).toBe("opened <folder>/notes.txt");
    expect(redact("opened C:\\Users\\ann\\Shoot")).toBe("opened <folder>");
  });

  it("collapses subfolders whose names have spaces", () => {
    const redact = makeRedactor({ roots: ["D:\\Clients\\Jones"] });
    expect(redact("at D:\\Clients\\Jones\\day 1\\notes.txt")).toBe("at <folder>/…/notes.txt");
  });

  it("matches a root written with other slashes, case or a trailing slash", () => {
    const redact = makeRedactor({ roots: ["d:/photos/shoot/"] });
    expect(redact("at D:\\Photos\\Shoot\\a.txt")).toBe("at <folder>/a.txt");
  });

  it("matches the encoded form inside a file URL", () => {
    const redact = makeRedactor({ roots: ["D:\\My Photos"] });
    expect(redact("file:///D:/My%20Photos/a.txt")).toBe("file:///<folder>/a.txt");
  });

  it("does not treat a sibling folder whose name starts the same as the project", () => {
    const redact = makeRedactor({ roots: ["D:\\Photos"] });
    expect(redact("D:\\Photos2\\a.txt")).toBe("…/a.txt");
  });

  it("prefers the longest root", () => {
    const redact = makeRedactor({ roots: ["D:\\Photos", "D:\\Photos\\Shoot"] });
    expect(redact("D:\\Photos\\Shoot\\a.txt")).toBe("<folder>/a.txt");
  });
});

describe("makeRedactor: the catalog's own folders", () => {
  it("hides relative folder paths the catalog knows", () => {
    const redact = makeRedactor({ folders: ["Smith Wedding", "Smith Wedding/day1"] });
    expect(redact("[folder-ops] move Smith Wedding/day1/IMG_1.CR3 → Smith Wedding/IMG_1.CR3")).toBe(
      "[folder-ops] move …/<photo>.CR3 → …/<photo>.CR3",
    );
  });

  it("matches only whole folder names", () => {
    const redact = makeRedactor({ folders: ["day1"] });
    expect(redact("today1/x.txt and day1/x.txt")).toBe("today1/x.txt and …/x.txt");
  });
});

describe("makeRedactor: photo file names", () => {
  const redact = makeRedactor();

  it("replaces image file names and keeps the extension", () => {
    expect(redact("Couldn't read DSC_0042.NEF")).toBe("Couldn't read <photo>.NEF");
    expect(redact("preview deferred: wedding-01.cr3")).toBe("preview deferred: <photo>.cr3");
    expect(redact("a.jpeg, b.tif and c.xmp")).toBe("<photo>.jpeg, <photo>.tif and <photo>.xmp");
    expect(redact("read IMG_1.CR3.")).toBe("read <photo>.CR3.");
  });

  it("leaves code and asset files alone", () => {
    expect(redact("at f (app://bundle/assets/index-abc.js:1:2)")).toBe(
      "at f (app://bundle/assets/index-abc.js:1:2)",
    );
    expect(redact("failed to fetch libraw.wasm")).toBe("failed to fetch libraw.wasm");
  });

  it("leaves extension ids that contain an image extension alone", () => {
    expect(redact("- acme.dng-tools 1.0.0 · on")).toBe("- acme.dng-tools 1.0.0 · on");
  });

  it("leaves a bare extension alone", () => {
    expect(redact("Photo: .nef · image/x-nikon-nef")).toBe("Photo: .nef · image/x-nikon-nef");
  });
});

describe("makeRedactor: idempotence", () => {
  it("changes nothing on a second pass", () => {
    const redact = makeRedactor({ roots: ["C:\\Users\\ann\\Shoot"], folders: ["day 1"] });
    const once = redact(
      "C:\\Users\\ann\\Shoot\\a\\b\\IMG_1.dng and C:\\Users\\ann\\x and /home/bob/y DSC.NEF D:\\q r\\s.txt day 1/z.txt",
    );
    expect(redact(once)).toBe(once);
  });
});
