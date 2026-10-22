// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createVariableRegistry } from "../variables";
import { VariablesTab } from "./VariablesTab";

afterEach(cleanup);

function registry() {
  return createVariableRegistry({ window: { id: "w1", label: "main" }, transport: null, warn: () => {} });
}

describe("VariablesTab", () => {
  it("says so when no extension has registered a variable", () => {
    render(<VariablesTab registry={registry()} />);
    expect(screen.getByText(/No shared variables yet/)).toBeTruthy();
  });

  it("lists variables with revision, size and refusals, and shows the selected one's detail", () => {
    const reg = registry();
    const map = reg.scoped("map");
    map.register("map.overlays", { initial: {}, description: "Lines and points drawn on the Map." });
    map.set("map.overlays", { a: 1 });
    reg.scoped("gps-track").set("map.overlays", { b: 2 }); // never read it: stale
    render(<VariablesTab registry={reg} />);
    const item = screen.getByRole("button", { name: /map\.overlays/ });
    expect(item.textContent).toContain("rev 1");
    expect(screen.getByLabelText("1 refused or lost")).toBeTruthy();
    expect(screen.getByText("Lines and points drawn on the Map.")).toBeTruthy();
    expect(screen.getByText("map (this window)", { selector: "dd" })).toBeTruthy();
    expect(screen.getByText(/refused: hadn't seen rev 1 by map \(this window\)/)).toBeTruthy();
    expect(screen.getByText(/"a": 1/)).toBeTruthy();
  });

  it("shows each variable's last writer in the list", () => {
    const reg = registry();
    reg.scoped("map").register("map.overlays", { initial: {} });
    const gps = reg.scoped("gps-track");
    gps.get("map.overlays");
    gps.set("map.overlays", { track: 1 });
    render(<VariablesTab registry={reg} />);
    const item = screen.getByRole("button", { name: /map\.overlays/ });
    expect(item.textContent).toContain("gps-track (this window)");
  });

  it("shows the value in an open, collapsible section", () => {
    const reg = registry();
    const map = reg.scoped("map");
    map.register("map.overlays", { initial: {} });
    map.set("map.overlays", { a: 1 });
    render(<VariablesTab registry={reg} />);
    const details = screen.getByText(/"a": 1/).closest("details");
    expect(details).not.toBeNull();
    expect(details?.open).toBe(true);
    expect(details?.querySelector("summary")?.textContent).toBe("Value");
  });

  it("follows changes", () => {
    const reg = registry();
    const map = reg.scoped("map");
    map.register("map.overlays", { initial: {} });
    render(<VariablesTab registry={reg} />);
    act(() => void map.set("map.overlays", { z: 1 }));
    expect(screen.getByRole("button", { name: /map\.overlays/ }).textContent).toContain("rev 1");
  });

  it("Edit value writes as core.devtools", () => {
    const reg = registry();
    reg.scoped("map").register("map.overlays", { initial: {} });
    render(<VariablesTab registry={reg} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
    fireEvent.change(screen.getByLabelText("New value (JSON)"), { target: { value: '{"z": 3}' } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const s = reg.scoped("anyone").get<{ z: number }>("map.overlays");
    expect(s?.value).toEqual({ z: 3 });
    expect(s?.writer.extension).toBe("core.devtools");
    expect(screen.getByText("Saved as revision 1.")).toBeTruthy();
  });

  it("shows a stale save and invalid JSON inline, changing nothing", () => {
    const reg = registry();
    const map = reg.scoped("map");
    map.register("map.overlays", { initial: {} });
    render(<VariablesTab registry={reg} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit value" }));
    fireEvent.change(screen.getByLabelText("New value (JSON)"), { target: { value: "{" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/^Not valid JSON:/)).toBeTruthy();
    act(() => void map.set("map.overlays", { by: "map" }));
    fireEvent.change(screen.getByLabelText("New value (JSON)"), { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByText(/map \(this window\) changed it since you opened the editor/)).toBeTruthy();
    expect(reg.scoped("anyone").get("map.overlays")?.value).toEqual({ by: "map" });
  });
});
