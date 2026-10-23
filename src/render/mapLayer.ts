import type { MapData } from '../sim/grid';
import type { Camera } from './camera';

// Static city map in 2.5D: buildings are extruded by their OSM height with an
// oblique projection (roof shifted up the screen) and drawn back to front.
// Palette: sand-coloured blocks on charcoal streets, blue water, green parks.

/** Screen lift per metre of height, in metres of map. */
export const LEAN = 0.32;
const MAX_VISUAL_H = 320;

const ROOF = ['#bdae8c', '#c5b695', '#cdbf9e', '#d5c8a8', '#ddd1b3'];
const ROOF_BANDS = [20, 45, 90, 180, Infinity];
const WALL_LIT = '#968866';
const WALL_DARK = '#6e6450';
const STREET = '#2c2f34';
const OUTSIDE = '#16181c';
const PARK = '#4a7840';
const WATER = '#2b6aa3';

interface Footprint {
  pts: Float32Array; // metres
  h: number;
  roof: string;
  sign: number; // polygon orientation
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Paths for one view rotation (walls depend on which side faces the viewer). */
interface View {
  order: Footprint[];
  walls: Map<Footprint, { lit: Path2D; dark: Path2D; roof: Path2D }>;
}

interface StreetLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

export class MapLayer {
  private foot: Footprint[];
  private views: (View | null)[] = [null, null, null, null];
  private parks = new Path2D();
  private water = new Path2D();
  private majorRoads = new Path2D();
  private streetLabels: StreetLabel[] = [];

  constructor(readonly map: MapData) {
    const s = 1 / map.q;
    const poly = (target: Path2D, pts: number[]) => {
      target.moveTo(pts[0] * s, pts[1] * s);
      for (let k = 2; k < pts.length; k += 2) target.lineTo(pts[k] * s, pts[k + 1] * s);
      target.closePath();
    };
    this.foot = map.buildings.map((raw) => {
      const n = (raw.length - 1) >> 1;
      const pts = new Float32Array(n * 2);
      for (let k = 0; k < n * 2; k++) pts[k] = raw[1 + k] * s;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
      for (let k = 0; k < n; k++) {
        const x = pts[2 * k], y = pts[2 * k + 1];
        x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        const j = (k + 1) % n;
        area += x * pts[2 * j + 1] - pts[2 * j] * y;
      }
      const h = Math.min(raw[0], MAX_VISUAL_H);
      return { pts, h, roof: ROOF[ROOF_BANDS.findIndex((b) => raw[0] < b)], sign: area > 0 ? 1 : -1, x0, y0, x1, y1 };
    });
    for (const p of map.parks) poly(this.parks, p);
    for (const p of map.water) poly(this.water, p);

    const longest = new Map<string, StreetLabel & { len: number }>();
    for (const r of map.roads) {
      if (r.c >= 2) {
        this.majorRoads.moveTo(r.p[0] * s, r.p[1] * s);
        for (let k = 2; k < r.p.length; k += 2) this.majorRoads.lineTo(r.p[k] * s, r.p[k + 1] * s);
      }
      if (!r.n || r.c < 1) continue;
      for (let k = 2; k < r.p.length; k += 2) {
        const x0 = r.p[k - 2] * s, y0 = r.p[k - 1] * s, x1 = r.p[k] * s, y1 = r.p[k + 1] * s;
        const len = Math.hypot(x1 - x0, y1 - y0);
        const prev = longest.get(r.n);
        if (!prev || len > prev.len) longest.set(r.n, { name: r.n, x: (x0 + x1) / 2, y: (y0 + y1) / 2, angle: Math.atan2(y1 - y0, x1 - x0), len });
      }
    }
    this.streetLabels = [...longest.values()].filter((l) => l.len > 60);
  }

