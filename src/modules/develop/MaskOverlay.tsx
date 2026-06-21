import { useRef, useState } from "react";
import type { RefObject } from "react";
import type {
  BrushDab,
  CropRect,
  Mask,
  MaskComponent,
  RadialMaskGeo,
  RetouchSpot,
} from "@/catalog/types";
import { DEFAULT_MASK_PANELS, defaultColorRange, defaultMaskAdjustments } from "@/catalog/types";
import { mat3Apply, type Mat3 } from "@/rendering/transform";
import { useDevelopStore } from "@/state/develop-store";
import { findHealSource, healColorOffset } from "@/rendering/heal-source";
import { sampleLinearRGB } from "@/rendering/sample-pixel";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface MaskOverlayProps {
  rect: Rect; // displayed buffer rect, frame coords (= cropped output region)
  crop: CropRect;
  inv: Mat3; // transformed coord -> source UV
  forward: Mat3; // source UV -> transformed coord
  imageAspect: number;
  // The displayed render canvas, sampled by the colour-range eyedropper.
  canvasRef?: RefObject<HTMLCanvasElement | null>;
}

let idSeq = 0;
const genId = (p: string) => `${p}-${Date.now().toString(36)}-${idSeq++}`;

// Trace the outer boundary of a union of circles (screen space) as a single SVG
// path, so a brush stroke shows one outline instead of one ring per dab.
// Marching squares over a coverage field: inside where any circle contains the
// node. Adjacent cells share crossing points exactly, so the emitted segments
// form a continuous outline (round caps hide the seams). `cell` is grid step px.
function unionOutlinePath(
  circles: { x: number; y: number; r: number }[],
  cell = 4,
): string {
  if (circles.length === 0) return "";
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of circles) {
    minX = Math.min(minX, c.x - c.r);
    minY = Math.min(minY, c.y - c.r);
    maxX = Math.max(maxX, c.x + c.r);
    maxY = Math.max(maxY, c.y + c.r);
  }
  minX -= cell; minY -= cell; maxX += cell; maxY += cell;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cell));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cell));
  // Signed field at a grid node: > 0 inside the union (max of r^2 - dist^2).
  const fieldAt = (gx: number, gy: number) => {
    const px = minX + gx * cell, py = minY + gy * cell;
    let v = -Infinity;
    for (const c of circles) {
      const dx = px - c.x, dy = py - c.y;
      const s = c.r * c.r - (dx * dx + dy * dy);
      if (s > v) v = s;
    }
    return v;
  };
  // Cache one row of node values at a time to avoid re-evaluating the field.
  let parts = "";
  let prevRow = new Float64Array(cols + 1);
  for (let i = 0; i <= cols; i++) prevRow[i] = fieldAt(i, 0);
  for (let j = 0; j < rows; j++) {
    const nextRow = new Float64Array(cols + 1);
    for (let i = 0; i <= cols; i++) nextRow[i] = fieldAt(i, j + 1);
    const y0 = minY + j * cell, y1 = y0 + cell;
    for (let i = 0; i < cols; i++) {
      const v00 = prevRow[i], v10 = prevRow[i + 1];
      const v01 = nextRow[i], v11 = nextRow[i + 1];
      const code =
        (v00 >= 0 ? 1 : 0) | (v10 >= 0 ? 2 : 0) | (v11 >= 0 ? 4 : 0) | (v01 >= 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      const x0 = minX + i * cell, x1 = x0 + cell;
      const T = (): [number, number] => [x0 + (v00 / (v00 - v10)) * cell, y0];
      const R = (): [number, number] => [x1, y0 + (v10 / (v10 - v11)) * cell];
      const B = (): [number, number] => [x0 + (v01 / (v01 - v11)) * cell, y1];
      const L = (): [number, number] => [x0, y0 + (v00 / (v00 - v01)) * cell];
      const seg = (a: [number, number], b: [number, number]) => {
        parts += `M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}`;
      };
      switch (code) {
        case 1: case 14: seg(L(), T()); break;
        case 2: case 13: seg(T(), R()); break;
        case 3: case 12: seg(L(), R()); break;
        case 4: case 11: seg(R(), B()); break;
        case 6: case 9: seg(T(), B()); break;
        case 7: case 8: seg(L(), B()); break;
        case 5: seg(L(), T()); seg(R(), B()); break;
        case 10: seg(T(), R()); seg(B(), L()); break;
      }
    }
    prevRow = nextRow;
  }
  return parts;
}

const HIT = 13; // px handle hit radius (generous grips)
const ROT_OFFSET = 0.06; // rotate-handle gap beyond the ellipse top (q-units)
const SNAP = Math.PI / 12; // 15° rotation snap

// Add components draw blue/white, subtract components draw orange — matching the
// panel's colour language.
const COLOR = {
  add: "#4aa3ff",
  addDim: "rgba(255,255,255,0.5)",
  sub: "#ff7a4a",
  subDim: "rgba(255,150,90,0.5)",
};

