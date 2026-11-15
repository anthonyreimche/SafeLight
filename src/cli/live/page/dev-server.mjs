// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stand-in for the live-view server, for looking at the page in a browser
// with no engine. It serves the three files from disk (so an edit shows on
// reload), under the real path shape and policy, with a made-up photo whose
// exposure drifts every few seconds. Frames are drawn as SVG, cut to the
// region asked for, so zoom and pan can be checked against the grid.
//   node src/cli/live/page/dev-server.mjs [port]

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.argv[2]) || 4173;
const ROOT = "/v/dev/";
const RENDER_MS = 350;
const TICK_MS = 4000;
const WARM_MS = 2500;
const POLICY = "default-src 'none'; img-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'";
const FILES = {
  "": ["index.html", "text/html; charset=utf-8"],
  "app.js": ["app.js", "text/javascript; charset=utf-8"],
  "app.css": ["app.css", "text/css; charset=utf-8"],
};

const PHOTOS = [
  { name: "DSC_0041.NEF", width: 6000, height: 4000, hue: 205, rating: 3, flag: "pick", label: "green" },
  { name: "DSC_0042.NEF", width: 4000, height: 6000, hue: 28, rating: 0, flag: "none", label: "none" },
  { name: "DSC_0043.NEF", width: 6000, height: 3376, hue: 265, rating: 5, flag: "none", label: "purple" },
  { name: "DSC_0044.NEF", width: 3000, height: 3000, hue: 140, rating: 1, flag: "reject", label: "red" },
];

let rev = 1;
let at = 0;
let before = false;
let engine = "warming";
let exposure = 0.35;
const history = ["Opened", "Exposure +0.35"];
const streams = new Set();

function bump() {
  rev += 1;
  for (const stream of streams) stream.write(`event: state\ndata: ${JSON.stringify({ rev })}\n\n`);
}

const signed = (value, digits) => `${value >= 0 ? "+" : "−"}${Math.abs(value).toFixed(digits)}`;

function state() {
  const photo = PHOTOS[at];
  return {
    slu: 1,
    rev,
    photo: {
      name: photo.name,
      relPath: `2026/coast/${photo.name}`,
      width: photo.width,
      height: photo.height,
      step: { at: history.length, of: history.length + 1 },
      rating: photo.rating,
      flag: photo.flag,
      label: photo.label,
    },
    project: { name: "Coast" },
    values: [
      { tool: "Basic", key: "exposure", label: "Exposure", value: exposure, display: signed(exposure, 2), min: -5, max: 5, default: 0, changed: true },
      { tool: "Basic", key: "contrast", label: "Contrast", value: 0, display: "0", min: -100, max: 100, default: 0, changed: false },
      { tool: "Basic", key: "highlights", label: "Highlights", value: -62, display: "−62", min: -100, max: 100, default: 0, changed: true },
      { tool: "White Balance", key: "temperature", label: "Temperature", value: 6100, display: "6100 K", min: 2000, max: 12000, default: 5200, changed: true },
      { tool: "White Balance", key: "preset", label: "Preset", value: "cloudy", display: "Cloudy", min: null, max: null, default: "as-shot", changed: true },
      { tool: "Detail", key: "sharpening", label: "Sharpening", value: 100, display: "100", min: 0, max: 100, default: 40, changed: true },
    ],
    history: [...history, "Vignette −20"].map((label, index) => ({ index, label, current: index === history.length - 1 })),
    working: { at: at + 1, of: PHOTOS.length, names: PHOTOS.map((each) => each.name) },
    engine,
    before,
  };
}

