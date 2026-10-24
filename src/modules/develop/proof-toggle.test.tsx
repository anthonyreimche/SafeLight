// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop's status-bar Proof button. Soft proofing is a version 3 feature, so the
// button is there only for a photo stored as one, and its pressed state is the
// view's proof flag.

import { beforeEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { normalizeParams } from "@/catalog/types";
import { useDevelopStore } from "@/state/develop-store";
import { ProofToggle } from "./DevelopView";

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline.
const INITIAL = useDevelopStore.getState();

const NAME = "Toggle soft proof";
const proof = () => screen.getByRole("button", { name: NAME });
const maybeProof = () => screen.queryByRole("button", { name: NAME });
const seedPhoto = (processVersion: number) =>
  useDevelopStore.setState({ params: normalizeParams({ processVersion }) });

beforeEach(() => useDevelopStore.setState(INITIAL, true));

describe("ProofToggle", () => {
  it.each([1, 2])("is absent on a version %i photo", (version) => {
    seedPhoto(version);
    render(<ProofToggle />);
    expect(maybeProof()).toBeNull();
  });

  it("is there on a photo stored as version 3, with its tooltip", () => {
    seedPhoto(3);
    render(<ProofToggle />);
    expect(proof().getAttribute("title")).toBe("Soft proof (S): preview the export color space");
    expect(proof().textContent).toBe("Proof");
  });

  it("follows the photo it is open on", () => {
    seedPhoto(3);
    render(<ProofToggle />);
    expect(maybeProof()).not.toBeNull();

    act(() => seedPhoto(2));
    expect(maybeProof()).toBeNull();
  });

  it("is pressed while the proof is on, and a click flips it", async () => {
    seedPhoto(3);
    const user = userEvent.setup();
    render(<ProofToggle />);
    expect(proof().getAttribute("aria-pressed")).toBe("false");

    await user.click(proof());
    expect(useDevelopStore.getState().proof).toBe(true);
    expect(proof().getAttribute("aria-pressed")).toBe("true");

    await user.click(proof());
    expect(useDevelopStore.getState().proof).toBe(false);
    expect(proof().getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a proof already on, as the shortcut leaves it", () => {
    seedPhoto(3);
    useDevelopStore.setState({ proof: true });
    render(<ProofToggle />);
    expect(proof().getAttribute("aria-pressed")).toBe("true");
  });
});
