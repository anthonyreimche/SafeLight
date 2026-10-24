// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// An extension's panel in a mask's Adjust tab. Its values run the extension's
// stage inside the mask only on photos at the current processing; on a photo
// with older processing the tab says so instead of offering a panel that would
// do nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store's mutations broadcast to sibling windows; that side effect is not
// under test and needs no BroadcastChannel here.
vi.mock("@/state/broadcast", () => ({
  broadcast: () => {},
  onBroadcast: () => () => {},
  WINDOW_ID: "test-window",
}));

import { useEffect } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  UPDATE_PROCESSING_LABEL,
  defaultMaskAdjustments,
  normalizeParams,
  type Mask,
} from "@/catalog/types";
import { registerStageParams, unregisterStageParams } from "@/extensions/param-registry";
import { useRegistry, type RegisteredPanel } from "@/extensions/registry";
import { useParamScope } from "@/modules/develop/mask-scope";
import { useDevelopStore } from "@/state/develop-store";
import { MasksPanel } from "./MasksPanel";

let mounts = 0;

function GainBody() {
  const scope = useParamScope();
  useEffect(() => {
    mounts++;
  }, []);
  return <span>gain {String(scope.getParam("acme.gain.amount"))}</span>;
}

const GAIN_PANEL: RegisteredPanel = {
  id: "acme.gain-panel",
  title: "Gain",
  component: GainBody,
  extensionId: "acme",
  mask: { component: GainBody, owns: ["acme.gain.amount"] },
} as RegisteredPanel;

const MASK: Mask = {
  id: "m1",
  name: "Mask 1",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [
    { id: "c1", kind: "linear", mode: "add", invert: false, linear: { x0: 0, y0: 0, x1: 1, y1: 0 } },
  ],
};

function seed(processVersion: number, mask: Partial<Mask> = {}) {
  const params = normalizeParams({ processVersion, masks: [{ ...MASK, ...mask }] });
  useDevelopStore.setState({
    photoId: "photo-1",
    params,
    paramBag: {},
    history: [{ timestamp: 0, label: "Original", params, paramBag: {} }],
    historyIndex: 0,
    selectedMaskId: "m1",
    maskTab: "adjust",
  });
}

const addButton = () => screen.getByRole("button", { name: "+ Gain" });

beforeEach(() => {
  registerStageParams("acme.gain", "Gain", "acme", [{ key: "amount", glslType: "float", default: 1 }]);
  useRegistry.setState({ panels: { [GAIN_PANEL.id]: GAIN_PANEL } });
});

afterEach(() => {
  unregisterStageParams("acme.gain");
  useRegistry.setState({ panels: {} });
});

describe("an extension panel in a mask's Adjust tab", () => {
  it("adds to a mask on a photo at the current processing, seeding the mask's values", async () => {
    seed(CURRENT_PROCESS_VERSION);
    render(<MasksPanel />);
    await userEvent.setup().click(addButton());
    const mask = useDevelopStore.getState().params.masks[0];
    expect(mask.panels).toEqual(["acme.gain-panel"]);
    expect(mask.bag).toEqual({ "acme.gain.amount": 1 });
    expect(screen.getByText("gain 1")).toBeTruthy();
  });

  // A sub-panel's own state (a field being typed in, a listener it attached)
  // belongs to the mask it was mounted for.
  it("mounts its sub-panel afresh for each mask selected", () => {
    const second: Mask = { ...MASK, id: "m2", name: "Mask 2", panels: ["acme.gain-panel"], bag: { "acme.gain.amount": 3 } };
    seed(CURRENT_PROCESS_VERSION, { panels: ["acme.gain-panel"], bag: { "acme.gain.amount": 2 } });
    useDevelopStore.setState((s) => ({ params: { ...s.params, masks: [...s.params.masks, second] } }));
    mounts = 0;
    render(<MasksPanel />);
    expect(screen.getByText("gain 2")).toBeTruthy();
    act(() => useDevelopStore.setState({ selectedMaskId: "m2" }));
    expect(screen.getByText("gain 3")).toBeTruthy();
    expect(mounts).toBe(2);
  });

  it("can't be added on a photo with older processing, and says why", () => {
    seed(LEGACY_PROCESS_VERSION);
    render(<MasksPanel />);
    expect(addButton()).toHaveProperty("disabled", true);
    expect(addButton().getAttribute("title")).toContain(UPDATE_PROCESSING_LABEL);
  });

  it("shows one a photo with older processing already has as not applied, and removable", async () => {
    seed(LEGACY_PROCESS_VERSION, { panels: ["acme.gain-panel"], bag: { "acme.gain.amount": 2 } });
    render(<MasksPanel />);
    expect(screen.queryByText("gain 2")).toBeNull();
    expect(screen.getByText(/needs Update processing/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "×", description: /Remove Gain/ }));
    expect(useDevelopStore.getState().params.masks[0].panels).toEqual([]);
  });
});
