// Security tests for the README URL resolver — the sanitization boundary that
// keeps a hostile extension README from injecting dangerous link/image targets.
// Run with: node --experimental-strip-types src/extensions/markdown-url.test.ts

import { resolveUrl } from "./markdown-url.ts";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

const repo = "owner/repo";

// Dangerous schemes are always rejected (both as links and images).
check("javascript: link dropped", resolveUrl("javascript:alert(1)", "link", repo) === null);
check("JavaScript: case dropped", resolveUrl("JaVaScRiPt:alert(1)", "link", repo) === null);
check("data: image dropped", resolveUrl("data:text/html,<script>", "img", repo) === null);
check("vbscript: dropped", resolveUrl("vbscript:msgbox", "link", repo) === null);
check("leading-space javascript dropped", resolveUrl("   javascript:x", "link", repo) === null);
check("in-page anchor dropped", resolveUrl("#section", "link", repo) === null);
check("empty dropped", resolveUrl("", "link", repo) === null);

// Safe absolute schemes pass through unchanged.
check("https passes", resolveUrl("https://example.com/x.png", "img", repo) === "https://example.com/x.png");
check("http passes", resolveUrl("http://example.com", "link", repo) === "http://example.com");
check("mailto passes", resolveUrl("mailto:a@b.com", "link", repo) === "mailto:a@b.com");

// Relative targets resolve against the repo (raw for images, blob for links).
check(
  "relative image → raw",
  resolveUrl("docs/shot.png", "img", repo, "main") ===
    "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
);
check(
  "dot-slash stripped",
  resolveUrl("./logo.svg", "img", repo, "main") ===
    "https://raw.githubusercontent.com/owner/repo/main/logo.svg",
);
check(
  "relative link → blob",
  resolveUrl("CHANGELOG.md", "link", repo, "main") ===
    "https://github.com/owner/repo/blob/main/CHANGELOG.md",
);
check("relative dropped without repo", resolveUrl("docs/x.png", "img") === null);
check("default branch HEAD", resolveUrl("a.png", "img", repo) === "https://raw.githubusercontent.com/owner/repo/HEAD/a.png");

console.log(`markdown-url: ${passed} passed, ${failed} failed`);
if (failed) throw new Error(`${failed} markdown-url test(s) failed`);
