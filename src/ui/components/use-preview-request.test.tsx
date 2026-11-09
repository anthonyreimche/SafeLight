// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A cell that asked for its preview and then unmounts withdraws the request.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

const loader = vi.hoisted(() => ({
  requestThumbnail: vi.fn(),
  cancelThumbnail: vi.fn(),
}));
vi.mock("@/state/thumbnail-loader", () => loader);

import { usePreviewRequest } from "./use-preview-request";

let observers: { cb: IntersectionObserverCallback }[] = [];

beforeEach(() => {
  observers = [];
  loader.requestThumbnail.mockReset();
  loader.requestThumbnail.mockReturnValue(true);
  loader.cancelThumbnail.mockClear();
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(cb: IntersectionObserverCallback) {
        observers.push({ cb });
      }
      observe(): void {}
      disconnect(): void {}
    },
  );
});
afterEach(() => vi.unstubAllGlobals());

function Cell({ id }: { id: string }) {
  const ref = usePreviewRequest<HTMLDivElement>(id, true);
  return <div ref={ref} />;
}

describe("usePreviewRequest", () => {
  it("cancels the request on unmount once it asked", () => {
    const view = render(<Cell id="a" />);
    act(() => {
      observers[0].cb([{ isIntersecting: true }] as never, {} as never);
    });
    expect(loader.requestThumbnail).toHaveBeenCalledWith("a", { visible: true });
    view.unmount();
    expect(loader.cancelThumbnail).toHaveBeenCalledWith("a");
  });

  it("cancels nothing when the loader took no hold for the request", () => {
    loader.requestThumbnail.mockReturnValueOnce(false);
    const view = render(<Cell id="a" />);
    act(() => {
      observers[0].cb([{ isIntersecting: true }] as never, {} as never);
    });
    view.unmount();
    expect(loader.cancelThumbnail).not.toHaveBeenCalled();
  });

  it("cancels nothing for a cell that never came near the viewport", () => {
    const view = render(<Cell id="a" />);
    view.unmount();
    expect(loader.cancelThumbnail).not.toHaveBeenCalled();
  });
});
