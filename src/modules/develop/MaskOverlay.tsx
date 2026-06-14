import { useEffect, useRef, useState } from "react";
import type {
  BrushDab,
  CropRect,
  Mask,
  MaskComponent,
  RadialMaskGeo,
  RetouchSpot,
} from "@/catalog/types";
import { DEFAULT_MASK_PANELS, defaultMaskAdjustments } from "@/catalog/types";
import { mat3Apply, type Mat3 } from "@/rendering/transform";
import { useDevelopStore } from "@/state/develop-store";
import { findHealSource, healColorOffset } from "@/rendering/heal-source";

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
  | "radial-size"
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

export function MaskOverlay({ rect, crop, inv, forward, imageAspect }: MaskOverlayProps) {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const maskToolType = useDevelopStore((s) => s.maskToolType);
  const masks = useDevelopStore((s) => s.params.masks);
  const spots = useDevelopStore((s) => s.params.retouch);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const selectedComponentId = useDevelopStore((s) => s.selectedComponentId);
  const selectedSpotId = useDevelopStore((s) => s.selectedSpotId);
  const brushErase = useDevelopStore((s) => s.brushErase);

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
    which: "center" | "size" | "rotate",
  ): { x: number; y: number } => {
    if (which === "center") return toScreen(r.cx, r.cy);
    const ca = Math.cos(r.angle);
    const sa = Math.sin(r.angle);
    let qx = 0;
    let qy = 0;
    if (which === "size") {
      qx = r.rx * imageAspect;
      qy = 0;
    } else {
      qx = 0;
      qy = -(r.ry + ROT_OFFSET);
    }
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
      const edge = radialHandle(c.radial, "size");
      if (Math.hypot(px - edge.x, py - edge.y) <= HIT) return { kind: "radial-size" };
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
          });
        }
      } else {
        st.addBrushDab(maskId, compId, {
          x: down.x,
          y: down.y,
          radius: st.brushSize,
          erase: e.altKey || st.brushErase,
          feather: st.brushFeather,
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
      case "radial-size": {
        const c = findComp(d);
        if (c?.radial) {
          const qx = (cur.x - c.radial.cx) * imageAspect;
          const qy = cur.y - c.radial.cy;
          const ca = Math.cos(-c.radial.angle);
          const sa = Math.sin(-c.radial.angle);
          const lx = ca * qx - sa * qy;
          const ly = sa * qx + ca * qy;
          let rx = Math.max(0.002, Math.abs(lx) / imageAspect);
          let ry = Math.max(0.002, Math.abs(ly));
          if (shift) {
            const r = Math.max(rx * imageAspect, ry);
            rx = r / imageAspect;
            ry = r;
          }
          st.updateComponent(d.maskId!, d.compId!, { radial: { ...c.radial, rx, ry } });
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
          // Relative move so the source can be grabbed anywhere on its shape.
          // A manual move overrides the auto-fit rotation/scale.
          const dx = cur.x - d.downSrc.x, dy = cur.y - d.downSrc.y;
          const srcX = s.srcX + dx, srcY = s.srcY + dy;
          const off = healColorOffset(s.dstX, s.dstY, srcX, srcY, s.radius, imageAspect);
          const patch: Partial<RetouchSpot> = {
            srcX,
            srcY,
            angle: 0,
            scale: 1,
            recolorR: off.r,
            recolorG: off.g,
            recolorB: off.b,
          };
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
      // Translate so the source shape lands centred on the auto-picked centre.
      patch.srcX = s.dstX + (auto.x - cx);
      patch.srcY = s.dstY + (auto.y - cy);
      patch.angle = auto.angle; patch.scale = auto.scale;
      patch.recolorR = auto.r; patch.recolorG = auto.g; patch.recolorB = auto.b;
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
    // Drop a barely-dragged radial/linear (a stray click).
    if (d.kind === "create-radial") {
      const c = findComp(d);
      if (c?.radial && (c.radial.rx < 0.01 || c.radial.ry < 0.01)) {
        st.removeComponent(d.maskId!, d.compId!);
        return;
      }
    }
    if (d.kind === "create-linear") {
      const c = findComp(d);
      if (c?.linear && Math.hypot(c.linear.x1 - c.linear.x0, c.linear.y1 - c.linear.y0) < 0.01) {
        st.removeComponent(d.maskId!, d.compId!);
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

  // Delete removes the selected component; Shift+[ / Shift+] tune brush feather.
  useEffect(() => {
    if (activeTool !== "mask") return;
    const onKey = (e: KeyboardEvent) => {
      const st = store();
      if ((e.key === "Delete" || e.key === "Backspace") && selectedMask && selectedComp) {
        e.preventDefault();
        st.removeComponent(selectedMask.id, selectedComp.id);
        st.commitEdit("Delete Component");
      } else if (e.shiftKey && (e.key === "{" || e.key === "[")) {
        e.preventDefault();
        st.setBrushFeather(Math.max(0, Math.round((st.brushFeather - 0.05) * 100) / 100));
      } else if (e.shiftKey && (e.key === "}" || e.key === "]")) {
        e.preventDefault();
        st.setBrushFeather(Math.min(1, Math.round((st.brushFeather + 0.05) * 100) / 100));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activeTool, selectedMask, selectedComp, store]);

  // --- rendering -------------------------------------------------------------
  const showBrushCursor = activeTool === "mask" && maskToolType === "brush" && cursor;
  const showSpotCursor = activeTool === "retouch" && cursor && !dragRef.current;
  const brushPx = radiusToScreen(useDevelopStore.getState().brushSize);
  const spotPx = radiusToScreen(useDevelopStore.getState().retouchSize);
  const subErase = (cursor?.alt || brushErase) || store().maskCompMode === "subtract";

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
        {/* Mask components */}
        {masks.flatMap((m) =>
          m.components.map((c) => {
            const selComp = c.id === selectedComponentId && m.id === selectedMaskId;
            const sub = c.mode === "subtract";
            const stroke = selComp ? (sub ? COLOR.sub : COLOR.add) : (sub ? COLOR.subDim : COLOR.addDim);
            const grip = sub ? COLOR.sub : COLOR.add;
            const key = m.id + ":" + c.id;
            if (c.kind === "radial" && c.radial) {
              const ctr = radialHandle(c.radial, "center");
              const edge = radialHandle(c.radial, "size");
              const rot = radialHandle(c.radial, "rotate");
              const big = (h: HandleId) => (hovered === h && selComp ? 6 : 5);
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
                  {selComp && <circle cx={edge.x} cy={edge.y} r={big("radial-size")} fill="#fff" stroke={grip} strokeWidth={1.5} />}
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

        {/* Retouch */}
        {spots.map((s) => {
          const src = toScreen(s.srcX, s.srcY);
          const dst = toScreen(s.dstX, s.dstY);
          const r = radiusToScreen(s.radius);
          const sel = s.id === selectedSpotId;
          const col = "#4affa3";
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
              r={Math.max(1, brushPx * (1 - store().brushFeather))}
              fill="none"
              stroke={subErase ? "#ff6b6b" : "#fff"}
              strokeWidth={0.6}
              opacity={0.4}
            />
          </g>
        )}
        {showSpotCursor && (
          <circle cx={cursor!.x} cy={cursor!.y} r={Math.max(3, spotPx)} fill="none" stroke="#4affa3" strokeWidth={1} opacity={0.8} />
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
