// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The extension page's Permissions section for an extension that declares
// userSockets: what the permission means, and the addresses the person
// allowed, each with a way to disconnect it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativeSocketsBridge } from "./api/native-bridge";

const h = vi.hoisted(() => ({ sockets: null as NativeSocketsBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedSockets: () => h.sockets }));

import { AllowedSockets } from "./AllowedSockets";

afterEach(() => {
  cleanup();
  h.sockets = null;
});

function bridge(initial: string[]) {
  let allowed = [...initial];
  const b = {
    request: vi.fn(async () => "not-allowed"),
    status: vi.fn(async () => "not-allowed"),
    list: vi.fn(async () => allowed),
    revoke: vi.fn(async (_id: string, url: string) => {
      allowed = allowed.filter((a) => a !== url);
    }),
  };
  h.sockets = b;
  return b;
}

describe("AllowedSockets", () => {
  it("lists the allowed addresses of an installed extension and disconnects one", async () => {
    const b = bridge(["wss://relay.studio.example", "wss://backup.studio.example"]);
    render(<AllowedSockets extensionId="studio-collab" installed />);
    expect(screen.getByText(/live connections to a server address you enter/i)).toBeTruthy();
    expect(await screen.findByText("wss://relay.studio.example")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Disconnect" });
    await userEvent.click(buttons[0]);
    expect(b.list).toHaveBeenCalledWith("studio-collab");
    expect(b.revoke).toHaveBeenCalledWith("studio-collab", "wss://relay.studio.example");
    expect(await screen.findByText(/next time Safelight starts/i)).toBeTruthy();
    expect(screen.queryByText("wss://relay.studio.example")).toBeNull();
  });

  it("only explains the permission for an extension that isn't installed", () => {
    const b = bridge(["wss://relay.studio.example"]);
    render(<AllowedSockets extensionId="studio-collab" installed={false} />);
    expect(screen.getByText(/live connections to a server address you enter/i)).toBeTruthy();
    expect(b.list).not.toHaveBeenCalled();
  });
});
