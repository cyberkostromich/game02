import type { MapData } from '../sim/grid';
import type { Camera } from './camera';

// Static city map in 2.5D: buildings are extruded by their OSM height with an
// oblique projection (roof shifted up the screen) and drawn back to front.
// Each building gets its own tint and an outline so neighbours read apart;
// sidewalks, sun shadows, park trees and avenue markings give the ground depth.

/** Screen lift per metre of height, in metres of map. */
export const LEAN = 0.42;
export const MAX_VISUAL_H = 300;
const SUN: [number, number] = [0.5, 0.36]; // ground shadow offset per metre of height (world, fixed)
const CHUNK = 250; // m, shadow batching

const STREET = '#2a2d33';
const SIDEWALK = '#3b3f46';
const OUTSIDE = '#121418';
const PARK = '#46703c';
const TREE = '#355c2e';
const TREE_LIT = '#4f8443';
const WATER = '#2b6aa3';

interface Footprint {
  pts: Float32Array; // metres
  h: number;
  sign: number; // polygon orientation
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  roof: string;
  lit: string;
  dark: string;
}

/** Paths for one view angle (walls depend on which side faces the viewer). */
interface View {
  order: Footprint[];
  paths: Map<Footprint, { lit: Path2D; dark: Path2D; roof: Path2D }>;
}

interface StreetLabel {
  name: string;
  x: number;
  y: number;
  angle: number;
}

/** Deterministic 0..1 noise from an integer. */
function hash01(i: number): number {
  let x = (i * 2654435761) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 2246822519) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4294967296;
}

/** Sand / stone / brick palette; taller towers lean to pale stone and glass. */
function tints(i: number, h: number): { roof: string; lit: string; dark: string } {
  const r = hash01(i);
  const tall = Math.min(1, h / 150);
  const glass = tall > 0.5 && hash01(i + 7) > 0.6; // some towers are blue-grey glass
  const hue = glass ? 205 + r * 15 : r < 0.25 ? 14 + r * 40 : 30 + r * 14; // brick reds .. sandstone
  const sat = glass ? 14 : (hash01(i + 3) * 20 + 14) * (1 - tall * 0.4);
  const light = 56 + hash01(i + 5) * 16 + tall * 8;
  return {
    roof: `hsl(${hue.toFixed(0)} ${sat.toFixed(0)}% ${light.toFixed(0)}%)`,
    lit: `hsl(${hue.toFixed(0)} ${(sat * 0.8).toFixed(0)}% ${(light - 18).toFixed(0)}%)`,
    dark: `hsl(${hue.toFixed(0)} ${(sat * 0.7).toFixed(0)}% ${(light - 30).toFixed(0)}%)`,
  };
}

export class MapLayer {
  private foot: Footprint[];
  private views = new Map<number, View>(); // by view angle
  private parks = new Path2D();
  private trees = new Path2D();
  private treeLight = new Path2D();
  private water = new Path2D();
  private majorRoads = new Path2D();
  private sidewalks = new Path2D();
  private shadows = new Map<string, Path2D>(); // chunk -> union of building shadows
  private streetLabels: StreetLabel[] = [];

  constructor(readonly map: MapData) {
    const s = 1 / map.q;
    const poly = (target: Path2D, pts: number[]) => {
      target.moveTo(pts[0] * s, pts[1] * s);
      for (let k = 2; k < pts.length; k += 2) target.lineTo(pts[k] * s, pts[k + 1] * s);
      target.closePath();
    };
    this.foot = map.buildings.map((raw, i) => {
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
      return { pts, h, sign: area > 0 ? 1 : -1, x0, y0, x1, y1, ...tints(i, raw[0]) };
    });
    for (const f of this.foot) this.addFootprint(this.sidewalks, f, 0, 0);
    for (const f of this.foot) this.addShadow(f);
    for (const p of map.parks) {
      poly(this.parks, p);
      this.plantTrees(p, s);
    }
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

  private addFootprint(p: Path2D, f: Footprint, dx: number, dy: number): void {
    const n = f.pts.length >> 1;
    p.moveTo(f.pts[0] + dx, f.pts[1] + dy);
    for (let k = 1; k < n; k++) p.lineTo(f.pts[2 * k] + dx, f.pts[2 * k + 1] + dy);
    p.closePath();
  }

  /** Ground shadow = footprint swept along the sun direction, batched per chunk. */
  private addShadow(f: Footprint): void {
    const key = `${Math.floor(f.x0 / CHUNK)},${Math.floor(f.y0 / CHUNK)}`;
    let p = this.shadows.get(key);
    if (!p) this.shadows.set(key, (p = new Path2D()));
    const sx = SUN[0] * f.h;
    const sy = SUN[1] * f.h;
    const n = f.pts.length >> 1;
    for (let k = 0; k < n; k++) {
      // every edge swept; nonzero fill unions the quads; winding forced consistent
      const j = (k + 1) % n;
      const ax = f.pts[2 * k], ay = f.pts[2 * k + 1], bx = f.pts[2 * j], by = f.pts[2 * j + 1];
      const cross = (bx - ax) * sy - (by - ay) * sx;
      if (cross >= 0) {
        p.moveTo(ax, ay); p.lineTo(bx, by); p.lineTo(bx + sx, by + sy); p.lineTo(ax + sx, ay + sy);
      } else {
        p.moveTo(ax, ay); p.lineTo(ax + sx, ay + sy); p.lineTo(bx + sx, by + sy); p.lineTo(bx, by);
      }
      p.closePath();
    }
    if (f.sign > 0) this.addFootprint(p, f, sx, sy);
    else {
      p.moveTo(f.pts[0] + sx, f.pts[1] + sy);
      for (let k = n - 1; k >= 1; k--) p.lineTo(f.pts[2 * k] + sx, f.pts[2 * k + 1] + sy);
      p.closePath();
    }
  }

  private plantTrees(pts: number[], s: number): void {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < pts.length; k += 2) {
      x0 = Math.min(x0, pts[k] * s); x1 = Math.max(x1, pts[k] * s);
      y0 = Math.min(y0, pts[k + 1] * s); y1 = Math.max(y1, pts[k + 1] * s);
    }
    const inside = (x: number, y: number) => {
      let c = false;
      for (let k = 0, j = pts.length - 2; k < pts.length; j = k, k += 2) {
        const xi = pts[k] * s, yi = pts[k + 1] * s, xj = pts[j] * s, yj = pts[j + 1] * s;
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
      }
      return c;
    };
    const count = Math.min(400, ((x1 - x0) * (y1 - y0)) / 70);
    for (let k = 0; k < count; k++) {
      const x = x0 + hash01(k * 13 + Math.round(x0)) * (x1 - x0);
      const y = y0 + hash01(k * 29 + Math.round(y0)) * (y1 - y0);
      if (!inside(x, y)) continue;
      const r = 2 + hash01(k + Math.round(x1)) * 2.2;
      this.trees.moveTo(x + r, y);
      this.trees.arc(x, y, r, 0, Math.PI * 2);
      this.treeLight.moveTo(x - r * 0.25 + r * 0.45, y - r * 0.3);
      this.treeLight.arc(x - r * 0.25, y - r * 0.3, r * 0.45, 0, Math.PI * 2);
    }
  }

