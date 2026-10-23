import type { MapData } from '../sim/grid';
import type { Camera } from './camera';

// Static city map in 2.5D: buildings are extruded by their OSM height with an
// oblique projection (roof shifted "up" the screen), drawn back to front.

/** Screen lift per metre of height, in metres of map. */
export const LEAN = 0.32;
const MAX_VISUAL_H = 320;

const ROOF = ['#3b424e', '#464e5b', '#525b69', '#5f6979', '#6e798b'];
const ROOF_BANDS = [20, 45, 90, 180, Infinity];

interface Building {
  pts: Float32Array; // footprint, metres
  lift: number; // roof offset, metres
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  roof: string;
  litWalls: Path2D; // walls facing east-ish
  darkWalls: Path2D;
  roofPath: Path2D;
}

interface StreetLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

function buildBuilding(raw: number[], s: number): Building {
  const h = raw[0];
  const n = (raw.length - 1) >> 1;
  const pts = new Float32Array(n * 2);
  for (let k = 0; k < n * 2; k++) pts[k] = raw[1 + k] * s;
  const lift = Math.min(h, MAX_VISUAL_H) * LEAN;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, area = 0;
  for (let k = 0; k < n; k++) {
    const x = pts[2 * k], y = pts[2 * k + 1];
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    const j = (k + 1) % n;
    area += x * pts[2 * j + 1] - pts[2 * j] * y;
  }
  const sign = area > 0 ? 1 : -1; // screen coords: y down
  const litWalls = new Path2D();
  const darkWalls = new Path2D();
  const roofPath = new Path2D();
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n;
    const ax = pts[2 * k], ay = pts[2 * k + 1], bx = pts[2 * j], by = pts[2 * j + 1];
    // outward normal of edge a->b
    const nx = (by - ay) * sign;
    const ny = -(bx - ax) * sign;
    if (ny > 0) {
      const p = nx > 0 ? litWalls : darkWalls;
      p.moveTo(ax, ay);
      p.lineTo(bx, by);
      p.lineTo(bx, by - lift);
      p.lineTo(ax, ay - lift);
      p.closePath();
    }
    if (k === 0) roofPath.moveTo(ax, ay - lift);
    else roofPath.lineTo(ax, ay - lift);
  }
  roofPath.closePath();
  return { pts, lift, x0, y0: y0 - lift, x1, y1, roof: ROOF[ROOF_BANDS.findIndex((b) => h < b)], litWalls, darkWalls, roofPath };
}

export class MapLayer {
  private buildings: Building[];
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
    this.buildings = map.buildings.map((b) => buildBuilding(b, s));
    // back to front: northern (smaller y) footprints first
    this.buildings.sort((a, b) => a.y1 - b.y1);
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
        if (!prev || len > prev.len) {
          let angle = Math.atan2(y1 - y0, x1 - x0);
          if (angle > Math.PI / 2) angle -= Math.PI;
          if (angle < -Math.PI / 2) angle += Math.PI;
          longest.set(r.n, { name: r.n, x: (x0 + x1) / 2, y: (y0 + y1) / 2, angle, len });
        }
      }
    }
    this.streetLabels = [...longest.values()].filter((l) => l.len > 60);
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    const z = cam.zoom * dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0d1014';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(z, 0, 0, z, dpr * (cam.vw / 2 - cam.x * cam.zoom), dpr * (cam.vh / 2 - cam.y * cam.zoom));

    ctx.fillStyle = '#1a1e24'; // streets and plazas
    ctx.fillRect(0, 0, this.map.width, this.map.height);
    ctx.fillStyle = '#1c3324';
    ctx.fill(this.parks);
    ctx.fillStyle = '#12304a';
    ctx.fill(this.water);
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 0.35;
    ctx.setLineDash([3, 4]);
    ctx.stroke(this.majorRoads);
    ctx.setLineDash([]);

    const [vx0, vy0] = cam.toWorld(0, 0);
    const [vx1, vy1] = cam.toWorld(cam.vw, cam.vh);
    // ambient occlusion at the foot of every visible building
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    const visible = this.buildings.filter((b) => b.x1 >= vx0 && b.x0 <= vx1 && b.y1 >= vy0 && b.y0 <= vy1);
    for (const b of visible) {
      ctx.fillRect(b.x0 - 1.5, b.y1 - 2, b.x1 - b.x0 + 3, 4);
    }
    ctx.lineWidth = 0.6 / cam.zoom;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const b of visible) {
      ctx.fillStyle = '#16191f';
      ctx.fill(b.darkWalls);
      ctx.fillStyle = '#232830';
      ctx.fill(b.litWalls);
      ctx.fillStyle = b.roof;
      ctx.fill(b.roofPath);
      ctx.stroke(b.roofPath);
    }
  }

  drawLabels(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (cam.zoom > 0.9) {
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.fillStyle = 'rgba(200,210,225,0.45)';
      for (const l of this.streetLabels) {
        const [sx, sy] = cam.toScreen(l.x, l.y);
        if (sx < -100 || sy < -20 || sx > cam.vw + 100 || sy > cam.vh + 20) continue;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(l.angle);
        ctx.fillText(l.name, 0, 0);
        ctx.restore();
      }
    }
    ctx.font = '600 12px system-ui, sans-serif';
    for (const l of this.map.labels) {
      const [sx, sy] = cam.toScreen(l.x, l.y);
      if (sx < -100 || sy < -20 || sx > cam.vw + 100 || sy > cam.vh + 20) continue;
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8,10,14,0.85)';
      ctx.strokeText(l.t, sx, sy);
      ctx.fillStyle = 'rgba(235,225,200,0.9)';
      ctx.fillText(l.t, sx, sy);
    }
  }
}