function frame(query) {
  const photo = PHOTOS[at];
  const number = (name, fallback) => (query.has(name) ? Number(query.get(name)) : fallback);
  const region = { x: number("x", 0), y: number("y", 0), zw: number("zw", 1), zh: number("zh", 1) };
  const { width: W, height: H, hue } = photo;
  const plain = before || query.get("before") === "1";
  const light = plain ? 0 : exposure * 12;
  const lines = [];
  for (let x = 500; x < W; x += 500) lines.push(`<path d="M${x} 0V${H}" /><text x="${x + 12}" y="60">${x}</text>`);
  for (let y = 500; y < H; y += 500) lines.push(`<path d="M0 ${y}H${W}" /><text x="12" y="${y - 14}">${y}</text>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${number("w", 1200)}" height="${number("h", 800)}" preserveAspectRatio="none"
  viewBox="${region.x * W} ${region.y * H} ${region.zw * W} ${region.zh * H}">
  <defs>
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="hsl(${hue} ${plain ? 25 : 55}% ${28 + light}%)" />
      <stop offset="0.62" stop-color="hsl(${hue + 150} ${plain ? 30 : 70}% ${66 + light}%)" />
      <stop offset="1" stop-color="hsl(${hue + 170} 45% ${20 + light}%)" />
    </linearGradient>
    <radialGradient id="sun">
      <stop offset="0" stop-color="hsl(45 100% 96%)" />
      <stop offset="1" stop-color="hsl(45 100% 80% / 0)" />
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#sky)" />
  <circle cx="${W * 0.68}" cy="${H * 0.5}" r="${H * 0.22}" fill="url(#sun)" />
  <path d="M0 ${H * 0.7}Q${W * 0.3} ${H * 0.52} ${W * 0.55} ${H * 0.68}T${W} ${H * 0.62}V${H}H0Z" fill="hsl(${hue + 170} 30% ${12 + light / 2}%)" />
  <g stroke="rgb(255 255 255 / 0.22)" stroke-width="2" fill="rgb(255 255 255 / 0.6)" font-family="sans-serif" font-size="48">${lines.join("")}</g>
  <text x="${W / 2}" y="${H * 0.9}" text-anchor="middle" fill="rgb(255 255 255 / 0.75)" font-family="sans-serif" font-size="${H * 0.04}">${photo.name} · rev ${query.get("rev")}${plain ? " · before" : ""}</text>
</svg>`;
}

async function readBody(request) {
  let text = "";
  for await (const chunk of request) text += chunk;
  return text;
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (!url.pathname.startsWith(ROOT)) {
    response.writeHead(404).end();
    return;
  }
  const route = url.pathname.slice(ROOT.length);
  const send = (status, type, body) => {
    response.writeHead(status, { "content-type": type, "cache-control": "no-store", "content-security-policy": POLICY });
    response.end(body);
  };

  if (request.method === "POST" && route === "cmd") {
    let action;
    try {
      action = JSON.parse(await readBody(request)).action;
    } catch {}
    if (action === "next" || action === "prev") at = (at + (action === "next" ? 1 : PHOTOS.length - 1)) % PHOTOS.length;
    else if (action === "before") before = !before;
    else return send(400, "application/json", "{}");
    bump();
    return send(200, "application/json", "{}");
  }
  if (request.method !== "GET") return send(405, "text/plain", "");
  if (route in FILES) {
    const [file, type] = FILES[route];
    return send(200, type, await readFile(path.join(here, file)));
  }
  if (route === "state") return send(200, "application/json", JSON.stringify(state()));
  if (route === "frame") {
    setTimeout(() => send(200, "image/svg+xml", frame(url.searchParams)), RENDER_MS);
    return;
  }
  if (route === "events") {
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    response.write(": hello\n\n");
    streams.add(response);
    request.on("close", () => streams.delete(response));
    return;
  }
  send(404, "text/plain", "");
});

setTimeout(() => {
  engine = "ready";
  bump();
}, WARM_MS);

setInterval(() => {
  exposure = Math.max(-2, Math.min(2, exposure + (Math.random() - 0.5) * 0.6));
  history.push(`Exposure ${signed(exposure, 2)}`);
  if (history.length > 14) history.splice(1, 1);
  bump();
}, TICK_MS);

setInterval(() => {
  for (const stream of streams) stream.write(": beat\n\n");
}, 15_000);

server.listen(port, "127.0.0.1", () => {
  console.log(`Live view harness: http://127.0.0.1:${port}${ROOT}`);
  console.log("Stop it and start it again to see the page reconnect.");
});
