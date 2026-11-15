// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The live view's page. The engine renders and this only shows: it keeps a
// view (scale and offset) over the photo, asks the server for the part in
// sight at device-pixel size, and holds the frame it has, scaled, until the
// next one lands. Served as is, so it stays plain JavaScript with no imports.

/** Surround left around a fitted photo, in CSS pixels. */
export const FIT_MARGIN = 16;
/** The closest zoom, in device pixels per photo pixel. */
export const MAX_ZOOM = 8;
/** How long zoom and pan must rest before a frame is asked for. */
export const SETTLE_MS = 120;
/** A render shorter than this never lights the lamp. */
export const LAMP_MS = 150;

const WHOLE = Object.freeze({ x: 0, y: 0, zw: 1, zh: 1 });
const EDGE = 1e-6;
const WHEEL_STEP = 0.0015;
const PINCH_STEP = 0.01;
const KEY_STEP = 1.25;
const LABEL_COLOURS = ["red", "yellow", "green", "blue", "purple"];
const PANEL_KEY = "sl_live_panel";

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round6 = (value) => Math.round(value * 1e6) / 1e6;

export function fitScale(photo, viewport) {
  const width = Math.max(1, viewport.width - FIT_MARGIN * 2);
  const height = Math.max(1, viewport.height - FIT_MARGIN * 2);
  return Math.min(width / photo.width, height / photo.height);
}

/** Scales are CSS pixels per photo pixel; `actual` is one photo pixel per device pixel. */
export function scaleBounds(photo, viewport, dpr) {
  const fit = fitScale(photo, viewport);
  const actual = 1 / dpr;
  return { fit, actual, min: Math.min(fit, actual), max: Math.max(fit, MAX_ZOOM / dpr) };
}

/** An axis that fits is centred; one that doesn't never shows surround past its edge. */
export function clampView(view, photo, viewport) {
  const axis = (offset, size, room) => (size <= room ? (room - size) / 2 : clamp(offset, room - size, 0));
  return {
    scale: view.scale,
    x: axis(view.x, photo.width * view.scale, viewport.width),
    y: axis(view.y, photo.height * view.scale, viewport.height),
  };
}

export function fitView(photo, viewport) {
  return clampView({ scale: fitScale(photo, viewport), x: 0, y: 0 }, photo, viewport);
}

/** Zooms to `scale`, keeping the photo point under `point` where it is. */
export function zoomAt(view, scale, point, photo, viewport, dpr) {
  const bounds = scaleBounds(photo, viewport, dpr);
  const next = clamp(scale, bounds.min, bounds.max);
  const ratio = next / view.scale;
  return clampView(
    { scale: next, x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio },
    photo,
    viewport,
  );
}

/** The part of the photo in sight, in 0…1 photo coordinates. */
export function visibleRegion(view, photo, viewport) {
  const span = (offset, size, room) => {
    const from = clamp(-offset / size, 0, 1);
    const to = clamp((room - offset) / size, 0, 1);
    return [round6(from), round6(Math.max(0, to - from))];
  };
  const [x, zw] = span(view.x, photo.width * view.scale, viewport.width);
  const [y, zh] = span(view.y, photo.height * view.scale, viewport.height);
  return { x, y, zw, zh };
}

/** The /frame query for a view, and the region its picture will cover. */
export function frameRequest({ rev, view, photo, viewport, dpr, before }) {
  const seen = visibleRegion(view, photo, viewport);
  const whole = seen.zw >= 1 - EDGE && seen.zh >= 1 - EDGE;
  const region = whole ? WHOLE : seen;
  // Past 100% the engine has no more detail to give, so the picture stops at the photo's own pixels.
  const density = Math.min(1, view.scale * dpr);
  const params = new URLSearchParams({
    rev: String(rev),
    w: String(Math.max(1, Math.round(region.zw * photo.width * density))),
    h: String(Math.max(1, Math.round(region.zh * photo.height * density))),
  });
  if (!whole) for (const name of ["x", "y", "zw", "zh"]) params.set(name, String(region[name]));
  params.set("before", before ? "1" : "0");
  return { query: params.toString(), region };
}

/** Where a value and its default sit along a bar, 0…1; null when it has no range. */
export function sliderGeometry({ value, min, max, default: base }) {
  if (typeof value !== "number" || typeof min !== "number" || typeof max !== "number" || !(max > min)) return null;
  const along = (v) => clamp((v - min) / (max - min), 0, 1);
  return { at: along(value), tick: typeof base === "number" ? along(base) : null };
}

