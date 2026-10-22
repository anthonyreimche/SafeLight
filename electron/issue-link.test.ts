// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Report an issue opens a prefilled GitHub link up to ~7.5 KB long, but
// shell.openExternal is capped at 2081 characters on Windows. Long links go
// through a one-shot redirect served on the loopback interface instead.

import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ISSUE_URL_PREFIX, openIssueLink } from "./issue-link.cjs";

const longLink = `${ISSUE_URL_PREFIX}title=t&body=${"x".repeat(6000)}`;
const opened: string[] = [];
const openExternal = vi.fn(async (url: string) => {
  opened.push(url);
});

afterEach(() => {
  opened.length = 0;
  openExternal.mockClear();
});

describe("openIssueLink", () => {
  it("refuses anything but a Safelight new-issue link", async () => {
    await expect(openIssueLink("https://example.com/?a", { openExternal })).rejects.toThrow();
    await expect(
      openIssueLink("https://github.com/someone/else/issues/new?title=x", { openExternal }),
    ).rejects.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });

  // Report an issue only ever builds links with URLSearchParams (printable
  // ASCII). Anything else would throw inside the server's response, in the
  // main process, so it is refused up front.
  it("refuses a link with control or non-ASCII characters", async () => {
    for (const bad of [
      `${longLink}\r\nSet-Cookie: x=1`,
      `${longLink}é`,
      `${ISSUE_URL_PREFIX}title=a b`,
    ]) {
      await expect(openIssueLink(bad, { openExternal })).rejects.toThrow();
    }
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens a short link directly", async () => {
    const short = `${ISSUE_URL_PREFIX}title=t&body=b`;
    await openIssueLink(short, { openExternal });
    expect(opened).toEqual([short]);
  });

  it("opens a long link through a loopback redirect", async () => {
    await openIssueLink(longLink, { openExternal });
    expect(opened).toHaveLength(1);
    const local = opened[0];
    expect(local).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]{32}$/);
    expect(local.length).toBeLessThan(2000);

    const other = await fetch(new URL("/favicon.ico", local), { redirect: "manual" });
    expect(other.status).toBe(404);

    const res = await fetch(local, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(longLink);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the redirect once", async () => {
    await openIssueLink(longLink, { openExternal });
    await fetch(opened[0], { redirect: "manual" });
    await expect(fetch(opened[0], { redirect: "manual" })).rejects.toThrow();
  });

  it("stops listening when the browser never comes", async () => {
    await openIssueLink(longLink, { openExternal, timeoutMs: 30 });
    await new Promise((r) => setTimeout(r, 80));
    await expect(fetch(opened[0], { redirect: "manual" })).rejects.toThrow();
  });

  it("rejects when it can't listen", async () => {
    const failing = ((...args: Parameters<typeof createServer>) => {
      const server = createServer(...args);
      server.listen = (() => {
        queueMicrotask(() => server.emit("error", new Error("EACCES")));
        return server;
      }) as typeof server.listen;
      return server;
    }) as typeof createServer;
    await expect(openIssueLink(longLink, { openExternal, createServer: failing })).rejects.toThrow("EACCES");
    expect(openExternal).not.toHaveBeenCalled();
  });
});
