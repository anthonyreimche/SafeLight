// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which documents may exist in a Safelight window, and which of them may use
// the privileged fs and update bridge (window-policy.cjs). Only the app's own
// index (main window, pop-outs, the DevTools window) qualifies; an extension's
// own file under /__plugins__/ must never become a top-level document, because
// a fresh document can claim the bridge again. main.cjs wires these in.

import { describe, expect, it, vi } from "vitest";
import {
  guardPrivileged,
  indexRedirectFor,
  isAppIndexUrl,
  navigationAllowed,
  privilegedSenderAllowed,
  validRepo,
  windowOpenAction,
} from "./window-policy.cjs";

const APP_DOCUMENTS = [
  "app://bundle/index.html",
  "app://bundle/index.html?detached=library",
  "app://bundle/?devtools=1",
  "app://bundle/index.html?devtools=1",
  "app://bundle/index.html?detached=map#/view/12",
];
const PLUGIN_FILE = "app://bundle/__plugins__/x/a.html";

describe("app documents", () => {
  it.each(APP_DOCUMENTS)("allows %s for navigation, window open and privileged", (url) => {
    expect(isAppIndexUrl(url)).toBe(true);
    expect(navigationAllowed(url)).toBe(true);
    expect(windowOpenAction(url)).toBe("allow-app");
    expect(privilegedSenderAllowed({ url, isTopFrame: true })).toBe(true);
  });

  it("denies an extension's own file for all three", () => {
    expect(isAppIndexUrl(PLUGIN_FILE)).toBe(false);
    expect(navigationAllowed(PLUGIN_FILE)).toBe(false);
    expect(windowOpenAction(PLUGIN_FILE)).toBe("deny");
    expect(privilegedSenderAllowed({ url: PLUGIN_FILE, isTopFrame: true })).toBe(false);
  });

  it("denies a non-top frame even on the app's own index", () => {
    expect(
      privilegedSenderAllowed({ url: "app://bundle/index.html", isTopFrame: false }),
    ).toBe(false);
  });

  // The Map extension keeps its view in the hash.
  it("allows the index with only its hash changed", () => {
    expect(isAppIndexUrl("app://bundle/index.html#x")).toBe(true);
  });

  it("resolves dot segments before judging the path", () => {
    expect(isAppIndexUrl("app://bundle/index.html/../__plugins__/x/a.html")).toBe(false);
  });
});

describe("other urls", () => {
  it.each(["http://x", "https://x"])("opens %s in the system browser", (url) => {
    expect(windowOpenAction(url)).toBe("external");
    expect(navigationAllowed(url)).toBe(false);
    expect(privilegedSenderAllowed({ url, isTopFrame: true })).toBe(false);
  });

  it.each(["file:///c:/x", "javascript:"])("denies %s", (url) => {
    expect(windowOpenAction(url)).toBe("deny");
    expect(navigationAllowed(url)).toBe(false);
    expect(privilegedSenderAllowed({ url, isTopFrame: true })).toBe(false);
  });
});

describe("validRepo", () => {
  it.each(["owner/repo", "owner/repo.js"])("accepts %s", (repo) => {
    expect(validRepo(repo)).toBe(true);
  });

  it.each(["a/b/../../x/y", "../x", "./x", "a/.."])("rejects %s", (repo) => {
    expect(validRepo(repo)).toBe(false);
  });
});