export function backoffDelay(attempt) {
  return Math.min(10_000, 500 * 2 ** attempt);
}

export function statusOf({ connected, lost, engine, renderFailed }) {
  if (!connected) {
    return lost
      ? { tone: "stopped", text: "Lost the connection to safelight: trying again…" }
      : { tone: "waiting", text: "Connecting to safelight…" };
  }
  if (engine === "failed") return { tone: "stopped", text: "Engine stopped: see the terminal" };
  if (engine !== "ready") return { tone: "waiting", text: "Waiting for the engine…" };
  if (renderFailed) return { tone: "stopped", text: "That render failed: see the terminal" };
  return { tone: "live", text: "Live · synced with safelight" };
}

export function keyAction(event, hasWorkingSet) {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;
  switch (event.key) {
    case "\\": return "before";
    case "f": case "F": return "fit";
    case "1": return "actual";
    case "+": case "=": return "zoomIn";
    case "-": return "zoomOut";
    case "ArrowLeft": return hasWorkingSet ? "prev" : null;
    case "ArrowRight": return hasWorkingSet ? "next" : null;
    default: return null;
  }
}

function loadBlobImage(blob) {
  const address = URL.createObjectURL(blob);
  const image = new Image();
  return new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("The frame did not decode"));
    image.src = address;
  }).finally(() => URL.revokeObjectURL(address));
}

