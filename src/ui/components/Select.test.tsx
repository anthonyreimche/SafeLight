// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the app's dropdown. The menu is portalled to <body>, so everything
// is queried through `screen` rather than the render container.

import { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { popEscapeHandler } from "@/ui/escape-stack";
import { Select, type SelectGroup, type SelectOption, type SelectProps } from "./Select.tsx";

const OPTIONS: SelectOption[] = [
  { value: "alpha", label: "Alpha" },
  { value: "beta", label: "Beta", disabled: true },
  { value: "gamma", label: "Gamma" },
];

const FRUIT: SelectOption[] = [
  { value: "apple", label: "Apple" },
  { value: "apricot", label: "Apricot" },
  { value: "banana", label: "Banana" },
];

const GROUPS: SelectGroup[] = [
  { title: "Grain", items: [{ value: "g.amount", label: "Amount" }] },
  {
    title: "Halation",
    items: [
      { value: "h.amount", label: "Amount" },
      { value: "h.radius", label: "Radius" },
    ],
  },
];

type HarnessProps = Partial<Omit<SelectProps, "onChange">> & {
  onChange?: (value: string) => void;
};

function Harness({ onChange, initialValue = "alpha", ...rest }: HarnessProps & { initialValue?: string }) {
  const [value, setValue] = useState(initialValue);
  return (
    <Select
      options={OPTIONS}
      ariaLabel="Preset"
      {...rest}
      value={value}
      onChange={(v) => {
        setValue(v);
        onChange?.(v);
      }}
    />
  );
}

const trigger = () => screen.getByRole("combobox", { name: "Preset" });

/** Label of the option named by aria-activedescendant — which also proves the
 *  reference resolves to a real element in the portalled listbox. */
function activeLabel(): string | null {
  const id = trigger().getAttribute("aria-activedescendant");
  if (!id) return null;
  const el = document.getElementById(id);
  expect(screen.getByRole("listbox").contains(el)).toBe(true);
  return el?.textContent ?? null;
}

describe("Select trigger", () => {
  it("shows the selected option's label, or the placeholder when nothing matches", () => {
    const { unmount } = render(<Harness initialValue="gamma" />);
    expect(trigger().textContent).toContain("Gamma");
    unmount();

    render(<Harness initialValue="not-an-option" placeholder="Choose…" />);
    expect(trigger().textContent).toContain("Choose…");
  });

  it("qualifies the label with its group heading so the closed state is unambiguous", () => {
    render(<Harness groups={GROUPS} initialValue="h.amount" />);
    expect(trigger().textContent).toContain("Halation · Amount");
  });

  it("reports collapsed state and controls nothing until it is opened", () => {
    render(<Harness />);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(trigger().getAttribute("aria-controls")).toBeNull();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stays shut when disabled", async () => {
    const user = userEvent.setup();
    render(<Harness disabled />);
    await user.click(trigger());
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Select menu", () => {
  it("opens on click and points aria-controls at the listbox it opened", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());

    const listbox = screen.getByRole("listbox", { name: "Preset" });
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(trigger().getAttribute("aria-controls")).toBe(listbox.id);
    expect(listbox.parentElement).toBe(document.body);
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  it("marks only the current value as selected, and disabled options as disabled", async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="gamma" />);
    await user.click(trigger());

    expect(screen.getByRole("option", { name: "Gamma" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("option", { name: "Alpha" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("option", { name: "Beta" }).getAttribute("aria-disabled")).toBe("true");
  });

  it("selects on click, closes, and hands focus back to the trigger", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Gamma" }));

    expect(onChange).toHaveBeenCalledWith("gamma");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
    expect(trigger().textContent).toContain("Gamma");
  });

  it("ignores a click on a disabled option and stays open", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.click(screen.getByRole("option", { name: "Beta" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("listbox")).toBeTruthy();
  });

  it("closes when the pointer goes down outside it", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    await user.click(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders group headings without exposing them as options", async () => {
    const user = userEvent.setup();
    render(<Harness groups={GROUPS} initialValue="g.amount" />);
    await user.click(trigger());

    expect(screen.getByText("Halation")).toBeTruthy();
    expect(screen.getAllByRole("option")).toHaveLength(3);
  });

  it("survives a malformed groups/options payload", () => {
    // Extension `select` settings fields are untyped at the boundary; one bad
    // entry must not throw, because a render crash here strands global
    // listeners' effect cleanup.
    const ragged = [{ title: "Bad" }, { items: [null, OPTIONS[0]] }] as unknown as SelectGroup[];
    render(<Harness groups={ragged} />);
    expect(trigger().textContent).toContain("Alpha");
  });
});

describe("Select keyboard", () => {
  it("opens from ArrowDown with the current selection active", async () => {
    const user = userEvent.setup();
    render(<Harness initialValue="gamma" />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");

    expect(screen.getByRole("listbox")).toBeTruthy();
    expect(activeLabel()).toBe("Gamma");
  });

  it("moves the active option with the arrows, skipping disabled entries and wrapping", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Alpha");

    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Gamma");

    await user.keyboard("{ArrowDown}");
    expect(activeLabel()).toBe("Alpha");

    await user.keyboard("{ArrowUp}");
    expect(activeLabel()).toBe("Gamma");
  });

  it("crosses group boundaries as one flat list", async () => {
    const user = userEvent.setup();
    render(<Harness groups={GROUPS} initialValue="g.amount" />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}");

    const [, halationAmount] = screen.getAllByRole("option");
    expect(trigger().getAttribute("aria-activedescendant")).toBe(halationAmount.id);
  });

  it("jumps to the first and last enabled option with Home and End", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        options={[
          { value: "x", label: "Xylem", disabled: true },
          { value: "y", label: "Yarrow" },
          { value: "z", label: "Zinnia" },
          { value: "w", label: "Wattle", disabled: true },
        ]}
        initialValue="y"
      />,
    );
    trigger().focus();
    await user.keyboard("{ArrowDown}{End}");
    expect(activeLabel()).toBe("Zinnia");

    await user.keyboard("{Home}");
    expect(activeLabel()).toBe("Yarrow");
  });

  it("commits the active option on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenCalledWith("gamma");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Escape without changing the value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    trigger().focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Escape}");

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on Tab and lets focus move on", async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <button type="button">After</button>
      </>,
    );
    trigger().focus();
    await user.keyboard("{ArrowDown}");
    await user.tab();

    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "After" }));
  });
});

