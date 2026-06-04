import { useRef, useState } from "react";
import type { BrushDab, CropRect, Mask, RetouchSpot } from "@/catalog/types";
import { defaultMaskAdjustments } from "@/catalog/types";
import { mat3Apply, type Mat3 } from "@/rendering/transform";
import { useDevelopStore } from "@/state/develop-store";

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

const HIT = 11; // px handle hit radius
const ROT_OFFSET = 0.06; // rotate-handle gap beyond the ellipse top (q-units)

type DragKind =
  | "create-radial"
  | "create-linear"
  | "brush"
  | "radial-move"
  | "radial-size"
  | "radial-rotate"
  | "linear-p0"
  | "linear-p1"
  | "spot-dst"
  | "spot-src"
  | "retouch-paint";

export function MaskOverlay({ rect, crop, inv, forward, imageAspect }: MaskOverlayProps) {
  const activeTool = useDevelopStore((s) => s.activeTool);
  const maskToolType = useDevelopStore((s) => s.maskToolType);
  const masks = useDevelopStore((s) => s.params.masks);
  const spots = useDevelopStore((s) => s.params.retouch);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const selectedSpotId = useDevelopStore((s) => s.selectedSpotId);

  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

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
    m: Mask,
    which: "center" | "size" | "rotate",
  ): { x: number; y: number } => {
    const r = m.radial!;
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
  const rotatedEllipsePath = (m: Mask) => {
    const r = m.radial!;
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
    id?: string;
    downSrc: { x: number; y: number };
    lastDab?: { x: number; y: number };
    dabs?: BrushDab[];
  } | null>(null);

  const store = useDevelopStore.getState;

  // --- hit testing -----------------------------------------------------------
  function hitSelectedMask(px: number, py: number):
    | { kind: "radial-move" | "radial-size" | "radial-rotate" | "linear-p0" | "linear-p1"; id: string }
    | null {
    const m = masks.find((mm) => mm.id === selectedMaskId);
    if (!m) return null;
    if (m.type === "radial" && m.radial) {
      const rot = radialHandle(m, "rotate");
      if (Math.hypot(px - rot.x, py - rot.y) <= HIT) return { kind: "radial-rotate", id: m.id };
      const edge = radialHandle(m, "size");
      if (Math.hypot(px - edge.x, py - edge.y) <= HIT) return { kind: "radial-size", id: m.id };
      const c = radialHandle(m, "center");
      if (Math.hypot(px - c.x, py - c.y) <= HIT) return { kind: "radial-move", id: m.id };
    } else if (m.type === "linear" && m.linear) {
      const p0 = toScreen(m.linear.x0, m.linear.y0);
      const p1 = toScreen(m.linear.x1, m.linear.y1);
      if (Math.hypot(px - p0.x, py - p0.y) <= HIT) return { kind: "linear-p0", id: m.id };
      if (Math.hypot(px - p1.x, py - p1.y) <= HIT) return { kind: "linear-p1", id: m.id };
    }
    return null;
  }

  function hitSpot(px: number, py: number): { kind: "spot-dst" | "spot-src"; id: string } | null {
    for (let i = spots.length - 1; i >= 0; i--) {
      const s = spots[i];
      const src = toScreen(s.srcX, s.srcY);
      if (Math.hypot(px - src.x, py - src.y) <= Math.max(HIT, radiusToScreen(s.radius))) {
        return { kind: "spot-src", id: s.id };
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
      // New retouch: start as a brush shape; a click with no drag becomes a
      // circular spot on release.
      const id = genId("spot");
      const off = Math.max(0.04, st.retouchSize * 1.5);
      const firstDab: BrushDab = { x: down.x, y: down.y, radius: st.retouchSize, erase: false };
      const spot: RetouchSpot = {
        id,
        mode: st.retouchMode,
        shape: "brush",
        dstX: down.x,
        dstY: down.y,
        srcX: down.x - off / imageAspect,
        srcY: down.y - off,
        radius: st.retouchSize,
        feather: st.retouchFeather,
        opacity: st.retouchOpacity,
        dabs: [firstDab],
      };
      st.addSpot(spot);
      dragRef.current = { kind: "retouch-paint", id, downSrc: down, lastDab: down, dabs: [firstDab] };
      return;
    }

    if (activeTool === "mask") {
      const handle = hitSelectedMask(px, py);
      if (handle) {
        dragRef.current = { kind: handle.kind, id: handle.id, downSrc: down };
        return;
      }
      if (maskToolType === "radial") {
        const id = genId("radial");
        const mask: Mask = {
          id,
          type: "radial",
          name: "Radial",
          invert: false,
          opacity: 100,
          adj: defaultMaskAdjustments(),
          radial: { cx: down.x, cy: down.y, rx: 0.001, ry: 0.001, feather: 0.5, angle: 0 },
        };
        st.addMask(mask);
        dragRef.current = { kind: "create-radial", id, downSrc: down };
      } else if (maskToolType === "linear") {
        const id = genId("linear");
        const mask: Mask = {
          id,
          type: "linear",
          name: "Linear",
          invert: false,
          opacity: 100,
          adj: defaultMaskAdjustments(),
          linear: { x0: down.x, y0: down.y, x1: down.x, y1: down.y },
        };
        st.addMask(mask);
        dragRef.current = { kind: "create-linear", id, downSrc: down };
      } else {
        let target = masks.find((m) => m.id === selectedMaskId && m.type === "brush");
        if (!target) {
          const id = genId("brush");
          target = {
            id,
            type: "brush",
            name: "Brush",
            invert: false,
            opacity: 100,
            adj: defaultMaskAdjustments(),
            brush: { dabs: [], feather: st.brushFeather },
          };
          st.addMask(target);
        } else {
          st.selectMask(target.id);
        }
        st.addBrushDab(target.id, { x: down.x, y: down.y, radius: st.brushSize, erase: st.brushErase });
        dragRef.current = { kind: "brush", id: target.id, downSrc: down, lastDab: down };
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    setCursor({ x: px, y: py });
    const d = dragRef.current;
    if (!d) return;
    const cur = toSource(px, py);
    const st = store();
    switch (d.kind) {
      case "create-radial": {
        const cx = (d.downSrc.x + cur.x) / 2;
        const cy = (d.downSrc.y + cur.y) / 2;
        const rx = Math.max(0.001, Math.abs(cur.x - d.downSrc.x) / 2);
        const ry = Math.max(0.001, Math.abs(cur.y - d.downSrc.y) / 2);
        st.updateMask(d.id!, { radial: { cx, cy, rx, ry, feather: 0.5, angle: 0 } });
        break;
      }
      case "create-linear": {
        st.updateMask(d.id!, { linear: { x0: d.downSrc.x, y0: d.downSrc.y, x1: cur.x, y1: cur.y } });
        break;
      }
      case "radial-move": {
        const m = st.params.masks.find((mm) => mm.id === d.id);
        if (m?.radial) st.updateMask(d.id!, { radial: { ...m.radial, cx: cur.x, cy: cur.y } });
        break;
      }
      case "radial-size": {
        const m = st.params.masks.find((mm) => mm.id === d.id);
        if (m?.radial) {
          // Resize along the ellipse's own (rotated) axes.
          const qx = (cur.x - m.radial.cx) * imageAspect;
          const qy = cur.y - m.radial.cy;
          const ca = Math.cos(-m.radial.angle);
          const sa = Math.sin(-m.radial.angle);
          const lx = ca * qx - sa * qy;
          const ly = sa * qx + ca * qy;
          const rx = Math.max(0.002, Math.abs(lx) / imageAspect);
          const ry = Math.max(0.002, Math.abs(ly));
          st.updateMask(d.id!, { radial: { ...m.radial, rx, ry } });
        }
        break;
      }
      case "radial-rotate": {
        const m = st.params.masks.find((mm) => mm.id === d.id);
        if (m?.radial) {
          const qx = (cur.x - m.radial.cx) * imageAspect;
          const qy = cur.y - m.radial.cy;
          const angle = Math.atan2(qy, qx) + Math.PI / 2;
          st.updateMask(d.id!, { radial: { ...m.radial, angle } });
        }
        break;
      }
      case "linear-p0": {
        const m = st.params.masks.find((mm) => mm.id === d.id);
        if (m?.linear) st.updateMask(d.id!, { linear: { ...m.linear, x0: cur.x, y0: cur.y } });
        break;
      }
      case "linear-p1": {
        const m = st.params.masks.find((mm) => mm.id === d.id);
        if (m?.linear) st.updateMask(d.id!, { linear: { ...m.linear, x1: cur.x, y1: cur.y } });
        break;
      }
      case "brush": {
        const last = d.lastDab ?? d.downSrc;
        const dist = Math.hypot((cur.x - last.x) * imageAspect, cur.y - last.y);
        if (dist >= st.brushSize * 0.5) {
          st.addBrushDab(d.id!, { x: cur.x, y: cur.y, radius: st.brushSize, erase: st.brushErase });
          d.lastDab = cur;
        }
        break;
      }
      case "retouch-paint": {
        const last = d.lastDab ?? d.downSrc;
        const dist = Math.hypot((cur.x - last.x) * imageAspect, cur.y - last.y);
        if (dist >= st.retouchSize * 0.5 && d.dabs) {
          d.dabs.push({ x: cur.x, y: cur.y, radius: st.retouchSize, erase: false });
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
        st.updateSpot(d.id!, { srcX: cur.x, srcY: cur.y });
        break;
      }
    }
  };

  const onPointerUp = () => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    const st = store();
    if (d.kind === "create-radial") {
      const m = st.params.masks.find((mm) => mm.id === d.id);
      if (m?.radial && (m.radial.rx < 0.01 || m.radial.ry < 0.01)) {
        st.removeMask(d.id!);
        return;
      }
    }
    if (d.kind === "create-linear") {
      const m = st.params.masks.find((mm) => mm.id === d.id);
      if (m?.linear && Math.hypot(m.linear.x1 - m.linear.x0, m.linear.y1 - m.linear.y0) < 0.01) {
        st.removeMask(d.id!);
        return;
      }
    }
    // A retouch click with no drag (single dab) collapses to a circular spot.
    if (d.kind === "retouch-paint" && d.dabs && d.dabs.length <= 1) {
      st.updateSpot(d.id!, { shape: "circle", dabs: undefined });
    }
    st.commitEdit(activeTool === "retouch" ? "Retouch" : "Mask");
  };

  // --- rendering -------------------------------------------------------------
  const showBrushCursor = activeTool === "mask" && maskToolType === "brush" && cursor;
  const showSpotCursor = activeTool === "retouch" && cursor && !dragRef.current;
  const brushPx = radiusToScreen(useDevelopStore.getState().brushSize);
  const spotPx = radiusToScreen(useDevelopStore.getState().retouchSize);

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
        {/* Masks */}
        {masks.map((m) => {
          const sel = m.id === selectedMaskId;
          const stroke = sel ? "#4aa3ff" : "rgba(255,255,255,0.55)";
          if (m.type === "radial" && m.radial) {
            const c = radialHandle(m, "center");
            const edge = radialHandle(m, "size");
            const rot = radialHandle(m, "rotate");
            return (
              <g key={m.id}>
                <path d={rotatedEllipsePath(m)} fill="none" stroke={stroke} strokeWidth={1.5} />
                {sel && <line x1={c.x} y1={c.y} x2={rot.x} y2={rot.y} stroke="#4aa3ff" strokeWidth={1} opacity={0.6} />}
                {sel && <circle cx={c.x} cy={c.y} r={4} fill="#4aa3ff" />}
                {sel && <circle cx={edge.x} cy={edge.y} r={4} fill="#fff" stroke="#4aa3ff" />}
                {sel && <circle cx={rot.x} cy={rot.y} r={5} fill="#4aa3ff" stroke="#fff" strokeWidth={1.5} />}
              </g>
            );
          }
          if (m.type === "linear" && m.linear) {
            const p0 = toScreen(m.linear.x0, m.linear.y0);
            const p1 = toScreen(m.linear.x1, m.linear.y1);
            const dx = p1.x - p0.x;
            const dy = p1.y - p0.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = (-dy / len) * 400;
            const ny = (dx / len) * 400;
            return (
              <g key={m.id}>
                <line x1={p0.x} y1={p0.y} x2={p1.x} y2={p1.y} stroke={stroke} strokeWidth={1.2} />
                <line x1={p0.x - nx} y1={p0.y - ny} x2={p0.x + nx} y2={p0.y + ny} stroke={stroke} strokeWidth={1.2} strokeDasharray="4 4" />
                <line x1={p1.x - nx} y1={p1.y - ny} x2={p1.x + nx} y2={p1.y + ny} stroke={stroke} strokeWidth={1.2} />
                {sel && <circle cx={p0.x} cy={p0.y} r={4} fill="#fff" stroke="#4aa3ff" />}
                {sel && <circle cx={p1.x} cy={p1.y} r={4} fill="#4aa3ff" />}
              </g>
            );
          }
          return null;
        })}

        {/* Retouch */}
        {spots.map((s) => {
          const src = toScreen(s.srcX, s.srcY);
          const dst = toScreen(s.dstX, s.dstY);
          const r = radiusToScreen(s.radius);
          const sel = s.id === selectedSpotId;
          const col = s.mode === "clone" ? "#ffd24a" : "#4affa3";
          return (
            <g key={s.id}>
              <line x1={src.x} y1={src.y} x2={dst.x} y2={dst.y} stroke={col} strokeWidth={1} strokeDasharray="3 3" opacity={0.7} />
              <circle cx={src.x} cy={src.y} r={r} fill="none" stroke={col} strokeWidth={1} strokeDasharray="2 2" />
              {s.shape === "brush" && s.dabs ? (
                s.dabs.map((db, j) => {
                  const c = toScreen(db.x, db.y);
                  return (
                    <circle key={j} cx={c.x} cy={c.y} r={radiusToScreen(db.radius)} fill="none" stroke={col} strokeWidth={sel ? 1.2 : 0.8} opacity={0.7} />
                  );
                })
              ) : (
                <circle cx={dst.x} cy={dst.y} r={r} fill="none" stroke={col} strokeWidth={sel ? 2 : 1.2} />
              )}
            </g>
          );
        })}

        {/* Tool cursors */}
        {showBrushCursor && (
          <circle cx={cursor!.x} cy={cursor!.y} r={Math.max(3, brushPx)} fill="none" stroke="#fff" strokeWidth={1} opacity={0.7} />
        )}
        {showSpotCursor && (
          <circle cx={cursor!.x} cy={cursor!.y} r={Math.max(3, spotPx)} fill="none" stroke="#4affa3" strokeWidth={1} opacity={0.8} />
        )}
      </svg>
    </div>
  );
}
