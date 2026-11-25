// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shared colour control (#282): a swatch that opens a large picker under
// it, with a hex field and an eyedropper that samples the photo.

import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ColourField, type ColourFieldHost, type ColourFieldProps, type ColourValue } from "./ColourField";
import { usePickDragStore } from "@/modules/develop/pick-drag";
import { popEscapeHandler } from "@/ui/escape-stack";

const host = (sample: ColourFieldHost["sample"] = async () => null): ColourFieldHost => ({ owner: "ext.test", sample });

function setup(props: Partial<ColourFieldProps> & { host?: ColourFieldHost } = {}) {
  const onChange = vi.fn<(v: ColourValue) => void>();
  const onCommit = vi.fn();
  const utils = render(
    <ColourField
      label="Colour"
      hue={0}
      saturation={100}
      onChange={onChange}
      onCommit={onCommit}
      host={host()}
      {...props}
    />,
  );
  return { ...utils, onChange, onCommit };
}

const swatch = () => screen.getByRole("button", { name: "Colour" });
const open = () => fireEvent.click(swatch());

/** Give an element a 200×100 box at (10, 20) so pointer maths has a size. */
function sized(el: Element, width = 200, height = 100) {
  el.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width, height, right: 10 + width, bottom: 20 + height, x: 10, y: 20, toJSON() {} }) as DOMRect;
  return el;
}

afterEach(() => {
  usePickDragStore.setState({ held: null });
});

