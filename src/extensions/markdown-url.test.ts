// Security tests for the README URL resolver — the sanitization boundary that
// keeps a hostile extension README from injecting dangerous link/image targets.
// Run with `npm test`.

import { describe, it, expect } from "vitest";
import { resolveUrl } from "./markdown-url.ts";

const repo = "owner/repo";

describe("resolveUrl — dangerous schemes", () => {
  it("drops javascript/data/vbscript/anchor/empty targets", () => {
    expect(resolveUrl("javascript:alert(1)", "link", repo)).toBeNull();
    expect(resolveUrl("JaVaScRiPt:alert(1)", "link", repo)).toBeNull();
    expect(resolveUrl("data:text/html,<script>", "img", repo)).toBeNull();
    expect(resolveUrl("vbscript:msgbox", "link", repo)).toBeNull();
    expect(resolveUrl("   javascript:x", "link", repo)).toBeNull();
    expect(resolveUrl("#section", "link", repo)).toBeNull();
    expect(resolveUrl("", "link", repo)).toBeNull();
  });
});

describe("resolveUrl — safe absolute schemes", () => {
  it("passes https/http/mailto through unchanged", () => {
    expect(resolveUrl("https://example.com/x.png", "img", repo)).toBe(
      "https://example.com/x.png",
    );
    expect(resolveUrl("http://example.com", "link", repo)).toBe(
      "http://example.com",
    );
    expect(resolveUrl("mailto:a@b.com", "link", repo)).toBe("mailto:a@b.com");
  });
});

describe("resolveUrl — relative targets", () => {
  it("resolves against the repo (raw for images, blob for links)", () => {
    expect(resolveUrl("docs/shot.png", "img", repo, "main")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
    );
    expect(resolveUrl("./logo.svg", "img", repo, "main")).toBe(
      "https://raw.githubusercontent.com/owner/repo/main/logo.svg",
    );
    expect(resolveUrl("CHANGELOG.md", "link", repo, "main")).toBe(
      "https://github.com/owner/repo/blob/main/CHANGELOG.md",
    );
    expect(resolveUrl("docs/x.png", "img")).toBeNull();
    expect(resolveUrl("a.png", "img", repo)).toBe(
      "https://raw.githubusercontent.com/owner/repo/HEAD/a.png",
    );
  });
});