  private view(cam: Camera): View {
    const cached = this.views.get(cam.deg);
    if (cached) return cached;
    if (this.views.size > 8) this.views.clear();
    const [dx, dy] = cam.down(); // world direction facing the viewer
    const paths = new Map<Footprint, { lit: Path2D; dark: Path2D; roof: Path2D }>();
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
          // light comes from the screen's left: walls facing right are in shade
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
      paths.set(f, { lit, dark, roof });
      key.set(f, front);
    }
    const order = [...this.foot].sort((a, b) => key.get(a)! - key.get(b)!);
    const v = { order, paths };
    this.views.set(cam.deg, v);
    return v;
  }

  draw(ctx: CanvasRenderingContext2D, cam: Camera, dpr: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = OUTSIDE;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(...cam.matrix(dpr));
    const px = 1 / cam.zoom; // one CSS pixel in metres

    const W = this.map.width;
    const H = this.map.height;
    ctx.fillStyle = STREET;
    ctx.fillRect(0, 0, W, H);
    ctx.lineJoin = 'round';
    ctx.strokeStyle = SIDEWALK;
    ctx.lineWidth = 7;
    ctx.stroke(this.sidewalks);
    ctx.fillStyle = PARK;
    ctx.fill(this.parks);
    ctx.fillStyle = WATER;
    ctx.fill(this.water);
    if (cam.zoom > 0.5) {
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(240,200,90,0.22)';
      ctx.lineWidth = Math.max(0.4, px);
      ctx.stroke(this.majorRoads);
      ctx.setLineDash([]);
    }

    // visible world rectangle plus room for tall roofs and shadows
    const corners = [cam.toWorld(0, 0), cam.toWorld(cam.vw, 0), cam.toWorld(0, cam.vh), cam.toWorld(cam.vw, cam.vh)];
    const pad = MAX_VISUAL_H * LEAN;
    const vx0 = Math.min(...corners.map((c) => c[0])) - pad;
    const vx1 = Math.max(...corners.map((c) => c[0])) + pad;
    const vy0 = Math.min(...corners.map((c) => c[1])) - pad;
    const vy1 = Math.max(...corners.map((c) => c[1])) + pad;

    ctx.fillStyle = 'rgba(8,10,14,0.38)';
    for (let cy = Math.floor((vy0 - pad) / CHUNK); cy <= Math.floor(vy1 / CHUNK); cy++)
      for (let cx = Math.floor((vx0 - pad) / CHUNK); cx <= Math.floor(vx1 / CHUNK); cx++) {
        const p = this.shadows.get(`${cx},${cy}`);
        if (p) ctx.fill(p, 'nonzero');
      }

    ctx.fillStyle = TREE;
    ctx.fill(this.trees);
    ctx.fillStyle = TREE_LIT;
    ctx.fill(this.treeLight);

    const v = this.view(cam);
    ctx.lineWidth = Math.max(0.35, 0.9 * px);
    ctx.strokeStyle = 'rgba(35,26,14,0.75)';
    for (const f of v.order) {
      if (f.x1 < vx0 || f.x0 > vx1 || f.y1 < vy0 || f.y0 > vy1) continue;
      const p = v.paths.get(f)!;
      ctx.fillStyle = f.dark;
      ctx.fill(p.dark);
      ctx.fillStyle = f.lit;
      ctx.fill(p.lit);
      ctx.fillStyle = f.roof;
      ctx.fill(p.roof);
      ctx.stroke(p.roof);
    }

    // darken everything outside the playable rectangle
    ctx.fillStyle = 'rgba(10,12,16,0.6)';
    const big = 6000;
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
      for (const l of this.streetLabels) {
        const [sx, sy] = cam.toScreen(l.x, l.y);
        if (sx < -100 || sy < -20 || sx > cam.vw + 100 || sy > cam.vh + 20) continue;
        let a = l.angle + cam.angle;
        while (a > Math.PI / 2) a -= Math.PI;
        while (a < -Math.PI / 2) a += Math.PI;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a);
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(20,22,28,0.8)';
        ctx.strokeText(l.name, 0, 0);
        ctx.fillStyle = 'rgba(225,230,240,0.75)';
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