describe("ColourField", () => {
  it("shows the colour on a swatch that opens the picker", () => {
    setup({ hue: 120, saturation: 100 });
    expect(swatch().style.backgroundColor).toBe("rgb(0, 255, 0)");
    expect(swatch().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("slider")).toBeNull();
    open();
    expect(swatch().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("slider", { name: "Colour hue and saturation" })).toBeTruthy();
  });

  it("draws the swatch through the extension's own colour model", () => {
    setup({ hue: 10, saturation: 20, toRgb: () => [1, 1, 0] });
    expect(swatch().style.backgroundColor).toBe("rgb(255, 255, 0)");
  });

  it("sets hue across and saturation up the area, committing once on release", () => {
    const { onChange, onCommit } = setup();
    open();
    const area = sized(screen.getByRole("slider", { name: "Colour hue and saturation" }));
    fireEvent.pointerDown(area, { clientX: 60, clientY: 70, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 90, saturation: 50 });
    fireEvent.pointerMove(area, { clientX: 210, clientY: 20, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 360, saturation: 100 });
    fireEvent.pointerMove(area, { clientX: 500, clientY: 500, pointerId: 1 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 360, saturation: 0 });
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(area, { pointerId: 1 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("moves by keys, 10 with Shift, each a commit", () => {
    const { onChange, onCommit } = setup({ hue: 100, saturation: 95 });
    open();
    const area = screen.getByRole("slider", { name: "Colour hue and saturation" });
    fireEvent.keyDown(area, { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 101, saturation: 95 });
    fireEvent.keyDown(area, { key: "ArrowUp", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 100, saturation: 100 });
    fireEvent.keyDown(area, { key: "ArrowLeft", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 90, saturation: 95 });
    expect(onCommit).toHaveBeenCalledTimes(3);
  });

  it("is a hue bar when the field has no saturation", () => {
    const { onChange } = setup({ saturation: undefined });
    open();
    expect(screen.queryByRole("slider", { name: "Colour hue and saturation" })).toBeNull();
    const bar = sized(screen.getByRole("slider", { name: "Colour hue" }));
    fireEvent.pointerDown(bar, { clientX: 110, clientY: 99, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 180 });
  });

  it("adds a lightness bar when the field has lightness", () => {
    const { onChange } = setup({ hue: 0, saturation: 100, lightness: 50 });
    open();
    const bar = sized(screen.getByRole("slider", { name: "Colour lightness" }));
    fireEvent.pointerDown(bar, { clientX: 160, clientY: 25, pointerId: 1, button: 0 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 0, saturation: 100, lightness: 75 });
  });

  it("takes a hex colour through the extension's mapping", () => {
    const fromRgb = vi.fn(() => ({ hue: 33, saturation: 44, lightness: 55 }));
    const { onChange, onCommit } = setup({ hue: 0, saturation: 100, fromRgb });
    open();
    const hex = screen.getByRole("textbox", { name: "Colour hex" }) as HTMLInputElement;
    expect(hex.value).toBe("#ff0000");
    fireEvent.change(hex, { target: { value: "#00ff00" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(fromRgb).toHaveBeenCalledWith([0, 1, 0]);
    expect(onChange).toHaveBeenLastCalledWith({ hue: 33, saturation: 44 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it("puts back the hex of a typo instead of changing anything", () => {
    const { onChange } = setup();
    open();
    const hex = screen.getByRole("textbox", { name: "Colour hex" }) as HTMLInputElement;
    fireEvent.change(hex, { target: { value: "#zz" } });
    fireEvent.blur(hex);
    expect(onChange).not.toHaveBeenCalled();
    expect(hex.value).toBe("#ff0000");
  });

  it("closes on Escape", () => {
    setup();
    open();
    act(() => void popEscapeHandler());
    expect(swatch().getAttribute("aria-expanded")).toBe("false");
  });

  it("picks the colour the view shows from the photo", () => {
    const { onChange, onCommit } = setup({ hue: 0, saturation: 0 });
    fireEvent.click(screen.getByRole("button", { name: "Pick Colour from the photo" }));
    const held = usePickDragStore.getState().held;
    expect(held?.owner).toBe("ext.test");
    expect(screen.getByRole("button", { name: "Pick Colour from the photo" }).getAttribute("aria-pressed")).toBe("true");
    act(() => held!.tool.onDown!([0, 0, 1], { x: 5, y: 5 }));
    expect(onChange).toHaveBeenLastCalledWith({ hue: 240, saturation: 100 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(usePickDragStore.getState().held).toBeNull();
  });

  it("samples a capture with the extension's bag when it leaves its own effect out", async () => {
    const sample = vi.fn(async () => [1, 1, 0] as const);
    const { onChange } = setup({ host: host(sample), pick: { paramBag: { "ext.opacity": 0 } } });
    fireEvent.click(screen.getByRole("button", { name: "Pick Colour from the photo" }));
    const held = usePickDragStore.getState().held!;
    expect(held.tool.onDown).toBeUndefined();
    await act(async () => held.tool.onPress!({ x: 7, y: 8 }));
    expect(sample).toHaveBeenCalledWith({ x: 7, y: 8 }, { "ext.opacity": 0 });
    expect(onChange).toHaveBeenLastCalledWith({ hue: 60, saturation: 100 });
    expect(usePickDragStore.getState().held).toBeNull();
  });

  it("drops a pick the eyedropper let go of before the capture landed", async () => {
    let land!: (rgb: readonly [number, number, number]) => void;
    const sample = vi.fn(() => new Promise<readonly [number, number, number]>((r) => (land = r)));
    const { onChange } = setup({ host: host(sample), pick: { paramBag: {} } });
    const button = screen.getByRole("button", { name: "Pick Colour from the photo" });
    fireEvent.click(button);
    const held = usePickDragStore.getState().held!;
    held.tool.onPress!({ x: 1, y: 1 });
    fireEvent.click(button);
    await act(async () => land([1, 0, 0]));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("has no eyedropper with pick off", () => {
    setup({ pick: false });
    expect(screen.queryByRole("button", { name: "Pick Colour from the photo" })).toBeNull();
  });

  it("lets go of the eyedropper when it unmounts", () => {
    const { unmount } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Pick Colour from the photo" }));
    expect(usePickDragStore.getState().held).not.toBeNull();
    unmount();
    expect(usePickDragStore.getState().held).toBeNull();
  });

  it("follows a controlled value", () => {
    function Controlled() {
      const [v, setV] = useState<ColourValue>({ hue: 0, saturation: 100 });
      return (
        <ColourField label="Colour" hue={v.hue} saturation={v.saturation} onChange={setV} host={host()} />
      );
    }
    render(<Controlled />);
    open();
    const area = screen.getByRole("slider", { name: "Colour hue and saturation" });
    fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(area, { key: "ArrowRight", shiftKey: true });
    expect(area.getAttribute("aria-valuetext")).toBe("Hue 20°, saturation 100%");
  });
});