  private view(cam: Camera): View {
    const cached = this.views[cam.rot];
    if (cached) return cached;
    const [dx, dy] = cam.down(); // world direction facing the viewer
    const walls = new Map<Footprint, { lit: Path2D; dark: Path2D; roof: Path2D }>();
    const key = new Map<Footprint, number>();
    for (const f of this.foot) {
      const n = f.pts.length >> 1;
      const lx = -dx * f.h * LEAN; // roof shift: up the screen
      const ly = -dy * f.h * LEAN;
      const lit = new Path2D();
      const dark = new Path2D();
      const roof = new Path2D();
      let front = -Infinity;
      for (let k = 0; k < n; k++) {
        const j = (k + 1) % n;
        const ax = f.pts[2 * k], ay = f.pts[2 * k + 1], bx = f.pts[2 * j], by = f.pts[2 * j + 1];
        front = Math.max(front, ax * dx + ay * dy);
        const nx = (by - ay) * f.sign; // outward normal
        const ny = -(bx - ax) * f.sign;
        if (nx * dx + ny * dy > 0) {
          // light comes from the screen's left: walls facing right are lit
          const p = nx * dy - ny * dx < 0 ? lit : dark;
          p.moveTo(ax, ay);
          p.lineTo(bx, by);
          p.lineTo(bx + lx, by + ly);
          p.lineTo(ax + lx, ay + ly);
          p.closePath();
        }
        if (k === 0) roof.moveTo(ax + lx, ay + ly);
        else roof.lineTo(ax + lx, ay + ly);
      }
      roof.closePath();
      walls.set(f, { lit, dark, roof });
      key.set(f, front);
    }
    const order = [...this.foot].sort((a, b) => key.get(a)! - key.get(b)!);
    return (this.views[cam.rot] = { order, walls });
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(...cam.matrix(dpr));

    const W = this.map.width;
    const H = this.map.height;
    ctx.fillStyle = STREET;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = PARK;
    ctx.fill(this.parks);
    ctx.fillStyle = WATER;
    ctx.fill(this.water);
    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 10;
    ctx.stroke(this.majorRoads);

    // visible world rectangle (rotation-agnostic) plus room for tall roofs
    const corners = [cam.toWorld(0, 0), cam.toWorld(cam.vw, 0), cam.toWorld(0, cam.vh), cam.toWorld(cam.vw, cam.vh)];
    const pad = MAX_VISUAL_H * LEAN;
    const vx0 = Math.min(...corners.map((c) => c[0])) - pad;
    const vx1 = Math.max(...corners.map((c) => c[0])) + pad;
    const vy0 = Math.min(...corners.map((c) => c[1])) - pad;
    const vy1 = Math.max(...corners.map((c) => c[1])) + pad;
    const v = this.view(cam);
    ctx.lineWidth = 0.5 / cam.zoom;
    ctx.strokeStyle = 'rgba(40,30,15,0.35)';
    for (const f of v.order) {
      if (f.x1 < vx0 || f.x0 > vx1 || f.y1 < vy0 || f.y0 > vy1) continue;
      const p = v.walls.get(f)!;
      ctx.fillStyle = WALL_DARK;
      ctx.fill(p.dark);
      ctx.fillStyle = WALL_LIT;
      ctx.fill(p.lit);
      ctx.fillStyle = f.roof;
      ctx.fill(p.roof);
      ctx.stroke(p.roof);
    }

    // darken everything outside the playable rectangle
    ctx.fillStyle = 'rgba(10,12,16,0.55)';
    const big = 4000;
    ctx.fillRect(-big, -big, W + 2 * big, big);
    ctx.fillRect(-big, H, W + 2 * big, big);
    ctx.fillRect(-big, 0, big, H);
    ctx.fillRect(W, 0, big, H);
  }

  drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (cam.zoom > 0.9) {
      ctx.font = '500 11px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillStyle = 'rgba(225,230,240,0.55)';
      for (const l of this.streetLabels) {
        const [sx, sy] = cam.toScreen(l.x, l.y);
        if (sx < -100 || sy < -20 || sx > cam.vw + 100 || sy > cam.vh + 20) continue;
        let a = l.angle + cam.angle;
        while (a > Math.PI / 2) a -= Math.PI;
        while (a < -Math.PI / 2) a += Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a);
        ctx.fillText(l.name, 0, 0);
        ctx.restore();
      }
    }
    ctx.font = '600 12px "IBM Plex Mono", ui-monospace, monospace';
    for (const l of this.map.labels) {
      const [sx, sy] = cam.toScreen(l.x, l.y);
      if (sx < -100 || sy < -20 || sx > cam.vw + 100 || sy > cam.vh + 20) continue;
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = 'rgba(15,18,26,0.9)';
      ctx.strokeText(l.t, sx, sy);
      ctx.fillStyle = '#f4ead2';
      ctx.fillText(l.t, sx, sy);
    }
  }
}