function make(doc, tag, className, text) {
  const element = doc.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function photoKey(photo) {
  return photo ? `${photo.relPath}\n${photo.width}x${photo.height}` : "";
}

function readPanelOpen(doc) {
  try {
    const saved = doc.defaultView.localStorage.getItem(PANEL_KEY);
    if (saved !== null) return saved === "1";
  } catch {}
  return !doc.defaultView.matchMedia?.("(max-width: 720px)").matches;
}

export function createLiveView(doc, overrides = {}) {
  const win = doc.defaultView;
  const env = {
    base: doc.baseURI,
    dpr: () => win.devicePixelRatio || 1,
    fetch: (input, init) => win.fetch(input, init),
    EventSource: win.EventSource,
    loadImage: loadBlobImage,
    ...overrides,
  };
  const address = (route) => new URL(route, env.base).href;
  const byId = (id) => doc.getElementById(id);

  const stage = byId("stage");
  const frames = byId("frames");
  const panel = byId("panel");
  const panelToggle = byId("panel-toggle");
  const lamp = byId("lamp");

  let state = null;
  let view = { scale: 1, x: 0, y: 0 };
  let fitted = true;
  let held = false;
  let destroyed = false;

  let source = null;
  let connected = false;
  let lost = false;
  let attempt = 0;
  let retryTimer = null;
  let stateSeq = 0;

  /** The frame on screen: its picture, the region it covers and the query that made it. */
  let frame = null;
  /** The last frame that wasn't a before, so letting go of the key shows it at once. */
  let kept = null;
  let flying = null;
  let queued = false;
  let renderFailed = false;
  let settleTimer = null;
  let lampTimer = null;

  const viewport = () => ({ width: stage.clientWidth, height: stage.clientHeight });
  const photo = () => state?.photo ?? null;
  const showingBefore = () => held || Boolean(state?.before);

  function updateStatus() {
    const status = statusOf({ connected, lost, engine: state?.engine ?? null, renderFailed });
    byId("status-text").textContent = status.text;
    byId("shell").dataset.tone = status.tone;
    byId("before-badge").hidden = !photo() || !showingBefore();
  }

  function setLamp(working) {
    lamp.classList.toggle("is-working", working);
  }

  function placeFrame() {
    const current = photo();
    // A frame of the photo just left stays where it was until its replacement lands.
    if (!frame || !current || frame.key !== photoKey(current)) return;
    const { region, image } = frame;
    image.style.left = `${view.x + region.x * current.width * view.scale}px`;
    image.style.top = `${view.y + region.y * current.height * view.scale}px`;
    image.style.width = `${region.zw * current.width * view.scale}px`;
    image.style.height = `${region.zh * current.height * view.scale}px`;
  }

  function layout() {
    const current = photo();
    byId("empty").hidden = Boolean(current);
    frames.hidden = !current;
    if (!current) {
      byId("zoom").textContent = "";
      return;
    }
    const room = viewport();
    view = fitted ? fitView(current, room) : clampView(view, current, room);
    const percent = `${Math.round(view.scale * env.dpr() * 100)}%`;
    byId("zoom").textContent = fitted ? `Fit · ${percent}` : percent;
    byId("zoom-fit").setAttribute("aria-pressed", String(fitted));
    frames.classList.toggle("is-magnified", view.scale * env.dpr() >= 2);
    placeFrame();
  }

  function show(next) {
    next.image.alt = "";
    next.image.draggable = false;
    next.image.className = "frame";
    frame = next;
    if (!next.before) kept = next;
    frames.replaceChildren(next.image);
    placeFrame();
  }

  function currentRequest() {
    const current = photo();
    const request = frameRequest({
      rev: state.rev,
      view,
      photo: current,
      viewport: viewport(),
      dpr: env.dpr(),
      before: held,
    });
    return { ...request, key: photoKey(current), before: held };
  }

  async function fly(request) {
    flying = request.query;
    queued = false;
    lampTimer ??= setTimeout(() => setLamp(true), LAMP_MS);
    let failed = false;
    try {
      const response = await env.fetch(address(`frame?${request.query}`), { cache: "no-store" });
      if (!response.ok) throw new Error(`frame ${response.status}`);
      // 204: a newer request (another tab) replaced this one; keep the frame on screen.
      if (response.status !== 204) {
        const image = await env.loadImage(await response.blob());
        if (destroyed) return;
        if (request.key === photoKey(photo()) && request.before === held) show({ ...request, image });
      }
    } catch {
      failed = true;
    }
    flying = null;
    if (destroyed) return;
    renderFailed = failed;
    if (queued) wantFrame();
    if (!flying) {
      clearTimeout(lampTimer);
      lampTimer = null;
      setLamp(false);
    }
    updateStatus();
  }

  /** Latest wins: one frame in flight, and whatever is wanted when it lands goes next. */
  function wantFrame() {
    clearTimeout(settleTimer);
    queued = false;
    if (!photo() || state.engine === "failed") return;
    const request = currentRequest();
    if (flying) {
      queued = flying !== request.query;
      return;
    }
    if (frame?.query === request.query) return;
    if (kept?.query === request.query) {
      show(kept);
      return;
    }
    void fly(request);
  }

  function settleThenFrame() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(wantFrame, SETTLE_MS);
  }

  function setView(next, fit) {
    view = next;
    fitted = fit;
    layout();
    settleThenFrame();
  }

  function zoomTo(scale, point) {
    const current = photo();
    if (!current) return;
    const room = viewport();
    const dpr = env.dpr();
    const next = zoomAt(view, scale, point, current, room, dpr);
    const bounds = scaleBounds(current, room, dpr);
    setView(next, bounds.min === bounds.fit && next.scale <= bounds.fit * (1 + EDGE));
  }

  const centre = () => ({ x: stage.clientWidth / 2, y: stage.clientHeight / 2 });
  const zoomBy = (factor, point = centre()) => zoomTo(view.scale * factor, point);
  const fit = () => photo() && setView(fitView(photo(), viewport()), true);
  const actual = (point = centre()) => {
    if (!photo()) return;
    view = zoomAt(view, 1 / env.dpr(), point, photo(), viewport(), env.dpr());
    setView(view, false);
  };

  function panBy(dx, dy) {
    if (!photo() || fitted) return;
    setView({ scale: view.scale, x: view.x + dx, y: view.y + dy }, false);
  }

  function setHeld(next) {
    if (held === next) return;
    held = next;
    updateStatus();
    wantFrame();
  }

  function command(action) {
    if ((action === "next" || action === "prev") && !state?.working) return;
    env.fetch(address("cmd"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action }),
    }).catch(() => {});
  }

  function renderPhoto() {
    const current = photo();
    stage.setAttribute("aria-label", current ? `Photo: ${current.name}` : "Photo");
    doc.title = current ? `${current.name} · Safelight` : "Safelight · Live view";
    byId("photo-name").textContent = current?.name ?? "No photo";
    byId("photo-path").textContent = current && current.relPath !== current.name ? current.relPath : "";
    byId("photo-step").textContent = current?.step ? `Step ${current.step.at} of ${current.step.of}` : "";
    byId("photo-size").textContent = current ? `${current.width} × ${current.height}` : "";
    byId("project-name").textContent = state?.project?.name ?? "";

    const stars = clamp(Math.round(Number(current?.rating) || 0), 0, 5);
    const rating = byId("photo-rating");
    rating.replaceChildren(make(doc, "span", "rating-on", "★".repeat(stars)), make(doc, "span", "rating-off", "★".repeat(5 - stars)));
    rating.setAttribute("aria-label", stars ? `${stars} of 5 stars` : "No rating");
    rating.hidden = !current;

    const flag = byId("photo-flag");
    flag.textContent = current?.flag === "pick" ? "Picked" : current?.flag === "reject" ? "Rejected" : "";
    flag.dataset.flag = current?.flag ?? "";

    const label = byId("photo-label");
    const colour = LABEL_COLOURS.includes(current?.label) ? current.label : "";
    label.replaceChildren();
    if (colour) label.append(make(doc, "span", "label-dot"), `${colour[0].toUpperCase()}${colour.slice(1)}`);
    label.dataset.label = colour;
  }

  function renderBar(value) {
    const geometry = sliderGeometry(value);
    if (!geometry) return null;
    const bar = make(doc, "span", "bar");
    bar.setAttribute("aria-hidden", "true");
    const percent = (at) => `${round6(at * 100)}%`;
    if (geometry.tick !== null) {
      const fill = make(doc, "span", "bar-fill");
      fill.style.left = percent(Math.min(geometry.tick, geometry.at));
      fill.style.width = percent(Math.abs(geometry.at - geometry.tick));
      const tick = make(doc, "span", "bar-tick");
      tick.style.left = percent(geometry.tick);
      bar.append(fill, tick);
    }
    const thumb = make(doc, "span", "bar-thumb");
    thumb.style.left = percent(geometry.at);
    bar.append(thumb);
    return bar;
  }

  function renderValues() {
    const changed = (state?.values ?? []).filter((value) => value.changed);
    const list = byId("values");
    list.replaceChildren();
    if (!changed.length) {
      list.append(make(doc, "p", "quiet", photo() ? "Nothing changed yet." : ""));
      return;
    }
    let tool = null;
    for (const value of changed) {
      if (value.tool !== tool) {
        tool = value.tool;
        list.append(make(doc, "h3", "tool", tool));
      }
      const row = make(doc, "div", "value");
      row.append(make(doc, "span", "value-label", value.label));
      const bar = renderBar(value);
      if (bar) row.append(bar);
      row.append(make(doc, "span", "value-display", value.display));
      list.append(row);
    }
  }

  function renderHistory() {
    const list = byId("history");
    list.replaceChildren();
    let marked = null;
    for (const step of state?.history ?? []) {
      const item = make(doc, "li", "step", step.label);
      if (step.current) {
        item.setAttribute("aria-current", "step");
        marked = item;
      }
      list.append(item);
    }
    marked?.scrollIntoView?.({ block: "nearest" });
  }

  function renderWorkingSet() {
    const working = state?.working ?? null;
    byId("strip").hidden = !working;
    const names = byId("set-names");
    names.replaceChildren();
    if (!working) return;
    byId("set-count").textContent = `${working.at} of ${working.of}`;
    const named = working.names.indexOf(photo()?.name);
    const at = named >= 0 ? named : working.at - 1;
    let marked = null;
    working.names.forEach((name, index) => {
      const item = make(doc, "li", "strip-name", name);
      if (index === at) {
        item.setAttribute("aria-current", "true");
        marked = item;
      }
      names.append(item);
    });
    marked?.scrollIntoView?.({ block: "nearest", inline: "center" });
  }

  function applyState(next) {
    if (photoKey(next.photo) !== photoKey(photo())) {
      fitted = true;
      kept = null;
    }
    state = next;
    renderPhoto();
    renderValues();
    renderHistory();
    renderWorkingSet();
    layout();
    updateStatus();
    wantFrame();
  }

  async function refresh() {
    const seq = ++stateSeq;
    try {
      const response = await env.fetch(address("state"), { cache: "no-store" });
      if (!response.ok) throw new Error(`state ${response.status}`);
      const next = await response.json();
      if (seq === stateSeq && !destroyed) applyState(next);
    } catch {
      // A server that has gone also drops the event stream, and that is what reports it.
    }
  }

  function connect() {
    retryTimer = null;
    const stream = new env.EventSource(address("events"));
    source = stream;
    stream.addEventListener("open", () => {
      attempt = 0;
      connected = true;
      lost = false;
      updateStatus();
      void refresh();
    });
    stream.addEventListener("state", () => void refresh());
    stream.addEventListener("error", () => {
      // The browser's own retry has no backoff and gives up on a refused connection, so this one takes over.
      stream.close();
      if (destroyed || source !== stream) return;
      lost = lost || connected;
      connected = false;
      updateStatus();
      retryTimer = setTimeout(connect, backoffDelay(attempt++));
    });
  }

  function setPanelOpen(open, remember) {
    panel.hidden = !open;
    panelToggle.setAttribute("aria-expanded", String(open));
    byId("shell").classList.toggle("is-panel-closed", !open);
    if (remember) {
      try {
        win.localStorage.setItem(PANEL_KEY, open ? "1" : "0");
      } catch {}
    }
    layout();
    settleThenFrame();
  }

  const listeners = new AbortController();
  const on = (target, type, handler, options) => target.addEventListener(type, handler, { signal: listeners.signal, ...options });
  const pointOf = (event) => {
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  on(stage, "wheel", (event) => {
    event.preventDefault();
    const lines = event.deltaMode === 1 ? 16 : 1;
    const step = event.ctrlKey ? PINCH_STEP : WHEEL_STEP;
    zoomBy(Math.exp(-event.deltaY * lines * step), pointOf(event));
  }, { passive: false });

  const pointers = new Map();
  const dropPointer = (event) => {
    pointers.delete(event.pointerId);
    if (!pointers.size) stage.classList.remove("is-dragging");
  };
  on(stage, "pointerdown", (event) => {
    if (event.button !== 0) return;
    pointers.set(event.pointerId, pointOf(event));
    stage.classList.add("is-dragging");
    try {
      stage.setPointerCapture(event.pointerId);
    } catch {}
  });
  on(stage, "pointermove", (event) => {
    const last = pointers.get(event.pointerId);
    if (!last) return;
    const now = pointOf(event);
    pointers.set(event.pointerId, now);
    if (pointers.size === 1) {
      panBy(now.x - last.x, now.y - last.y);
      return;
    }
    if (pointers.size !== 2) return;
    const other = [...pointers].find(([id]) => id !== event.pointerId)[1];
    const spread = (a, b) => Math.hypot(a.x - b.x, a.y - b.y) || 1;
    panBy((now.x - last.x) / 2, (now.y - last.y) / 2);
    zoomBy(spread(now, other) / spread(last, other), { x: (now.x + other.x) / 2, y: (now.y + other.y) / 2 });
  });
  on(stage, "pointerup", dropPointer);
  on(stage, "pointercancel", dropPointer);

  // Trackpad pinch on browsers that report it as a gesture and not as a wheel.
  let gestureScale = 1;
  on(stage, "gesturestart", (event) => {
    event.preventDefault();
    gestureScale = view.scale;
  });
  on(stage, "gesturechange", (event) => {
    event.preventDefault();
    zoomTo(gestureScale * event.scale, pointOf(event));
  });

  on(stage, "dblclick", (event) => (fitted ? actual(pointOf(event)) : fit()));

  on(doc, "keydown", (event) => {
    const action = keyAction(event, Boolean(state?.working));
    if (!action) return;
    event.preventDefault();
    if (action === "before") setHeld(true);
    else if (event.repeat && (action === "next" || action === "prev")) return;
    else if (action === "fit") fit();
    else if (action === "actual") actual();
    else if (action === "zoomIn") zoomBy(KEY_STEP);
    else if (action === "zoomOut") zoomBy(1 / KEY_STEP);
    else command(action);
  });
  on(doc, "keyup", (event) => {
    if (event.key === "\\") setHeld(false);
  });
  on(win, "blur", () => setHeld(false));

  on(byId("zoom-fit"), "click", () => fit());
  on(byId("zoom-actual"), "click", () => actual());
  on(byId("set-prev"), "click", () => command("prev"));
  on(byId("set-next"), "click", () => command("next"));
  on(panelToggle, "click", () => setPanelOpen(panel.hidden, true));

  const relayout = () => {
    layout();
    settleThenFrame();
  };
  const observer = win.ResizeObserver ? new win.ResizeObserver(relayout) : null;
  observer?.observe(stage);
  on(win, "resize", relayout);

  setPanelOpen(readPanelOpen(doc), false);
  renderPhoto();
  renderValues();
  updateStatus();
  connect();

  return {
    view: () => ({ ...view }),
    state: () => state,
    fit,
    actual,
    zoomBy,
    destroy() {
      destroyed = true;
      listeners.abort();
      observer?.disconnect();
      source?.close();
      for (const timer of [retryTimer, settleTimer, lampTimer]) clearTimeout(timer);
    },
  };
}

if (typeof document !== "undefined" && document.documentElement.hasAttribute("data-live-view")) {
  createLiveView(document);
}
