import { describe, expect, it } from "vitest";
import { splitLine, tokenize } from "./line-split";

describe("splitLine", () => {
  it("splits on whitespace", () => {
    expect(splitLine("set  *.ARW   exposure=+0.5", "linux")).toEqual(["set", "*.ARW", "exposure=+0.5"]);
  });

  it("groups words in double and single quotes", () => {
    expect(splitLine(`tools "My Photos/IMG 1.ARW" 'a b'`, "linux")).toEqual(["tools", "My Photos/IMG 1.ARW", "a b"]);
  });

  it("keeps an empty quoted word", () => {
    expect(splitLine(`label "" x`, "linux")).toEqual(["label", "", "x"]);
  });

  it("joins a quote to the text next to it", () => {
    expect(splitLine(`a"b c"d`, "linux")).toEqual(["ab cd"]);
  });

  it("treats backslashes as path characters on Windows", () => {
    expect(splitLine("tools C:\\Photos\\IMG_1.ARW \"D:\\My Photos\\x.ARW\"", "win32"))
      .toEqual(["tools", "C:\\Photos\\IMG_1.ARW", "D:\\My Photos\\x.ARW"]);
    expect(splitLine("cd \"C:\\Photos\\\"", "win32")).toEqual(["cd", "C:\\Photos\\"]);
  });

  it("lets a backslash escape the next character elsewhere", () => {
    expect(splitLine("tools my\\ photo.ARW", "linux")).toEqual(["tools", "my photo.ARW"]);
    expect(splitLine("say \"a \\\"b\\\"\"", "linux")).toEqual(["say", `a "b"`]);
  });

  it("is lenient with an unterminated quote", () => {
    expect(splitLine(`tools "My Pho`, "linux")).toEqual(["tools", "My Pho"]);
  });

  it("returns nothing for a blank line", () => {
    expect(splitLine("   ", "linux")).toEqual([]);
  });
});

describe("tokenize", () => {
  it("reports where each word sits in the line and whether its quote is open", () => {
    const tokens = tokenize(`ab "c d`, "linux");
    expect(tokens).toEqual([
      { text: "ab", start: 0, end: 2, quote: null, open: false },
      { text: "c d", start: 3, end: 7, quote: '"', open: true },
    ]);
  });
});
