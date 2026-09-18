// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The detail page's update states: a version this build can't run is explained
// without an Update button; one that failed to start here is explained and can
// be retried. No bridge is stubbed, so the GitHub fetches no-op.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ExtensionDetail, type DetailTarget } from "./ExtensionDetail";
import { useExtStoreUI, type ExtUpdateInfo } from "./store-ui";

const ID = "acme.widget";

const target: DetailTarget = {
  repo: "acme/widget",
  id: ID,
  name: "Widget",
  installed: true,
  manifest: { id: ID, name: "Widget", version: "1.0.0", main: "index.js" },
  enabled: true,
  locked: false,
  hasSettings: false,
};

const record = (over: Partial<ExtUpdateInfo>): ExtUpdateInfo => ({
  latestTag: "2.1.0",
  hasUpdate: true,
  requiresApp: null,
  failed: null,
  checkedAt: Date.now(),
  ...over,
});

const mount = (update: ExtUpdateInfo) => {
  useExtStoreUI.setState({ updates: { [ID]: update } });
  render(
    <ExtensionDetail
      target={target}
      busy={null}
      onInstall={vi.fn()}
      onUpdate={vi.fn()}
      onUninstall={vi.fn()}
      onToggle={vi.fn()}
      onSettings={vi.fn()}
    />,
  );
};

beforeEach(() => {
  useExtStoreUI.setState({ updates: {}, meta: {}, readme: {} });
});

describe("ExtensionDetail update states", () => {
  it("offers an installable update", () => {
    mount(record({}));
    screen.getByRole("button", { name: "Update to 2.1.0" });
  });

  it("explains an update this build can't run instead of offering it", () => {
    mount(record({ requiresApp: "99.0.0" }));
    screen.getByText(/Version 2\.1\.0 requires Safelight 99\.0\.0 or newer/);
    expect(screen.queryByRole("button", { name: /^Update to/ })).toBeNull();
  });

  it("explains a failed start and still allows a retry", () => {
    mount(record({ failed: { version: "2.1.0", error: "boom" } }));
    screen.getByText("Version 2.1.0 didn't start on this build; 1.0.0 was restored.");
    screen.getByRole("button", { name: "Update to 2.1.0" });
  });
});
