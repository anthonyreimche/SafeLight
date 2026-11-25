// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Where app:// serves an extension's files (electron/app-protocol.cjs): its
// bundle as the loader imports it, and any file it reaches with api.assetUrl.

import { describe, expect, it } from "vitest";
import { pluginFileUrl } from "./plugin-url";

describe("pluginFileUrl", () => {
  const origin = "app://bundle";

  it("is the file under /__plugins__/<id>/, cache-busted by the version", () => {
    expect(pluginFileUrl(origin, "lens-blur", "dist/index.js", "1.0.1")).toBe("app://bundle/__plugins__/lens-blur/dist/index.js?v=1.0.1");
  });

  it("encodes each path segment and drops leading slashes", () => {
    expect(pluginFileUrl(origin, "acme", "/dist/my file#1.wasm", "1.0.0-beta+2")).toBe(
      "app://bundle/__plugins__/acme/dist/my%20file%231.wasm?v=1.0.0-beta%2B2",
    );
  });

  it("leaves the query off without a version", () => {
    expect(pluginFileUrl(origin, "acme", "dist/a.wasm")).toBe("app://bundle/__plugins__/acme/dist/a.wasm");
  });
});
