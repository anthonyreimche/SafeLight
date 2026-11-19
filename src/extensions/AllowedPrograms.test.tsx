// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The extension page's Permissions section for an extension that declares
// programs: what the permission means, and the programs the person allowed,
// each with a way to forget it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { NativeProgramsBridge } from "./api/native-bridge";

const h = vi.hoisted(() => ({ programs: null as NativeProgramsBridge | null }));
vi.mock("@/native/privileged", () => ({ privilegedPrograms: () => h.programs }));

import { AllowedPrograms } from "./AllowedPrograms";

afterEach(() => {
  cleanup();
  h.programs = null;
});

function bridge(initial: { token: string; path: string; name: string }[]) {
  let kept = [...initial];
  const b = {
    pick: vi.fn(async () => null),
    locate: vi.fn(async () => null),
    list: vi.fn(async () => kept),
    forget: vi.fn(async (_id: string, token: string) => {
      kept = kept.filter((p) => p.token !== token);
    }),
    run: vi.fn(async () => ({})),
    cancel: vi.fn(async () => {}),
    onOutput: vi.fn(() => () => {}),
  };
  h.programs = b;
  return b;
}

describe("AllowedPrograms", () => {
  it("lists the programs an installed extension may run and forgets one", async () => {
    const b = bridge([
      { token: "t1", path: "C:\\Tools\\gmic.exe", name: "gmic.exe" },
      { token: "t2", path: "C:\\Tools\\other.exe", name: "other.exe" },
    ]);
    render(<AllowedPrograms extensionId="gmic" installed />);
    expect(screen.getByText(/runs a program on this computer that you choose/i)).toBeTruthy();
    expect(await screen.findByText("C:\\Tools\\gmic.exe")).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: "Forget" });
    await userEvent.click(buttons[0]);
    expect(b.list).toHaveBeenCalledWith("gmic");
    expect(b.forget).toHaveBeenCalledWith("gmic", "t1");
    expect(screen.queryByText("C:\\Tools\\gmic.exe")).toBeNull();
    expect(screen.getByText("C:\\Tools\\other.exe")).toBeTruthy();
  });

  it("only explains the permission for an extension that isn't installed", () => {
    const b = bridge([{ token: "t1", path: "/usr/bin/gmic", name: "gmic" }]);
    render(<AllowedPrograms extensionId="gmic" installed={false} />);
    expect(screen.getByText(/runs a program on this computer that you choose/i)).toBeTruthy();
    expect(b.list).not.toHaveBeenCalled();
  });

  it("ignores a kept program the bridge describes badly", async () => {
    const b = bridge([]);
    b.list.mockResolvedValue([{ token: "t1", path: "/usr/bin/gmic", name: "gmic" }, { token: 4 }, null] as never);
    render(<AllowedPrograms extensionId="gmic" installed />);
    expect(await screen.findByText("/usr/bin/gmic")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Forget" })).toHaveLength(1);
  });
});
