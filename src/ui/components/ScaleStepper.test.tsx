// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The interface-scale control: − and + in 10% steps, the value announced
// politely, and focus kept on an end button that can't step any further.

import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ScaleStepper } from "./ScaleStepper";

function Harness({ start }: { start: number }) {
  const [value, setValue] = useState(start);
  return <ScaleStepper value={value} onChange={setValue} label="Interface scale" />;
}

const group = () => screen.getByRole("group", { name: "Interface scale" });
const increase = () =>
  within(group()).getByRole("button", { name: "Increase interface scale" });
const decrease = () =>
  within(group()).getByRole("button", { name: "Decrease interface scale" });
const shown = () => within(group()).getByText(/%$/).textContent;

describe("ScaleStepper", () => {
  it("is a named group with the value between − and +", () => {
    render(<Harness start={1} />);
    expect(shown()).toBe("100%");
    expect(decrease()).toBeTruthy();
    expect(increase()).toBeTruthy();
  });

  it("steps by ten percent", async () => {
    const user = userEvent.setup();
    render(<Harness start={1} />);
    await user.click(increase());
    expect(shown()).toBe("110%");
    await user.click(decrease());
    await user.click(decrease());
    expect(shown()).toBe("90%");
  });

  it("moves an in-between value up to the next stop", async () => {
    const user = userEvent.setup();
    render(<Harness start={1.05} />);
    expect(shown()).toBe("105%");
    await user.click(increase());
    expect(shown()).toBe("110%");
  });

  it("moves an in-between value down to the next stop", async () => {
    const user = userEvent.setup();
    render(<Harness start={1.05} />);
    await user.click(decrease());
    expect(shown()).toBe("100%");
  });

  it("stops at 200% without dropping focus", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScaleStepper value={2} onChange={onChange} label="Interface scale" />);
    expect(increase().getAttribute("aria-disabled")).toBe("true");
    expect((increase() as HTMLButtonElement).disabled).toBe(false);
    expect(decrease().getAttribute("aria-disabled")).toBeNull();
    increase().focus();
    await user.click(increase());
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(increase());
  });

  it("stops at 80%", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<ScaleStepper value={0.8} onChange={onChange} label="Interface scale" />);
    expect(decrease().getAttribute("aria-disabled")).toBe("true");
    await user.click(decrease());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("announces the value politely", () => {
    render(<Harness start={1} />);
    expect(within(group()).getByText("100%").getAttribute("aria-live")).toBe("polite");
  });
});