describe("guardPrivileged", () => {
  type Frame = { url: string; parent: Frame | null };
  const top = (url: string): Frame => ({ url, parent: null });
  const event = (frame: Frame | null, pageUrl = "app://bundle/index.html") => ({
    senderFrame: frame,
    sender: { getURL: () => pageUrl },
  });

  it("runs the handler for the app's own top frame", async () => {
    const handler = vi.fn(async (_e: unknown, p: string) => `read ${p}`);
    const e = event(top("app://bundle/index.html?detached=library"));
    await expect(guardPrivileged("fs:read", handler)(e, "/a")).resolves.toBe("read /a");
    expect(handler).toHaveBeenCalledWith(e, "/a");
  });

  it("refuses another document without running the handler, naming channel and url", async () => {
    const handler = vi.fn();
    const warn = vi.fn();
    const guarded = guardPrivileged("fs:write", handler, { warn });
    await expect(guarded(event(top(PLUGIN_FILE)), "/a")).rejects.toThrow("Not allowed");
    expect(handler).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("fs:write"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(PLUGIN_FILE));
  });

  it("refuses a child frame of the app", async () => {
    const handler = vi.fn();
    const child: Frame = { url: "app://bundle/index.html", parent: top("app://bundle/index.html") };
    await expect(
      guardPrivileged("updates:install", handler, { warn: vi.fn() })(event(child)),
    ).rejects.toThrow("Not allowed");
    expect(handler).not.toHaveBeenCalled();
  });

  it("falls back to the page url when the frame is gone, as after a reload", async () => {
    const handler = vi.fn(async () => "flushed");
    await expect(guardPrivileged("fs:write", handler)(event(null))).resolves.toBe("flushed");
    await expect(
      guardPrivileged("fs:write", handler, { warn: vi.fn() })(event(null, PLUGIN_FILE)),
    ).rejects.toThrow("Not allowed");
  });

  describe("once the window's document has committed", () => {
    // history.pushState moves frame.url and the page url, but commits nothing.
    const PUSHED = "app://bundle/library?detached=library";
    const committed = (e: { sender: object }, url: string) => new WeakMap([[e.sender, url]]);

    it("lets the index through after a pushState to another path", async () => {
      const handler = vi.fn(async () => "saved");
      const e = event(top(PUSHED), PUSHED);
      const committedUrls = committed(e, "app://bundle/index.html?detached=library");
      await expect(guardPrivileged("fs:write", handler, { committedUrls })(e)).resolves.toBe(
        "saved",
      );
    });

    it("lets the index through after a pushState once the frame is gone", async () => {
      const handler = vi.fn(async () => "flushed");
      const e = event(null, PUSHED);
      const committedUrls = committed(e, "app://bundle/index.html");
      await expect(guardPrivileged("fs:write", handler, { committedUrls })(e)).resolves.toBe(
        "flushed",
      );
    });

    it("refuses a committed plugin page that pushState made look like the index", async () => {
      const handler = vi.fn();
      const warn = vi.fn();
      const e = event(top("app://bundle/index.html"));
      const gone = event(null);
      const committedUrls = new WeakMap([
        [e.sender, PLUGIN_FILE],
        [gone.sender, PLUGIN_FILE],
      ]);
      const guarded = guardPrivileged("fs:read", handler, { committedUrls, warn });
      await expect(guarded(e, "/a")).rejects.toThrow("Not allowed");
      await expect(guarded(gone, "/a")).rejects.toThrow("Not allowed");
      expect(handler).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(PLUGIN_FILE));
    });

    it("still refuses a child frame of a committed index", async () => {
      const handler = vi.fn();
      const child: Frame = { url: "app://bundle/index.html", parent: top("app://bundle/index.html") };
      const e = event(child);
      const committedUrls = committed(e, "app://bundle/index.html");
      await expect(
        guardPrivileged("fs:write", handler, { committedUrls, warn: vi.fn() })(e),
      ).rejects.toThrow("Not allowed");
      expect(handler).not.toHaveBeenCalled();
    });

    it("judges the frame for a window with no commit recorded yet", async () => {
      const handler = vi.fn(async () => "read");
      const other = event(top("app://bundle/index.html"));
      const committedUrls = committed(other, PLUGIN_FILE);
      const guarded = guardPrivileged("fs:read", handler, { committedUrls, warn: vi.fn() });
      await expect(guarded(event(top("app://bundle/index.html")))).resolves.toBe("read");
      await expect(guarded(event(top(PLUGIN_FILE)))).rejects.toThrow("Not allowed");
    });
  });

  // The frame can navigate away at any await, and fs:write must be queued
  // before the handler returns so the quit-time drain sees it.
  it("reads the sender and starts the handler before anything awaits", () => {
    let reads = 0;
    const e = {
      get senderFrame() {
        reads += 1;
        return top("app://bundle/index.html");
      },
      sender: { getURL: () => "app://bundle/index.html" },
    };
    const handler = vi.fn(async () => null);
    const pending = guardPrivileged("fs:write", handler)(e);
    expect(reads).toBe(1);
    expect(handler).toHaveBeenCalledTimes(1);
    return pending;
  });
});

describe("indexRedirectFor", () => {
  it.each(APP_DOCUMENTS)("leaves %s where it is", (url) => {
    expect(indexRedirectFor(url)).toBeNull();
  });

  // A reload re-requests whatever path pushState left, and the protocol serves
  // index.html for a path it doesn't know.
  it.each([
    [PLUGIN_FILE, "app://bundle/index.html"],
    [`${PLUGIN_FILE}?detached=library`, "app://bundle/index.html?detached=library"],
    ["app://bundle/library?devtools=1#top", "app://bundle/index.html?devtools=1"],
  ])("sends a window that committed %s to %s", (url, target) => {
    expect(indexRedirectFor(url)).toBe(target);
    expect(indexRedirectFor(target)).toBeNull();
  });

  it.each([
    "https://x/a",
    "devtools://devtools/bundled/devtools_app.html",
    "about:blank",
    "not a url",
  ])("leaves %s to the other policies", (url) => {
    expect(indexRedirectFor(url)).toBeNull();
  });
});
