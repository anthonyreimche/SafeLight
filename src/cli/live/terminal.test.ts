// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { createTerminalLive, pictureRows } from "./terminal";

const text = (bytes: Uint8Array | string) => (typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes));

function screen() {
  const written: string[] = [];
  const live = createTerminalLive((chunk) => written.push(text(chunk)));
  return { live, written, all: () => written.join("") };
}

const picture = (body: string, rows: number, caption = "blocks · 24-bit") => ({ bytes: new TextEncoder().encode(body), rows, caption });

describe("the terminal live view", () => {
  it("prints the first picture with its caption below it", () => {
    const { live, all } = screen();
    live.show(picture("IMG1\nIMG1\n", 2));
    expect(all()).toBe("IMG1\nIMG1\n\x1b[2Kblocks · 24-bit\n");
  });

  it("draws the next picture over the last one, on the same rows, when nothing came after it", () => {
    const { live, written } = screen();
    live.show(picture("A\nA\nA\n", 3));
    written.length = 0;
    live.show(picture("B\nB\nB\n", 3, "blocks · 24-bit · step 2 of 2"));
    expect(written.join("")).toBe("\x1b[4A\rB\nB\nB\n\x1b[2Kblocks · 24-bit · step 2 of 2\n");
  });

  it("clears below first when the new picture takes a different number of rows", () => {
    const { live, written } = screen();
    live.show(picture("A\nA\nA\n", 3));
    written.length = 0;
    live.show(picture("B\nB\n", 2));
    expect(written.join("")).toBe("\x1b[4A\r\x1b[JB\nB\n\x1b[2Kblocks · 24-bit\n");
  });

  it("prints anew once something else was printed below the picture", () => {
    const { live, written } = screen();
    live.show(picture("A\n", 1));
    live.moved();
    written.length = 0;
    live.show(picture("B\n", 1));
    expect(written.join("")).toBe("B\n\x1b[2Kblocks · 24-bit\n");
  });

  it("counts a picture's rows as the terminal lays it out", () => {
    expect(pictureRows("blocks", { width: 80, height: 54 }, undefined)).toBe(27);
    expect(pictureRows("kitty", { width: 800, height: 530 }, { width: 10, height: 20 })).toBe(27);
    expect(pictureRows("sixel", { width: 640, height: 400 }, undefined)).toBe(25);
  });
});
