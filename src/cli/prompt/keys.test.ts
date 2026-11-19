import { describe, expect, it } from "vitest";
import { createKeyDecoder, type Key } from "./keys";

const key = (name: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}): Key =>
  ({ kind: "key", name, ctrl: false, alt: false, shift: false, ...mods });
const text = (t: string): Key => ({ kind: "text", text: t });

function decode(...chunks: string[]): Key[] {
  const d = createKeyDecoder();
  return [...chunks.flatMap((c) => d.feed(c)), ...d.flush()];
}

describe("key decoder", () => {
  it("groups printable characters into one text key", () => {
    expect(decode("set é 日本")).toEqual([text("set é 日本")]);
  });

  it("reads enter, tab, backspace and control letters", () => {
    expect(decode("a\rb")).toEqual([text("a"), key("enter"), text("b")]);
    expect(decode("\n")).toEqual([key("enter")]);
    expect(decode("\r\n")).toEqual([key("enter")]);
    expect(decode("\t")).toEqual([key("tab")]);
    expect(decode("\x7f")).toEqual([key("backspace")]);
    expect(decode("\x08")).toEqual([key("backspace")]);
    expect(decode("\x03\x04\x01\x05\x17\x15\x0b\x0c\x12")).toEqual(
      ["c", "d", "a", "e", "w", "u", "k", "l", "r"].map((n) => key(n, { ctrl: true })),
    );
  });

  it("reads xterm arrows, home and end in CSI and SS3 form", () => {
    expect(decode("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([key("up"), key("down"), key("right"), key("left")]);
    expect(decode("\x1bOA\x1bOD\x1bOH\x1bOF")).toEqual([key("up"), key("left"), key("home"), key("end")]);
    expect(decode("\x1b[H\x1b[F")).toEqual([key("home"), key("end")]);
  });

  it("reads modifiers on arrows: xterm's ;3 alt, ;5 ctrl, ;2 shift", () => {
    expect(decode("\x1b[1;3D")).toEqual([key("left", { alt: true })]);
    expect(decode("\x1b[1;5C")).toEqual([key("right", { ctrl: true })]);
    expect(decode("\x1b[1;2A")).toEqual([key("up", { shift: true })]);
    expect(decode("\x1b[1;6D")).toEqual([key("left", { ctrl: true, shift: true })]);
  });

  it("reads the tilde keys, also Windows' (libuv) home and end", () => {
    expect(decode("\x1b[1~\x1b[4~\x1b[3~\x1b[2~\x1b[5~\x1b[6~\x1b[7~\x1b[8~")).toEqual(
      [key("home"), key("end"), key("delete"), key("insert"), key("pageup"), key("pagedown"), key("home"), key("end")],
    );
    expect(decode("\x1b[3;5~")).toEqual([key("delete", { ctrl: true })]);
  });

  it("reads alt as an escape prefix, as libuv sends it on Windows", () => {
    expect(decode("\x1bf\x1bb")).toEqual([key("f", { alt: true }), key("b", { alt: true })]);
    expect(decode("\x1bF")).toEqual([key("f", { alt: true, shift: true })]);
    expect(decode("\x1b\x1b[D")).toEqual([key("left", { alt: true })]);
    expect(decode("\x1b\x1b[C")).toEqual([key("right", { alt: true })]);
    expect(decode("\x1b\x7f")).toEqual([key("backspace", { alt: true })]);
    expect(decode("\x1b\x08")).toEqual([key("backspace", { alt: true })]);
    expect(decode("\x1b\r")).toEqual([key("enter", { alt: true })]);
  });

  it("reads shift+tab and Windows' F-keys", () => {
    expect(decode("\x1b[Z")).toEqual([key("tab", { shift: true })]);
    expect(decode("\x1b[[A\x1bOP\x1b[15~")).toEqual([key("f1"), key("f1"), key("f5")]);
  });

  it("reads CSI u keys", () => {
    expect(decode("\x1b[13;2u")).toEqual([key("enter", { shift: true })]);
    expect(decode("\x1b[97;5u")).toEqual([key("a", { ctrl: true })]);
  });

  it("holds a lone escape until it is flushed, then reads it as the escape key", () => {
    const d = createKeyDecoder();
    expect(d.feed("\x1b")).toEqual([]);
    expect(d.pending()).toBe(true);
    expect(d.flush()).toEqual([key("escape")]);
    expect(d.pending()).toBe(false);
  });

  it("joins a sequence split across reads", () => {
    const d = createKeyDecoder();
    expect(d.feed("a\x1b[")).toEqual([text("a")]);
    expect(d.feed("1;5")).toEqual([]);
    expect(d.feed("D")).toEqual([key("left", { ctrl: true })]);
  });

  it("reads a bracketed paste as one paste, newlines kept and CRs folded", () => {
    expect(decode("\x1b[200~set a\r\nset b\rx\x1b[201~")).toEqual([{ kind: "paste", text: "set a\nset b\nx" }]);
  });

  it("reads a paste split across reads, also inside its end marker", () => {
    const d = createKeyDecoder();
    expect(d.feed("\x1b[200~one\x1b[")).toEqual([]);
    expect(d.feed("A two\x1b[20")).toEqual([]);
    expect(d.feed("1~z")).toEqual([{ kind: "paste", text: "one\x1b[A two" }, text("z")]);
  });

  it("ignores focus reports and unknown sequences", () => {
    expect(decode("\x1b[I\x1b[O\x1b[99x")).toEqual([]);
  });
});