type HandleId =
  | "radial-move"
  | "radial-e"
  | "radial-w"
  | "radial-n"
  | "radial-s"
  | "radial-rotate"
  | "linear-p0"
  | "linear-p1";

type DragKind =
  | "create-radial"
  | "create-linear"
  | "brush"
  | HandleId
  | "spot-dst"
  | "spot-src"
  | "retouch-paint";

export function MaskOverlay({ rect, crop, inv, forward, imageAspect, canvasRef }: MaskOverlayProps) {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const maskToolType = useDevelopStore((s) => s.maskToolType);
  const masks = useDevelopStore((s) => s.params.masks);
  const spots = useDevelopStore((s) => s.params.retouch);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const selectedComponentId = useDevelopStore((s) => s.selectedComponentId);
  const selectedSpotId = useDevelopStore((s) => s.selectedSpotId);
  const brushErase = useDevelopStore((s) => s.brushErase);
  const brushSize = useDevelopStore((s) => s.brushSize);
  const brushFeather = useDevelopStore((s) => s.brushFeather);
  const brushPreview = useDevelopStore((s) => s.brushPreview);
  const retouchSize = useDevelopStore((s) => s.retouchSize);
  const retouchFeather = useDevelopStore((s) => s.retouchFeather);

  const [cursor, setCursor] = useState<{ x: number; y: number; alt: boolean } | null>(null);
  const [hovered, setHovered] = useState<HandleId | null>(null);

  // --- coordinate transforms -------------------------------------------------
  const toSource = (px: number, py: number) => {
    const ox = (px - rect.x) / rect.w;
    const oy = (py - rect.y) / rect.h;
    return mat3Apply(inv, crop.x + ox * crop.width, crop.y + oy * crop.height);
  };
  const toScreen = (sx: number, sy: number) => {
    const t = mat3Apply(forward, sx, sy);
    const ox = (t.x - crop.x) / crop.width;
    const oy = (t.y - crop.y) / crop.height;
    return { x: rect.x + ox * rect.w, y: rect.y + oy * rect.h };
  };
  const radiusToScreen = (r: number) => (r / crop.height) * rect.h;

  // Screen-proportional ("q") space helpers: x scaled by aspect so rotation is
  // rigid. Used for the radial ellipse, its handles, and rotation math.
  const uvFromQ = (qx: number, qy: number, cx: number, cy: number) => ({
    x: cx + qx / imageAspect,
    y: cy + qy,
  });
  const radialHandle = (
    r: RadialMaskGeo,
    which: "center" | "e" | "w" | "n" | "s" | "rotate",
  ): { x: number; y: number } => {
    if (which === "center") return toScreen(r.cx, r.cy);
    const ca = Math.cos(r.angle);
    const sa = Math.sin(r.angle);
    let qx = 0;
    let qy = 0;
    if (which === "e") qx = r.rx * imageAspect;
    else if (which === "w") qx = -r.rx * imageAspect;
    else if (which === "n") qy = -r.ry;
    else if (which === "s") qy = r.ry;
    else qy = -(r.ry + ROT_OFFSET); // rotate
    const rqx = ca * qx - sa * qy;
    const rqy = sa * qx + ca * qy;
    const uv = uvFromQ(rqx, rqy, r.cx, r.cy);
    return toScreen(uv.x, uv.y);
  };
  const rotatedEllipsePath = (r: RadialMaskGeo) => {
    const ca = Math.cos(r.angle);
    const sa = Math.sin(r.angle);
    const pts: string[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const qx = r.rx * imageAspect * Math.cos(a);
      const qy = r.ry * Math.sin(a);
      const rqx = ca * qx - sa * qy;
      const rqy = sa * qx + ca * qy;
      const uv = uvFromQ(rqx, rqy, r.cx, r.cy);
      const p = toScreen(uv.x, uv.y);
      pts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
    }
    return "M" + pts.join("L") + "Z";
  };

  const dragRef = useRef<{
    kind: DragKind;
    maskId?: string;
    compId?: string;
    id?: string; // retouch spot id
    downSrc: { x: number; y: number };
    lastDab?: { x: number; y: number };
    dabs?: BrushDab[];
    fromCenter?: boolean;
  } | null>(null);
  // Last brush point, kept across strokes for Shift+click straight lines.
  const lastBrushPt = useRef<{ x: number; y: number } | null>(null);

  const store = useDevelopStore.getState;

  const selectedMask = masks.find((m) => m.id === selectedMaskId) ?? null;
  const selectedComp =
    selectedMask?.components.find((c) => c.id === selectedComponentId) ?? null;

  // --- hit testing -----------------------------------------------------------
  function hitSelectedComponent(px: number, py: number): { kind: HandleId } | null {
    const c = selectedComp;
    if (!c) return null;
    if (c.kind === "radial" && c.radial) {
      const rot = radialHandle(c.radial, "rotate");
      if (Math.hypot(px - rot.x, py - rot.y) <= HIT) return { kind: "radial-rotate" };
      for (const [w, k] of [
        ["e", "radial-e"], ["w", "radial-w"], ["n", "radial-n"], ["s", "radial-s"],
      ] as const) {
        const h = radialHandle(c.radial, w);
        if (Math.hypot(px - h.x, py - h.y) <= HIT) return { kind: k };
      }
      const ctr = radialHandle(c.radial, "center");
      if (Math.hypot(px - ctr.x, py - ctr.y) <= HIT) return { kind: "radial-move" };
    } else if (c.kind === "linear" && c.linear) {
      const p0 = toScreen(c.linear.x0, c.linear.y0);
      const p1 = toScreen(c.linear.x1, c.linear.y1);
      if (Math.hypot(px - p0.x, py - p0.y) <= HIT) return { kind: "linear-p0" };
      if (Math.hypot(px - p1.x, py - p1.y) <= HIT) return { kind: "linear-p1" };
    }
    return null;
  }

  function hitSpot(px: number, py: number): { kind: "spot-dst" | "spot-src"; id: string } | null {
    for (let i = spots.length - 1; i >= 0; i--) {
      const s = spots[i];
      // Source: a brush source can be grabbed anywhere on its (offset) shape;
      // a circle source only near its anchor.
      if (s.shape === "brush" && s.dabs) {
        const ox = s.srcX - s.dstX, oy = s.srcY - s.dstY;
        for (const d of s.dabs) {
          const c = toScreen(d.x + ox, d.y + oy);
          if (Math.hypot(px - c.x, py - c.y) <= Math.max(HIT, radiusToScreen(d.radius))) {
            return { kind: "spot-src", id: s.id };
          }
        }
      } else {
        const src = toScreen(s.srcX, s.srcY);
        if (Math.hypot(px - src.x, py - src.y) <= Math.max(HIT, radiusToScreen(s.radius))) {
          return { kind: "spot-src", id: s.id };
        }
      }
      if (s.shape === "brush" && s.dabs) {
        for (const d of s.dabs) {
          const c = toScreen(d.x, d.y);
          if (Math.hypot(px - c.x, py - c.y) <= Math.max(HIT, radiusToScreen(d.radius))) {
            return { kind: "spot-dst", id: s.id };
          }
        }
      } else {
        const dst = toScreen(s.dstX, s.dstY);
        if (Math.hypot(px - dst.x, py - dst.y) <= Math.max(HIT, radiusToScreen(s.radius))) {
          return { kind: "spot-dst", id: s.id };
        }
      }
    }
    return null;
  }

  // --- component creation ----------------------------------------------------
  function newMaskWith(comp: MaskComponent): string {
    const id = genId("mask");
    const mask: Mask = {
      id,
      name: comp.kind[0].toUpperCase() + comp.kind.slice(1),
      visible: true,
      invert: false,
      opacity: 100,
      adj: defaultMaskAdjustments(),
      panels: [...DEFAULT_MASK_PANELS],
      components: [comp],
    };
    store().addMask(mask);
    return id;
  }

  // Resolve where a new component lands: a fresh mask, or the selected one.
  function resolveTarget(): "new" | string {
    const st = store();
    if (st.maskAddTarget === "new") return "new";
    if (st.selectedMaskId && masks.some((m) => m.id === st.selectedMaskId))
      return st.selectedMaskId;
    return "new";
  }

  // --- pointer handlers ------------------------------------------------------
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    e.currentTarget.setPointerCapture(e.pointerId);
    const down = toSource(px, py);
    const st = store();

    // Colour-range eyedropper: sample the pixel under the cursor (px/py are in
    // render-buffer coords) into the selected colour-range component, then stop.
    if (st.maskColorPicking && selectedMask && selectedComp?.kind === "colorRange") {
      const cv = canvasRef?.current ?? null;
      const rgb = cv ? sampleLinearRGB(cv, px, py) : null;
      if (rgb) {
        const cur = selectedComp.colorRange ?? defaultColorRange();
        st.updateComponent(selectedMask.id, selectedComp.id, {
          colorRange: { ...cur, r: rgb[0], g: rgb[1], b: rgb[2] },
        });
        st.commitEdit("Colour Range Pick");
      }
      st.setMaskColorPicking(false);
      return;
    }

    if (activeTool === "retouch") {
      const hit = hitSpot(px, py);
      if (hit) {
        st.selectSpot(hit.id);
        dragRef.current = { kind: hit.kind, id: hit.id, downSrc: down };
        return;
      }
      const id = genId("spot");
      // Provisional source offset just so something shows while painting; the
      // real source is chosen on pointer-up from the whole painted region (and
      // can be dragged afterwards).
      const off = Math.max(0.04, st.retouchSize * 1.5);
      const srcX = down.x - off / imageAspect;
      const srcY = down.y - off;
      const firstDab: BrushDab = {
        x: down.x,
        y: down.y,
        radius: st.retouchSize,
        erase: false,
        feather: st.retouchFeather / 100,
      };
      const spot: RetouchSpot = {
        id,
        shape: "brush",
        mode: st.retouchMode,
        visible: true,
        dstX: down.x,
        dstY: down.y,
        srcX,
        srcY,
        radius: st.retouchSize,
        feather: st.retouchFeather,
        opacity: st.retouchOpacity,
        angle: 0,
        scale: 1,
        recolorR: 0,
        recolorG: 0,
        recolorB: 0,
        dabs: [firstDab],
      };
      st.addSpot(spot);
      dragRef.current = { kind: "retouch-paint", id, downSrc: down, lastDab: down, dabs: [firstDab] };
      return;
    }

    if (activeTool !== "mask") return;

    // 1) Editing an existing component's handle wins.
    const handle = hitSelectedComponent(px, py);
    if (handle) {
      dragRef.current = {
        kind: handle.kind,
        maskId: selectedMask!.id,
        compId: selectedComp!.id,
        downSrc: down,
      };
      return;
    }

    // 2) Otherwise create a new component of the active tool type.
    const mode = st.maskCompMode;
    if (maskToolType === "brush") {
      const target = resolveTarget();
      let maskId: string;
      let compId: string;
      // Reuse an existing brush component of the same mode when extending.
      const mask = target === "new" ? null : masks.find((m) => m.id === target);
      const existing =
        mask?.components.find((c) => c.kind === "brush" && c.mode === mode) ?? null;
      if (existing && mask) {
        maskId = mask.id;
        compId = existing.id;
        st.selectMask(maskId);
        st.selectComponent(compId);
      } else {
        compId = genId("comp");
        const comp: MaskComponent = {
          id: compId,
          kind: "brush",
          mode,
          invert: false,
          brush: { dabs: [], feather: st.brushFeather },
        };
        if (target === "new") maskId = newMaskWith(comp);
        else {
          maskId = target;
          st.addComponent(maskId, comp);
        }
        st.setMaskAddTarget("current");
      }
      // Shift+click: straight line of dabs from the previous brush point.
      if (e.shiftKey && lastBrushPt.current) {
        const a = lastBrushPt.current;
        const dist = Math.hypot((down.x - a.x) * imageAspect, down.y - a.y);
        const steps = Math.max(1, Math.ceil(dist / (st.brushSize * 0.25)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          st.addBrushDab(maskId, compId, {
            x: a.x + (down.x - a.x) * t,
            y: a.y + (down.y - a.y) * t,
            radius: st.brushSize,
            erase: e.altKey || st.brushErase,
            feather: st.brushFeather,
            opacity: st.brushOpacity,
            flow: st.brushFlow,
          });
        }
      } else {
        st.addBrushDab(maskId, compId, {
          x: down.x,
          y: down.y,
          radius: st.brushSize,
          erase: e.altKey || st.brushErase,
          feather: st.brushFeather,
          opacity: st.brushOpacity,
          flow: st.brushFlow,
        });
      }
      lastBrushPt.current = down;
      dragRef.current = { kind: "brush", maskId, compId, downSrc: down, lastDab: down };
      return;
    }

    // Radial / linear: create a zero-size component and drag it out.
    const target = resolveTarget();
    const compId = genId("comp");
    let comp: MaskComponent;
    if (maskToolType === "radial") {
      comp = {
        id: compId,
        kind: "radial",
        mode,
        invert: false,
        radial: { cx: down.x, cy: down.y, rx: 0.001, ry: 0.001, feather: 0.5, angle: 0 },
      };
    } else {
      comp = {
        id: compId,
        kind: "linear",
        mode,
        invert: false,
        linear: { x0: down.x, y0: down.y, x1: down.x, y1: down.y },
      };
    }
    let maskId: string;
    if (target === "new") maskId = newMaskWith(comp);
    else {
      maskId = target;
      st.addComponent(maskId, comp);
    }
    st.setMaskAddTarget("current");
    dragRef.current = {
      kind: maskToolType === "radial" ? "create-radial" : "create-linear",
      maskId,
      compId,
      downSrc: down,
      fromCenter: e.altKey,
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    setCursor({ x: px, y: py, alt: e.altKey });
    const d = dragRef.current;
    if (!d) {
      // Hover feedback on the selected component's handles.
      if (activeTool === "mask") setHovered(hitSelectedComponent(px, py)?.kind ?? null);
      return;
    }
    const cur = toSource(px, py);
    const st = store();
    const shift = e.shiftKey;
    switch (d.kind) {
      case "create-radial": {
        let cx: number, cy: number, rx: number, ry: number;
        if (d.fromCenter) {
          cx = d.downSrc.x;
          cy = d.downSrc.y;
          rx = Math.max(0.001, Math.abs(cur.x - d.downSrc.x));
          ry = Math.max(0.001, Math.abs(cur.y - d.downSrc.y));
        } else {
          cx = (d.downSrc.x + cur.x) / 2;
          cy = (d.downSrc.y + cur.y) / 2;
          rx = Math.max(0.001, Math.abs(cur.x - d.downSrc.x) / 2);
          ry = Math.max(0.001, Math.abs(cur.y - d.downSrc.y) / 2);
        }
        if (shift) {
          // Constrain to a circle (equal radii in screen-proportional space).
          const r = Math.max(rx * imageAspect, ry);
          rx = r / imageAspect;
          ry = r;
        }
        st.updateComponent(d.maskId!, d.compId!, {
          radial: { cx, cy, rx, ry, feather: 0.5, angle: 0 },
        });
        break;
      }
      case "create-linear": {
        let end = cur;
        if (shift) end = snapLinear(d.downSrc, cur, imageAspect);
        st.updateComponent(d.maskId!, d.compId!, {
          linear: { x0: d.downSrc.x, y0: d.downSrc.y, x1: end.x, y1: end.y },
        });
        break;
      }
      case "radial-move": {
        const c = findComp(d);
        if (c?.radial) st.updateComponent(d.maskId!, d.compId!, { radial: { ...c.radial, cx: cur.x, cy: cur.y } });
        break;
      }
      case "radial-e":
      case "radial-w":
      case "radial-n":
      case "radial-s": {
        const c = findComp(d);
        if (c?.radial) {
          const rr = c.radial;
          const qx = (cur.x - rr.cx) * imageAspect;
          const qy = cur.y - rr.cy;
          const ca = Math.cos(-rr.angle);
          const sa = Math.sin(-rr.angle);
          const lx = ca * qx - sa * qy; // local x (aspect-scaled), along rx axis
          const ly = sa * qx + ca * qy; // local y, along ry axis
          const ra = rr.angle;
          const horiz = d.kind === "radial-e" || d.kind === "radial-w";
          // The dragged edge's new local position along its axis, plus the
          // current radius (in the same local q-space) for that axis.
          const local = horiz ? lx : ly;
          const oldR = horiz ? rr.rx * imageAspect : rr.ry;
          const sign = d.kind === "radial-e" || d.kind === "radial-s" ? 1 : -1;
          let newR: number;
          let cx = rr.cx;
          let cy = rr.cy;
          if (e.altKey) {
            // Resize symmetrically about the centre.
            newR = Math.abs(local);
          } else {
            // Anchor the opposite edge; the centre slides along the axis.
            const anchor = -sign * oldR;
            newR = Math.abs(local - anchor) / 2;
            const cLocal = (local + anchor) / 2;
            // Rotate the local offset (along this axis) back into source-UV.
            const oqx = horiz ? Math.cos(ra) * cLocal : -Math.sin(ra) * cLocal;
            const oqy = horiz ? Math.sin(ra) * cLocal : Math.cos(ra) * cLocal;
            cx = rr.cx + oqx / imageAspect;
            cy = rr.cy + oqy;
          }
          let rx = rr.rx;
          let ry = rr.ry;
          if (horiz) rx = Math.max(0.002, newR / imageAspect);
          else ry = Math.max(0.002, newR);
          if (shift) {
            // Preserve aspect ratio: scale the other axis by the same factor.
            if (horiz && rr.rx > 1e-4) ry = Math.max(0.002, rr.ry * (rx / rr.rx));
            else if (!horiz && rr.ry > 1e-4) rx = Math.max(0.002, rr.rx * (ry / rr.ry));
          }
          st.updateComponent(d.maskId!, d.compId!, { radial: { ...rr, rx, ry, cx, cy } });
        }
        break;
      }
      case "radial-rotate": {
        const c = findComp(d);
        if (c?.radial) {
          const qx = (cur.x - c.radial.cx) * imageAspect;
          const qy = cur.y - c.radial.cy;
          let angle = Math.atan2(qy, qx) + Math.PI / 2;
          if (shift) angle = Math.round(angle / SNAP) * SNAP;
          st.updateComponent(d.maskId!, d.compId!, { radial: { ...c.radial, angle } });
        }
        break;
      }
      case "linear-p0": {
        const c = findComp(d);
        if (c?.linear) {
          let p = cur;
          if (shift) p = snapLinear({ x: c.linear.x1, y: c.linear.y1 }, cur, imageAspect);
          st.updateComponent(d.maskId!, d.compId!, { linear: { ...c.linear, x0: p.x, y0: p.y } });
        }
        break;
      }
      case "linear-p1": {
        const c = findComp(d);
        if (c?.linear) {
          let p = cur;
          if (shift) p = snapLinear({ x: c.linear.x0, y: c.linear.y0 }, cur, imageAspect);
          st.updateComponent(d.maskId!, d.compId!, { linear: { ...c.linear, x1: p.x, y1: p.y } });
        }
        break;
      }
      case "brush": {
        const last = d.lastDab ?? d.downSrc;
        const dist = Math.hypot((cur.x - last.x) * imageAspect, cur.y - last.y);
        if (dist >= st.brushSize * 0.25) {
          st.addBrushDab(d.maskId!, d.compId!, {
            x: cur.x,
            y: cur.y,
            radius: st.brushSize,
            erase: e.altKey || st.brushErase,
            feather: st.brushFeather,
            opacity: st.brushOpacity,
            flow: st.brushFlow,
          });
          d.lastDab = cur;
          lastBrushPt.current = cur;
        }
        break;
      }
      case "retouch-paint": {
        const last = d.lastDab ?? d.downSrc;
        const dist = Math.hypot((cur.x - last.x) * imageAspect, cur.y - last.y);
        if (dist >= st.retouchSize * 0.25 && d.dabs) {
          d.dabs.push({
            x: cur.x,
            y: cur.y,
            radius: st.retouchSize,
            erase: false,
            feather: st.retouchFeather / 100,
          });
          st.updateSpot(d.id!, { dabs: [...d.dabs] });
          d.lastDab = cur;
        }
        break;
      }
      case "spot-dst": {
        const s = st.params.retouch.find((sp) => sp.id === d.id);
        if (s) {
          const dx = cur.x - d.downSrc.x;
          const dy = cur.y - d.downSrc.y;
          const patch: Partial<RetouchSpot> = {
            dstX: s.dstX + dx,
            dstY: s.dstY + dy,
            srcX: s.srcX + dx,
            srcY: s.srcY + dy,
          };
          if (s.dabs) patch.dabs = s.dabs.map((db) => ({ ...db, x: db.x + dx, y: db.y + dy }));
          st.updateSpot(d.id!, patch);
          d.downSrc = cur;
        }
        break;
      }
      case "spot-src": {
        const s = st.params.retouch.find((sp) => sp.id === d.id);
        if (s) {
          const dx = cur.x - d.downSrc.x, dy = cur.y - d.downSrc.y;
          const srcX = s.srcX + dx, srcY = s.srcY + dy;
          const patch: Partial<RetouchSpot> = {
            srcX,
            srcY,
            angle: 0,
            scale: 1,
          };
          if (s.mode !== "clone") {
            const off = healColorOffset(s.dstX, s.dstY, srcX, srcY, s.radius, imageAspect);
            patch.recolorR = off.r;
            patch.recolorG = off.g;
            patch.recolorB = off.b;
          }
          st.updateSpot(d.id!, patch);
          d.downSrc = cur;
        }
        break;
      }
    }
  };

  function findComp(d: { maskId?: string; compId?: string }): MaskComponent | undefined {
    const m = store().params.masks.find((mm) => mm.id === d.maskId);
    return m?.components.find((c) => c.id === d.compId);
  }

  // Choose the source for a freshly painted spot, from its whole painted region
  // (centre + extent) rather than the first click. Heal auto-fits; clone just
  // offsets clear of the region. Either can be dragged afterwards.
  function chooseRetouchSource(id: string) {
    const st = store();
    const s = st.params.retouch.find((sp) => sp.id === id);
    if (!s) return;
    let cx = s.dstX, cy = s.dstY, rad = s.radius;
    if (s.shape === "brush" && s.dabs && s.dabs.length > 0) {
      let sx = 0, sy = 0;
      for (const d of s.dabs) { sx += d.x; sy += d.y; }
      cx = sx / s.dabs.length; cy = sy / s.dabs.length;
      let m = 0;
      for (const d of s.dabs) m = Math.max(m, Math.hypot(d.x - cx, d.y - cy) + d.radius);
      rad = m;
    }
    const patch: Partial<RetouchSpot> = {};
    const auto = findHealSource(cx, cy, rad, imageAspect);
    if (auto) {
      patch.srcX = s.dstX + (auto.x - cx);
      patch.srcY = s.dstY + (auto.y - cy);
      patch.angle = auto.angle; patch.scale = auto.scale;
      if (s.mode !== "clone") {
        patch.recolorR = auto.r; patch.recolorG = auto.g; patch.recolorB = auto.b;
      }
      st.updateSpot(id, patch);
      return;
    }
    // No usable candidate: offset clear of the painted region.
    const off = Math.max(0.04, rad * 2.2);
    patch.srcX = s.dstX - off / imageAspect;
    patch.srcY = s.dstY - off;
    st.updateSpot(id, patch);
  }

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const st = store();
    // A bare click (no real drag) on empty canvas: drop the stray zero-size
    // component and deselect, so clicking away dismisses the mask + overlay.
    if (d.kind === "create-radial") {
      const c = findComp(d);
      if (c?.radial && (c.radial.rx < 0.01 || c.radial.ry < 0.01)) {
        st.removeComponent(d.maskId!, d.compId!);
        st.selectMask(null);
        st.selectComponent(null);
        return;
      }
    }
    if (d.kind === "create-linear") {
      const c = findComp(d);
      if (c?.linear && Math.hypot(c.linear.x1 - c.linear.x0, c.linear.y1 - c.linear.y0) < 0.01) {
        st.removeComponent(d.maskId!, d.compId!);
        st.selectMask(null);
        st.selectComponent(null);
        return;
      }
    }
    if (d.kind === "retouch-paint") {
      if (d.dabs && d.dabs.length <= 1) {
        st.updateSpot(d.id!, { shape: "circle", dabs: undefined });
      }
      // Decide the source now that the whole stroke is known.
      chooseRetouchSource(d.id!);
    }
    st.commitEdit(activeTool === "retouch" ? "Retouch" : "Mask");
  };

  // Delete (remove component) and Shift+[ / Shift+] (brush feather) are handled
  // centrally as rebindable shortcuts in use-keyboard-shortcuts.

  // --- rendering -------------------------------------------------------------
  const showBrushCursor = activeTool === "mask" && maskToolType === "brush" && cursor;
  const showSpotCursor = activeTool === "retouch" && cursor && !dragRef.current;
  // Reactive so the cursor ring resizes the instant [ / ] change the size.
  const brushPx = radiusToScreen(brushSize);
  const spotPx = radiusToScreen(retouchSize);
  const subErase = (cursor?.alt || brushErase) || store().maskCompMode === "subtract";
  // Centre reference circle shown while a Size/Feather slider is dragged — for
  // the mask brush or the heal brush (shared behaviour).
  const showBrushRef =
    brushPreview &&
    ((activeTool === "mask" && maskToolType === "brush") || activeTool === "retouch");
  const refRadiusPx = activeTool === "retouch" ? spotPx : brushPx;
  const refFeather = activeTool === "retouch" ? retouchFeather / 100 : brushFeather;
  const refCx = rect.x + rect.w / 2;
  const refCy = rect.y + rect.h / 2;

  return (
    <div
      className="absolute inset-0"
      style={{ cursor: "crosshair", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => setCursor(null)}
    >
      <svg className="pointer-events-none absolute inset-0 h-full w-full">
        {/* Mask components — only while the masking tool is active. */}
        {activeTool === "mask" && masks.flatMap((m) =>
          m.components.map((c) => {
            const selComp = c.id === selectedComponentId && m.id === selectedMaskId;
            const sub = c.mode === "subtract";
            const stroke = selComp ? (sub ? COLOR.sub : COLOR.add) : (sub ? COLOR.subDim : COLOR.addDim);
            const grip = sub ? COLOR.sub : COLOR.add;
            const key = m.id + ":" + c.id;
            if (c.kind === "radial" && c.radial) {
              const ctr = radialHandle(c.radial, "center");
              const rot = radialHandle(c.radial, "rotate");
              const big = (h: HandleId) => (hovered === h && selComp ? 6 : 5);
              const sizeHandles = [
                ["radial-e", "e"], ["radial-w", "w"], ["radial-n", "n"], ["radial-s", "s"],
              ] as const;
              return (
                <g key={key}>
                  <path
                    d={rotatedEllipsePath(c.radial)}
                    fill="none"
                    stroke={stroke}
                    strokeWidth={selComp ? 1.8 : 1.4}
                    strokeDasharray={sub ? "5 4" : undefined}
                  />
                  {selComp && <line x1={ctr.x} y1={ctr.y} x2={rot.x} y2={rot.y} stroke={grip} strokeWidth={1} opacity={0.6} />}
                  {selComp && <circle cx={ctr.x} cy={ctr.y} r={big("radial-move")} fill={grip} />}
                  {selComp && sizeHandles.map(([id, w]) => {
                    const h = radialHandle(c.radial!, w);
                    return <circle key={id} cx={h.x} cy={h.y} r={big(id)} fill="#fff" stroke={grip} strokeWidth={1.5} />;
                  })}
                  {selComp && <circle cx={rot.x} cy={rot.y} r={big("radial-rotate") + 1} fill={grip} stroke="#fff" strokeWidth={1.5} />}
                </g>
              );
            }
            if (c.kind === "linear" && c.linear) {
              const p0 = toScreen(c.linear.x0, c.linear.y0);
              const p1 = toScreen(c.linear.x1, c.linear.y1);
              const dx = p1.x - p0.x;
              const dy = p1.y - p0.y;
              const len = Math.hypot(dx, dy) || 1;
              const nx = (-dy / len) * 400;
              const ny = (dx / len) * 400;
              return (
                <g key={key}>
                  <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={stroke} strokeWidth={1.2} />
                  <line x1={p0.x - nx} y1={p0.y - ny} x2={p0.x + nx} y2={p0.y + ny} stroke={stroke} strokeWidth={1.2} strokeDasharray="4 4" />
                  <line x1={p1.x - nx} y1={p1.y - ny} x2={p1.x + nx} y2={p1.y + ny} stroke={stroke} strokeWidth={1.2} />
                  {selComp && <circle cx={p0.x} cy={p0.y} r={hovered === "linear-p0" ? 6 : 5} fill="#fff" stroke={grip} strokeWidth={1.5} />}
                  {selComp && <circle cx={p1.x} cy={p1.y} r={hovered === "linear-p1" ? 6 : 5} fill={grip} stroke="#fff" strokeWidth={1.5} />}
                </g>
              );
            }
            return null;
          }),
        )}

        {/* Retouch — only while the retouch tool is active. */}
        {activeTool === "retouch" && spots.map((s) => {
          const src = toScreen(s.srcX, s.srcY);
          const dst = toScreen(s.dstX, s.dstY);
          const r = radiusToScreen(s.radius);
          const sel = s.id === selectedSpotId;
          const col = "#e0e0e0";
          if (s.shape === "brush" && s.dabs && s.dabs.length > 0) {
            // One outline for the whole painted region; the source mirrors that
            // exact shape, translated by the source offset (transform is affine).
            const circles = s.dabs.map((db) => {
              const c = toScreen(db.x, db.y);
              return { x: c.x, y: c.y, r: radiusToScreen(db.radius) };
            });
            const outline = unionOutlinePath(circles);
            const dx = src.x - dst.x, dy = src.y - dst.y;
            return (
              <g key={s.id}>
                <line x1={src.x} y1={src.y} x2={dst.x} y2={dst.y} stroke={col} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
                <path d={outline} fill="none" stroke={col} strokeWidth={1} strokeDasharray="2 2" strokeLinecap="round" strokeLinejoin="round" opacity={0.8} transform={`translate(${dx} ${dy})`} />
                <path d={outline} fill="none" stroke={col} strokeWidth={sel ? 2 : 1.2} strokeLinecap="round" strokeLinejoin="round" />
              </g>
            );
          }
          return (
            <g key={s.id}>
              <line x1={src.x} y1={src.y} x2={dst.x} y2={dst.y} stroke={col} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
              <circle cx={src.x} cy={src.y} r={r} fill="none" stroke={col} strokeWidth={1} strokeDasharray="2 2" />
              <circle cx={dst.x} cy={dst.y} r={r} fill="none" stroke={col} strokeWidth={sel ? 2 : 1.2} />
            </g>
          );
        })}

        {/* Tool cursors */}
        {showBrushCursor && (
          <g>
            <circle
              cx={cursor!.x}
              cy={cursor!.y}
              r={Math.max(3, brushPx)}
              fill="none"
              stroke={subErase ? "#ff6b6b" : "#fff"}
              strokeWidth={1.2}
              strokeDasharray={subErase ? "4 3" : undefined}
              opacity={0.9}
            />
            {/* Inner ring shows the feathered core. */}
            <circle
              cx={cursor!.x}
              cy={cursor!.y}
              r={Math.max(1, brushPx * (1 - brushFeather))}
              fill="none"
              stroke={subErase ? "#ff6b6b" : "#fff"}
              strokeWidth={0.6}
              opacity={0.4}
            />
          </g>
        )}
        {/* Centre reference while dragging the Size / Feather sliders. */}
        {showBrushRef && (
          <g opacity={0.8}>
            <circle cx={refCx} cy={refCy} r={Math.max(3, refRadiusPx)} fill="none" stroke="#fff" strokeWidth={1.2} />
            <circle cx={refCx} cy={refCy} r={Math.max(1, refRadiusPx * (1 - refFeather))} fill="none" stroke="#fff" strokeWidth={0.6} opacity={0.5} />
          </g>
        )}
        {showSpotCursor && (
          <circle cx={cursor!.x} cy={cursor!.y} r={Math.max(3, spotPx)} fill="none" stroke="#e0e0e0" strokeWidth={1} opacity={0.8} />
        )}
      </svg>
    </div>
  );
}

// Snap an endpoint so the line from `anchor` lies on a 0/45/90° axis (in
// screen-proportional space).
function snapLinear(
  anchor: { x: number; y: number },
  p: { x: number; y: number },
  aspect: number,
): { x: number; y: number } {
  const qx = (p.x - anchor.x) * aspect;
  const qy = p.y - anchor.y;
  const len = Math.hypot(qx, qy);
  if (len < 1e-6) return p;
  let ang = Math.atan2(qy, qx);
  ang = Math.round(ang / (Math.PI / 4)) * (Math.PI / 4);
  return {
    x: anchor.x + (Math.cos(ang) * len) / aspect,
    y: anchor.y + Math.sin(ang) * len,
  };
}
