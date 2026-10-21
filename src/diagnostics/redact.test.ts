// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { makeRedactor } from "./redact";

describe("makeRedactor: home folders", () => {
  const redact = makeRedactor();

  it("replaces a Windows home folder in either slash style", () => {
    expect(redact("at C:\\Users\\ann\\AppData\\Local\\x.js")).toBe("at ~\\AppData\\Local\\x.js");
    expect(redact("at c:/users/ann/AppData/x.js")).toBe("at ~/AppData/x.js");
  });

  it("replaces a Windows home folder inside a file URL", () => {
    expect(redact("file:///C:/Users/ann/Pictures/a")).toBe("file:///~/Pictures/a");
  });

  it("replaces macOS and Linux home folders", () => {
    expect(redact("/Users/ann/Library/x")).toBe("~/Library/x");
    expect(redact("/home/ann/.config/safelight")).toBe("~/.config/safelight");
    expect(redact("/var/home/ann/.config")).toBe("~/.config");
  });

  it("leaves text without paths alone", () => {
    expect(redact("render failed: shader 'x' : undeclared identifier")).toBe(
      "render failed: shader 'x' : undeclared identifier",
    );
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

  it("matches a root written with other slashes, case or a trailing slash", () => {
    const redact = makeRedactor({ roots: ["d:/photos/shoot/"] });
    expect(redact("at D:\\Photos\\Shoot\\a.txt")).toBe("at <folder>/a.txt");
  });

  it("matches the encoded form inside a file URL", () => {
    const redact = makeRedactor({ roots: ["D:\\My Photos"] });
    expect(redact("file:///D:/My%20Photos/a.txt")).toBe("file:///<folder>/a.txt");
  });

  it("does not match a sibling folder whose name starts the same", () => {
    const redact = makeRedactor({ roots: ["D:\\Photos"] });
    expect(redact("D:\\Photos2\\a.txt")).toBe("D:\\Photos2\\a.txt");
  });

  it("prefers the longest root", () => {
    const redact = makeRedactor({ roots: ["D:\\Photos", "D:\\Photos\\Shoot"] });
    expect(redact("D:\\Photos\\Shoot\\a.txt")).toBe("<folder>/a.txt");
  });
});

describe("makeRedactor: photo file names", () => {
  const redact = makeRedactor();

  it("replaces image file names and keeps the extension", () => {
    expect(redact("Couldn't read DSC_0042.NEF")).toBe("Couldn't read <photo>.NEF");
    expect(redact("preview deferred: wedding-01.cr3")).toBe("preview deferred: <photo>.cr3");
    expect(redact("a.jpeg, b.tif and c.xmp")).toBe("<photo>.jpeg, <photo>.tif and <photo>.xmp");
  });

  it("leaves code and asset files alone", () => {
    expect(redact("at f (app://bundle/assets/index-abc.js:1:2)")).toBe(
      "at f (app://bundle/assets/index-abc.js:1:2)",
    );
    expect(redact("failed to fetch libraw.wasm")).toBe("failed to fetch libraw.wasm");
  });

  it("leaves a bare extension alone", () => {
    expect(redact("Photo: .nef · image/x-nikon-nef")).toBe("Photo: .nef · image/x-nikon-nef");
  });
});

describe("makeRedactor: idempotence", () => {
  it("changes nothing on a second pass", () => {
    const redact = makeRedactor({ roots: ["C:\\Users\\ann\\Shoot"] });
    const once = redact(
      "C:\\Users\\ann\\Shoot\\a\\b\\IMG_1.dng and C:\\Users\\ann\\x and /home/bob/y DSC.NEF",
    );
    expect(redact(once)).toBe(once);
  });
});
