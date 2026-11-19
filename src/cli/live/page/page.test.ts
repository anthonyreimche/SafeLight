// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LAMP_MS,
  SETTLE_MS,
  backoffDelay,
  clampView,
  createLiveView,
  fitView,
  frameRequest,
  keyAction,
  scaleBounds,
  sliderGeometry,
  statusOf,
  visibleRegion,
  zoomAt,
  type LiveEnv,
  type LiveState,
  type LiveView,
} from "./app.js";
import { APP_CSS, APP_JS, PAGE_HTML } from "./index";

const PHOTO = { width: 6000, height: 4000 };
const VIEWPORT = { width: 1200, height: 800 };
const BASE = "http://127.0.0.1:4173/v/token/";

describe("the bundled strings", () => {
  const onDisk = (name: string): string => readFileSync(path.resolve(__dirname, name), "utf-8").replace(/\r\n/g, "\n");

  // A failure here means a source file changed: run `node src/cli/live/page/generate.mjs`.
  it("match the files in this folder", () => {
    expect(PAGE_HTML === onDisk("index.html")).toBe(true);
    expect(APP_JS === onDisk("app.js")).toBe(true);
    expect(APP_CSS === onDisk("app.css")).toBe(true);
  });

  it("pass the page's content security policy", () => {
    const page = new DOMParser().parseFromString(PAGE_HTML, "text/html");
    const scripts = [...page.querySelectorAll("script")];
    expect(scripts.map((script) => [script.getAttribute("src"), script.textContent])).toEqual([["app.js", ""]]);
    expect([...page.querySelectorAll("link[rel=stylesheet]")].map((link) => link.getAttribute("href"))).toEqual(["app.css"]);
    for (const element of page.querySelectorAll("*")) {
      for (const attribute of element.attributes) {
        expect(attribute.name.startsWith("on")).toBe(false);
        if (attribute.name === "src" || attribute.name === "href") expect(attribute.value).not.toMatch(/^[a-z]+:|^\//i);
      }
    }
    expect(APP_JS).not.toMatch(/\beval\s*\(|new Function\b|innerHTML|document\.write/);
    expect(APP_CSS).not.toMatch(/url\(|@import/);
  });
});

describe("zoom and pan", () => {
  it("fits the whole photo, centred, inside the margin", () => {
    const view = fitView(PHOTO, VIEWPORT);
    expect(view.scale).toBeCloseTo(0.192, 5);
    expect(view.x).toBeCloseTo((1200 - 6000 * view.scale) / 2, 5);
    expect(view.y).toBeCloseTo((800 - 4000 * view.scale) / 2, 5);
    expect(visibleRegion(view, PHOTO, VIEWPORT)).toEqual({ x: 0, y: 0, zw: 1, zh: 1 });
  });

  it("keeps the photo point under the pointer when zooming", () => {
    const start = { scale: 0.5, x: -900, y: -600 };
    const point = { x: 300, y: 500 };
    const before = { u: (point.x - start.x) / start.scale, v: (point.y - start.y) / start.scale };
    const next = zoomAt(start, 1, point, PHOTO, VIEWPORT, 1);
    expect(next.scale).toBe(1);
    expect((point.x - next.x) / next.scale).toBeCloseTo(before.u, 6);
    expect((point.y - next.y) / next.scale).toBeCloseTo(before.v, 6);
  });

  it("holds zoom between fit and the ceiling", () => {
    const bounds = scaleBounds(PHOTO, VIEWPORT, 2);
    expect(bounds.actual).toBe(0.5);
    expect(zoomAt(fitView(PHOTO, VIEWPORT), 0.0001, { x: 0, y: 0 }, PHOTO, VIEWPORT, 2).scale).toBe(bounds.min);
    expect(zoomAt(fitView(PHOTO, VIEWPORT), 999, { x: 0, y: 0 }, PHOTO, VIEWPORT, 2).scale).toBe(bounds.max);
    expect(bounds.max).toBe(4);
  });

  it("never pans past an edge, and centres an axis that fits", () => {
    expect(clampView({ scale: 1, x: 500, y: -99999 }, PHOTO, VIEWPORT)).toEqual({ scale: 1, x: 0, y: 800 - 4000 });
    const wide = clampView({ scale: 0.25, x: -5000, y: 300 }, { width: 6000, height: 1000 }, VIEWPORT);
    expect(wide.x).toBe(1200 - 1500);
    expect(wide.y).toBe((800 - 250) / 2);
  });

  it("reports the visible region in 0…1 photo coordinates", () => {
    const region = visibleRegion({ scale: 1, x: -1500, y: -1000 }, PHOTO, VIEWPORT);
    expect(region).toEqual({ x: 0.25, y: 0.25, zw: 0.2, zh: 0.2 });
    for (const view of [{ scale: 2, x: 0, y: 0 }, { scale: 0.3, x: -600, y: -400 }, fitView(PHOTO, VIEWPORT)]) {
      const seen = visibleRegion(clampView(view, PHOTO, VIEWPORT), PHOTO, VIEWPORT);
      for (const edge of [seen.x, seen.y, seen.x + seen.zw, seen.y + seen.zh]) {
        expect(edge).toBeGreaterThanOrEqual(0);
        expect(edge).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it("asks for a fit frame at device-pixel size with no region", () => {
    const request = frameRequest({ rev: 7, view: fitView(PHOTO, VIEWPORT), photo: PHOTO, viewport: VIEWPORT, dpr: 2, before: false });
    expect(request.query).toBe("rev=7&w=2304&h=1536&before=0");
    expect(request.region).toEqual({ x: 0, y: 0, zw: 1, zh: 1 });
  });

  it("asks for a region when zoomed, never above the photo's own pixels", () => {
    const view = { scale: 1, x: -1500, y: -1000 };
    expect(frameRequest({ rev: 3, view, photo: PHOTO, viewport: VIEWPORT, dpr: 1, before: true }).query)
      .toBe("rev=3&w=1200&h=800&x=0.25&y=0.25&zw=0.2&zh=0.2&before=1");
    expect(frameRequest({ rev: 3, view, photo: PHOTO, viewport: VIEWPORT, dpr: 2, before: false }).query)
      .toBe("rev=3&w=1200&h=800&x=0.25&y=0.25&zw=0.2&zh=0.2&before=0");
  });
});

describe("small pieces", () => {
  it("places a value, and its default, along the bar", () => {
    expect(sliderGeometry({ value: 1, min: -5, max: 5, default: 0 })).toEqual({ at: 0.6, tick: 0.5 });
    expect(sliderGeometry({ value: 900, min: 0, max: 100, default: 0 })).toEqual({ at: 1, tick: 0 });
    expect(sliderGeometry({ value: "auto", min: 0, max: 100, default: 0 })).toBeNull();
    expect(sliderGeometry({ value: 4, min: 2, max: 2, default: 2 })).toBeNull();
    expect(sliderGeometry({ value: 4, min: 0, max: 8, default: null })).toEqual({ at: 0.5, tick: null });
  });

  it("backs off reconnects up to a ceiling", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoffDelay)).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
  });

  it("words the status line", () => {
    expect(statusOf({ connected: true, lost: false, engine: "ready", renderFailed: false })).toEqual({ tone: "live", text: "Live · synced with safelight" });
    expect(statusOf({ connected: true, lost: false, engine: "warming", renderFailed: false })).toEqual({ tone: "waiting", text: "Waiting for the engine…" });
    expect(statusOf({ connected: true, lost: false, engine: "failed", renderFailed: false })).toEqual({ tone: "stopped", text: "Engine stopped: see the terminal" });
    expect(statusOf({ connected: false, lost: true, engine: "ready", renderFailed: false }).text).toMatch(/^Lost the connection/);
    expect(statusOf({ connected: false, lost: false, engine: null, renderFailed: false }).tone).toBe("waiting");
  });

  it("maps keys to actions", () => {
    const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init);
    expect(keyAction(key({ key: "\\" }), false)).toBe("before");
    expect(keyAction(key({ key: "f" }), false)).toBe("fit");
    expect(keyAction(key({ key: "F" }), false)).toBe("fit");
    expect(keyAction(key({ key: "1" }), false)).toBe("actual");
    expect(keyAction(key({ key: "ArrowLeft" }), true)).toBe("prev");
    expect(keyAction(key({ key: "ArrowRight" }), true)).toBe("next");
    expect(keyAction(key({ key: "ArrowRight" }), false)).toBeNull();
    expect(keyAction(key({ key: "f", ctrlKey: true }), false)).toBeNull();
    expect(keyAction(key({ key: "x" }), true)).toBeNull();
  });
});

class FakeEventSource extends EventTarget {
  static made: FakeEventSource[] = [];
  closed = false;
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeEventSource.made.push(this);
  }
  close(): void {
    this.closed = true;
  }
  open(): void {
    this.dispatchEvent(new Event("open"));
  }
  state(rev: number): void {
    this.dispatchEvent(new MessageEvent("state", { data: JSON.stringify({ rev }) }));
  }
  fail(): void {
    this.dispatchEvent(new Event("error"));
  }
}

function makeState(over: Partial<LiveState> = {}): LiveState {
  return {
    slu: 1,
    rev: 1,
    photo: { name: "DSC_0042.NEF", relPath: "2026/DSC_0042.NEF", width: 6000, height: 4000, step: { at: 2, of: 3 }, rating: 3, flag: "pick", label: "green" },
    project: { name: "Coast" },
    values: [
      { tool: "Basic", key: "exposure", label: "Exposure", value: 1, display: "+1.00", min: -5, max: 5, default: 0, changed: true },
      { tool: "Basic", key: "contrast", label: "Contrast", value: 0, display: "0", min: -100, max: 100, default: 0, changed: false },
    ],
    history: [
      { index: 0, label: "Opened", current: false },
      { index: 1, label: "Exposure +1.00", current: true },
      { index: 2, label: "Contrast +10", current: false },
    ],
    working: null,
    engine: "ready",
    before: false,
    ...over,
  };
}

describe("the live view", () => {
  let state: LiveState;
  let frames: string[];
  let commands: unknown[];
  let finishFrame: (() => void)[];
  let holdFrames: boolean;
  let replaced: boolean;
  let live: LiveView;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const answer = (body: unknown): Response =>
    ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob(["jpeg"]) }) as Response;

  const env = (): LiveEnv => ({
    base: BASE,
    dpr: () => 1,
    EventSource: FakeEventSource,
    loadImage: async () => document.createElement("img"),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const route = url.pathname.slice(new URL(BASE).pathname.length);
      if (route === "state") return answer(state);
      if (route === "cmd") {
        commands.push(JSON.parse(String(init?.body)));
        return answer({});
      }
      frames.push(url.search.slice(1));
      if (holdFrames) await new Promise<void>((resolve) => finishFrame.push(resolve));
      if (replaced) return { ok: true, status: 204, blob: async () => new Blob([]) } as Response;
      return answer(null);
    },
  });

  const stage = (): HTMLElement => document.getElementById("stage")!;
  const press = (type: "keydown" | "keyup", key: string): void => {
    document.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true }));
  };
  const connect = async (): Promise<FakeEventSource> => {
    const source = FakeEventSource.made.at(-1)!;
    source.open();
    await flush();
    return source;
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    localStorage.clear();
    document.open();
    document.write(PAGE_HTML);
    document.close();
    Object.defineProperty(stage(), "clientWidth", { configurable: true, value: VIEWPORT.width });
    Object.defineProperty(stage(), "clientHeight", { configurable: true, value: VIEWPORT.height });
    FakeEventSource.made = [];
    state = makeState();
    frames = [];
    commands = [];
    finishFrame = [];
    holdFrames = false;
    replaced = false;
    live = createLiveView(document, env());
  });

  afterEach(() => {
    live.destroy();
    vi.useRealTimers();
  });

  it("opens the event stream, then fetches the state and a fit frame", async () => {
    expect(FakeEventSource.made.map((source) => source.url)).toEqual([`${BASE}events`]);
    expect(frames).toEqual([]);
    await connect();
    expect(frames).toEqual(["rev=1&w=1152&h=768&before=0"]);
    expect(document.getElementById("status-text")!.textContent).toBe("Live · synced with safelight");
    expect(document.getElementById("photo-name")!.textContent).toBe("DSC_0042.NEF");
    expect(stage().querySelectorAll("img")).toHaveLength(1);
  });

  it("fetches again on a state event", async () => {
    const source = await connect();
    state = makeState({ rev: 2 });
    source.state(2);
    await flush();
    expect(frames.at(-1)).toBe("rev=2&w=1152&h=768&before=0");
  });

  it("lists only the changed values, each with a bar, and marks the current step", async () => {
    await connect();
    const rows = [...document.querySelectorAll("#values .value")];
    expect(rows.map((row) => row.querySelector(".value-label")!.textContent)).toEqual(["Exposure"]);
    expect(rows[0].querySelector(".bar-thumb")).not.toBeNull();
    const current = document.querySelectorAll("#history [aria-current=step]");
    expect([...current].map((item) => item.textContent)).toEqual(["Exposure +1.00"]);
    expect(document.getElementById("photo-step")!.textContent).toBe("Step 2 of 3");
    expect(document.getElementById("photo-rating")!.getAttribute("aria-label")).toBe("3 of 5 stars");
  });

  it("asks for a region only once zooming has settled, keeping the frame it has", async () => {
    await connect();
    const shown = stage().querySelector("img");
    for (let i = 0; i < 5; i++) {
      stage().dispatchEvent(new WheelEvent("wheel", { deltaY: -200, clientX: 600, clientY: 400, cancelable: true }));
    }
    expect(live.view().scale).toBeGreaterThan(fitView(PHOTO, VIEWPORT).scale);
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(frames).toHaveLength(1);
    expect(stage().querySelector("img")).toBe(shown);
    expect(parseFloat(shown!.style.width)).toBeCloseTo(6000 * live.view().scale, 3);
    vi.advanceTimersByTime(1);
    await flush();
    expect(frames).toHaveLength(2);
    const query = new URLSearchParams(frames[1]);
    for (const name of ["x", "y", "zw", "zh"]) {
      expect(Number(query.get(name))).toBeGreaterThanOrEqual(0);
      expect(Number(query.get(name))).toBeLessThanOrEqual(1);
    }
    expect(Number(query.get("x")) + Number(query.get("zw")) / 2).toBeCloseTo(0.5, 3);
  });

  // The server answers 204 to a frame request a newer one (another tab) replaced.
  it("keeps the frame it has when a request was replaced", async () => {
    const source = await connect();
    const shown = stage().querySelector("img");
    replaced = true;
    state = makeState({ rev: 2 });
    source.state(2);
    await flush();
    expect(frames).toHaveLength(2);
    expect(stage().querySelector("img")).toBe(shown);
    expect(document.getElementById("status-text")!.textContent).toBe("Live · synced with safelight");
  });

  it("keeps one frame in flight and then fetches only the newest", async () => {
    await connect();
    holdFrames = true;
    live.actual();
    vi.advanceTimersByTime(SETTLE_MS);
    await flush();
    expect(frames).toHaveLength(2);
    live.zoomBy(1.5);
    vi.advanceTimersByTime(SETTLE_MS);
    live.zoomBy(1.5);
    vi.advanceTimersByTime(SETTLE_MS);
    await flush();
    expect(frames).toHaveLength(2);
    holdFrames = false;
    finishFrame.shift()!();
    await flush();
    expect(frames).toHaveLength(3);
    expect(frames[2]).toBe(frameRequest({ rev: 1, view: live.view(), photo: PHOTO, viewport: VIEWPORT, dpr: 1, before: false }).query);
  });

  it("lights the lamp only when a render runs long", async () => {
    await connect();
    const lamp = document.getElementById("lamp")!;
    holdFrames = true;
    live.actual();
    vi.advanceTimersByTime(SETTLE_MS);
    await flush();
    vi.advanceTimersByTime(LAMP_MS - 1);
    expect(lamp.classList.contains("is-working")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(lamp.classList.contains("is-working")).toBe(true);
    finishFrame.shift()!();
    await flush();
    expect(lamp.classList.contains("is-working")).toBe(false);
  });

  it("drags to pan and stops dead on release", async () => {
    await connect();
    live.actual();
    const start = live.view();
    const pointer = (type: string, x: number, y: number): void => {
      stage().dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true }));
    };
    pointer("pointerdown", 600, 400);
    pointer("pointermove", 560, 370);
    expect(live.view().x).toBeCloseTo(start.x - 40, 6);
    expect(live.view().y).toBeCloseTo(start.y - 30, 6);
    pointer("pointerup", 560, 370);
    const released = live.view();
    pointer("pointermove", 400, 200);
    vi.advanceTimersByTime(1000);
    expect(live.view()).toEqual(released);
  });

  it("toggles fit and 100% on double-click and with F and 1", async () => {
    await connect();
    const fit = fitView(PHOTO, VIEWPORT).scale;
    stage().dispatchEvent(new MouseEvent("dblclick", { clientX: 300, clientY: 200, bubbles: true }));
    expect(live.view().scale).toBe(1);
    stage().dispatchEvent(new MouseEvent("dblclick", { clientX: 300, clientY: 200, bubbles: true }));
    expect(live.view().scale).toBeCloseTo(fit, 9);
    press("keydown", "1");
    expect(live.view().scale).toBe(1);
    press("keydown", "f");
    expect(live.view().scale).toBeCloseTo(fit, 9);
  });

  it("shows before while the backslash key is held", async () => {
    await connect();
    press("keydown", "\\");
    await flush();
    expect(frames.at(-1)).toBe("rev=1&w=1152&h=768&before=1");
    expect(document.getElementById("before-badge")!.hidden).toBe(false);
    const count = frames.length;
    press("keyup", "\\");
    await flush();
    expect(document.getElementById("before-badge")!.hidden).toBe(true);
    expect(frames).toHaveLength(count);
  });

  it("sends next and prev only when there is a working set", async () => {
    const source = await connect();
    press("keydown", "ArrowRight");
    await flush();
    expect(commands).toEqual([]);
    expect(document.getElementById("strip")!.hidden).toBe(true);
    state = makeState({ rev: 2, working: { at: 1, of: 2, names: ["DSC_0042.NEF", "DSC_0043.NEF"] } });
    source.state(2);
    await flush();
    expect(document.getElementById("strip")!.hidden).toBe(false);
    press("keydown", "ArrowRight");
    press("keydown", "ArrowLeft");
    await flush();
    expect(commands).toEqual([{ action: "next" }, { action: "prev" }]);
  });

  it("says so and reconnects with backoff when the stream drops", async () => {
    const first = await connect();
    first.fail();
    expect(first.closed).toBe(true);
    expect(document.getElementById("status-text")!.textContent).toMatch(/^Lost the connection/);
    vi.advanceTimersByTime(backoffDelay(0) - 1);
    expect(FakeEventSource.made).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeEventSource.made).toHaveLength(2);
    FakeEventSource.made[1].fail();
    vi.advanceTimersByTime(backoffDelay(0));
    expect(FakeEventSource.made).toHaveLength(2);
    vi.advanceTimersByTime(backoffDelay(1) - backoffDelay(0));
    expect(FakeEventSource.made).toHaveLength(3);
    state = makeState({ rev: 9 });
    await connect();
    expect(document.getElementById("status-text")!.textContent).toBe("Live · synced with safelight");
    expect(frames.at(-1)).toBe("rev=9&w=1152&h=768&before=0");
  });

  it("words a warming and a failed engine", async () => {
    state = makeState({ engine: "warming" });
    const source = await connect();
    expect(document.getElementById("status-text")!.textContent).toBe("Waiting for the engine…");
    state = makeState({ rev: 2, engine: "failed" });
    source.state(2);
    await flush();
    expect(document.getElementById("status-text")!.textContent).toBe("Engine stopped: see the terminal");
  });

  it("collapses the side panel from its button", async () => {
    await connect();
    const toggle = document.getElementById("panel-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("panel")!.hidden).toBe(true);
  });
});
