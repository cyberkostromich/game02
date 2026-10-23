import type { Camera } from './render/camera';

// Pointer gestures on the map: tap, one-finger pan, two-finger pinch, wheel zoom,
// and "line" drags when the active tool needs a direction (barricade, airstrike).
export interface InputHandlers {
  wantsLine(): boolean;
  tap(wx: number, wy: number, sx: number, sy: number): void;
  line(x0: number, y0: number, x1: number, y1: number, done: boolean): void;
  hover(wx: number, wy: number): void;
  cameraMoved(): void;
}

const TAP_SLOP = 8;

export function attachInput(el: HTMLElement, cam: Camera, h: InputHandlers): void {
  const pts = new Map<number, { x: number; y: number }>();
  let mode: 'none' | 'tap' | 'pan' | 'line' | 'pinch' = 'none';
  let start = { x: 0, y: 0 };
  let lineStart = { x: 0, y: 0 };
  let pinch = { d: 1, cx: 0, cy: 0 };

  const local = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const pinchState = () => {
    const [a, b] = [...pts.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  };

  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId);
    const p = local(e);
    pts.set(e.pointerId, p);
    if (pts.size === 2) {
      if (mode === 'line') h.line(lineStart.x, lineStart.y, lineStart.x, lineStart.y, false);
      mode = 'pinch';
      pinch = pinchState();
      return;
    }
    if (pts.size > 2) return;
    start = p;
    if (h.wantsLine() && e.button === 0) {
      mode = 'line';
      const [wx, wy] = cam.toWorld(p.x, p.y);
      lineStart = { x: wx, y: wy };
      h.line(wx, wy, wx, wy, false);
    } else mode = 'tap';
  });

  el.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (!pts.has(e.pointerId)) {
      const [wx, wy] = cam.toWorld(p.x, p.y);
      h.hover(wx, wy);
      return;
    }
    const prev = pts.get(e.pointerId)!;
    pts.set(e.pointerId, p);
    if (mode === 'pinch' && pts.size === 2) {
      const now = pinchState();
      cam.x -= (now.cx - pinch.cx) / cam.zoom;
      cam.y -= (now.cy - pinch.cy) / cam.zoom;
      cam.zoomAt(now.cx, now.cy, now.d / pinch.d);
      pinch = now;
      h.cameraMoved();
    } else if (mode === 'line') {
      const [wx, wy] = cam.toWorld(p.x, p.y);
      h.line(lineStart.x, lineStart.y, wx, wy, false);
    } else if (mode === 'tap' || mode === 'pan') {
      if (mode === 'tap' && Math.hypot(p.x - start.x, p.y - start.y) > TAP_SLOP) mode = 'pan';
      if (mode === 'pan') {
        cam.x -= (p.x - prev.x) / cam.zoom;
        cam.y -= (p.y - prev.y) / cam.zoom;
        h.cameraMoved();
      }
    }
  });

  const end = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    const p = local(e);
    pts.delete(e.pointerId);
    if (mode === 'tap' && e.type === 'pointerup') {
      const [wx, wy] = cam.toWorld(p.x, p.y);
      h.tap(wx, wy, p.x, p.y);
    } else if (mode === 'line' && e.type === 'pointerup') {
      const [wx, wy] = cam.toWorld(p.x, p.y);
      h.line(lineStart.x, lineStart.y, wx, wy, true);
    }
    if (pts.size === 0) mode = 'none';
    else if (mode === 'pinch') mode = 'pan';
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const p = { x: e.offsetX, y: e.offsetY };
      cam.zoomAt(p.x, p.y, Math.exp(-e.deltaY * 0.0015));
      h.cameraMoved();
    },
    { passive: false },
  );
}