describe("Select type-ahead", () => {
  afterEach(() => vi.restoreAllMocks());

  const openFruit = async (user: ReturnType<typeof userEvent.setup>) => {
    render(<Harness options={FRUIT} initialValue="apple" />);
    trigger().focus();
    await user.keyboard("{ArrowDown}");
  };

  it("jumps to the option starting with the typed letter", async () => {
    const user = userEvent.setup();
    await openFruit(user);
    await user.keyboard("b");
    expect(activeLabel()).toBe("Banana");
  });

  it("accumulates letters to disambiguate a shared first letter", async () => {
    const user = userEvent.setup();
    await openFruit(user);
    await user.keyboard("apr");
    expect(activeLabel()).toBe("Apricot");
  });

  it("starts a fresh prefix once typing pauses", async () => {
    const user = userEvent.setup();
    // The component clocks the pause off Date.now, so move it rather than the
    // real timers user-event is driving its own key delays with.
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    await openFruit(user);

    await user.keyboard("a");
    expect(activeLabel()).toBe("Apple");

    clock.mockReturnValue(2_000);
    await user.keyboard("b");
    expect(activeLabel()).toBe("Banana");
  });
});

describe("Select escape-stack registration", () => {
  /** What the app's global Escape handler does: run the topmost registration. */
  const globalEscape = () => {
    let consumed = false;
    act(() => {
      consumed = popEscapeHandler();
    });
    return consumed;
  };

  it("registers only while open, so the app's global Escape closes the menu first", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(globalEscape()).toBe(false);

    await user.click(trigger());
    expect(globalEscape()).toBe(true);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(globalEscape()).toBe(false);
  });

  it("unregisters when unmounted while still open", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Harness />);
    await user.click(trigger());
    unmount();

    expect(globalEscape()).toBe(false);
  });
});
