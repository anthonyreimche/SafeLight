// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether this computer can start the image engine, read once per session, and the
// one explanation Develop, Export and the main window's notice give when it can't.
// The canvas is faked: Chromium says why a context couldn't be made on a
// webglcontextcreationerror event fired during getContext.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  gpu: null as {
    backend: () => Promise<unknown>;
    setSoftware: (on: boolean) => Promise<unknown>;
  } | null,
}));

vi.mock("@/native/privileged", () => ({ privilegedGpu: () => h.gpu }));

import {
  GRAPHICS_STILL_WORKS,
  GRAPHICS_UNAVAILABLE,
  graphicsUnavailableDetail,
  probeGraphics,
  readGpuBackend,
  trySoftwareRendering,
  useGraphics,
} from "./graphics-store";

function fakeCanvas(webgl2: boolean, statusMessage = "") {
  const listeners: ((e: { statusMessage: string }) => void)[] = [];
  return {
    addEventListener: (type: string, cb: (e: { statusMessage: string }) => void) => {
      if (type === "webglcontextcreationerror") listeners.push(cb);
    },
    getContext: (type: string) => {
      if (type !== "webgl2") return null;
      if (webgl2) return { getExtension: () => ({ loseContext: () => undefined }) };
      for (const cb of listeners) cb({ statusMessage });
      return null;
    },
  };
}

beforeEach(() => {
  useGraphics.setState({
    webgl2: "unknown",
    reason: null,
    software: null,
    nextSoftware: null,
    noticeDismissed: false,
  });
  h.gpu = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeGraphics", () => {
  it("finds WebGL2", () => {
    vi.stubGlobal("document", { createElement: () => fakeCanvas(true) });
    expect(probeGraphics()).toMatchObject({ webgl2: "yes", reason: null });
  });

  it("gives the browser's own reason when WebGL2 can't start", () => {
    vi.stubGlobal("document", {
      createElement: () => fakeCanvas(false, "Could not create a WebGL2 context, VENDOR = 0xffff"),
    });
    expect(probeGraphics()).toMatchObject({
      webgl2: "no",
      reason: "Could not create a WebGL2 context, VENDOR = 0xffff",
    });
  });

  it("says WebGL2 isn't supported when the browser gives no reason", () => {
    vi.stubGlobal("document", { createElement: () => fakeCanvas(false) });
    expect(probeGraphics()).toMatchObject({ webgl2: "no", reason: "WebGL2 not supported" });
  });

  it("keeps a missing WebGL2 for the session", () => {
    const createElement = vi.fn(() => fakeCanvas(false));
    vi.stubGlobal("document", { createElement });
    probeGraphics();
    probeGraphics();
    expect(createElement).toHaveBeenCalledTimes(1);
    expect(useGraphics.getState().webgl2).toBe("no");
  });

  // WebGL2 can go later in the session (a GPU process that gave up), so a "yes"
  // is only as good as the last look.
  it("looks again after finding WebGL2, and sees it go", () => {
    let webgl2 = true;
    vi.stubGlobal("document", { createElement: () => fakeCanvas(webgl2, "GPU process lost") });
    expect(probeGraphics().webgl2).toBe("yes");
    webgl2 = false;
    expect(probeGraphics()).toMatchObject({ webgl2: "no", reason: "GPU process lost" });
  });
});

describe("the software backend", () => {
  it("is unknown where Safelight doesn't choose it", async () => {
    await readGpuBackend();
    expect(useGraphics.getState()).toMatchObject({ software: null, nextSoftware: null });
  });

  it("reads which backend this launch and the next draw with", async () => {
    h.gpu = {
      backend: async () => ({ software: false, nextSoftware: false, reason: null }),
      setSoftware: async () => null,
    };
    await readGpuBackend();
    expect(useGraphics.getState()).toMatchObject({ software: false, nextSoftware: false });
  });

  it("asks the next launch to draw in software", async () => {
    const setSoftware = vi.fn(async (on: boolean) => ({
      software: false,
      nextSoftware: on,
      reason: "chosen",
    }));
    h.gpu = { backend: async () => null, setSoftware };
    await trySoftwareRendering();
    expect(setSoftware).toHaveBeenCalledWith(true);
    expect(useGraphics.getState()).toMatchObject({ software: false, nextSoftware: true });
  });
});

describe("the words for a missing WebGL2", () => {
  it("say it plainly, with no browser message", () => {
    expect(GRAPHICS_UNAVAILABLE).toBe("This computer can't run Safelight's image engine.");
  });

  it("keep WebGL2 and the reason for the detail", () => {
    expect(graphicsUnavailableDetail("WebGL2 not supported")).toBe(
      "WebGL2 couldn't start: WebGL2 not supported.",
    );
  });

  it("says what still works", () => {
    expect(GRAPHICS_STILL_WORKS).toBe(
      "You can still browse, rate and organise photos; editing and export need graphics support.",
    );
  });
});
