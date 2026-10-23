// Walkability grid rasterised from map polygons. Everything that is not a
// building or water is walkable; unreachable pockets (closed courtyards) are
// sealed so agents never spawn or get stuck there.

export interface MapData {
  name: string;
  attribution: string;
  width: number;
  height: number;
  q: number;
  buildings: number[][]; // [height, x0, y0, x1, y1, ...] in 1/q m
  parks: number[][];
  water: number[][];
  /** rivers as a run-length mask: alternating land/water runs, row-major */
  waterMask?: { cell: number; w: number; h: number; rle: number[] };
  roads: { c: number; n: string; p: number[] }[];
  labels: { t: string; x: number; y: number }[];
}

/** Calls fn(x0, x1, y0, y1) in metres for every horizontal run of river cells. */
export function forEachWaterRun(map: MapData, fn: (x0: number, x1: number, y0: number, y1: number) => void): void {
  const m = map.waterMask;
  if (!m) return;
  let i = 0;
  let water = false;
  for (const len of m.rle) {
    if (water) {
      let k = i;
      const end = i + len;
      while (k < end) {
        const y = Math.floor(k / m.w);
        const rowEnd = Math.min(end, (y + 1) * m.w);
        fn((k % m.w) * m.cell, ((rowEnd - 1) % m.w + 1) * m.cell, y * m.cell, (y + 1) * m.cell);
        k = rowEnd;
      }
    }
    i += len;
    water = !water;
  }
}

export const OPEN = 0;
export const BUILDING = 1;
export const SOLID = 2; // water, map edge

export class Grid {
  readonly w: number;
  readonly h: number;
  readonly cell: number;
  /** OPEN / BUILDING / SOLID */
  readonly solid: Uint8Array;
  /** barricade hit points per cell, 0 = none */
  readonly barricade: Float32Array;
  /** building height per cell, m */
  readonly height: Uint16Array;

  constructor(widthM: number, heightM: number, cell: number) {
    this.cell = cell;
    this.w = Math.ceil(widthM / cell);
    this.h = Math.ceil(heightM / cell);
    this.solid = new Uint8Array(this.w * this.h);
    this.barricade = new Float32Array(this.w * this.h);
    this.height = new Uint16Array(this.w * this.h);
  }

  idx(x: number, y: number): number {
    const cx = Math.min(this.w - 1, Math.max(0, Math.floor(x / this.cell)));
    const cy = Math.min(this.h - 1, Math.max(0, Math.floor(y / this.cell)));
    return cy * this.w + cx;
  }
  cx(i: number): number {
    return ((i % this.w) + 0.5) * this.cell;
  }
  cy(i: number): number {
    return (Math.floor(i / this.w) + 0.5) * this.cell;
  }
  open(i: number): boolean {
    return this.solid[i] === OPEN;
  }
  /** open for zombies: no wall and no standing barricade */
  passable(i: number): boolean {
    return this.solid[i] === OPEN && this.barricade[i] <= 0;
  }

  /** Nearest open cell centre to (x, y) by expanding square rings. */
  nearestOpen(x: number, y: number): { x: number; y: number } {
    const c0 = this.idx(x, y);
    const cx = c0 % this.w;
    const cy = Math.floor(c0 / this.w);
    for (let r = 0; r < Math.max(this.w, this.h); r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const xx = cx + dx;
          const yy = cy + dy;
          if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
          const i = yy * this.w + xx;
          if (this.solid[i] === OPEN) return { x: this.cx(i), y: this.cy(i) };
        }
    return { x, y };
  }

  /** Even-odd scanline fill of a polygon given in metres (flat x,y list). */
  fillPolygon(pts: ArrayLike<number>, value: number, offset = 0, scale = 1, height = 15): void {
    const n = (pts.length - offset) >> 1;
    if (n < 3) return;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < n; k++) {
      const y = pts[offset + 2 * k + 1] * scale;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    const r0 = Math.max(0, Math.floor(minY / this.cell - 0.5));
    const r1 = Math.min(this.h - 1, Math.ceil(maxY / this.cell));
    const xs: number[] = [];
    for (let r = r0; r <= r1; r++) {
      const yc = (r + 0.5) * this.cell;
      xs.length = 0;
      for (let k = 0, j = n - 1; k < n; j = k++) {
        const xi = pts[offset + 2 * k] * scale;
        const yi = pts[offset + 2 * k + 1] * scale;
        const xj = pts[offset + 2 * j] * scale;
        const yj = pts[offset + 2 * j + 1] * scale;
        if (yi > yc !== yj > yc) xs.push(xi + ((yc - yi) * (xj - xi)) / (yj - yi));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] / this.cell - 0.5));
        const c1 = Math.min(this.w - 1, Math.floor(xs[k + 1] / this.cell - 0.5));
        for (let c = c0; c <= c1; c++) {
          const i = r * this.w + c;
          this.solid[i] = value;
          if (height > this.height[i]) this.height[i] = height;
        }
      }
    }
  }

  /** Map edge becomes SOLID, then every open cell not connected to `seed` too. */
  sealUnreachable(seedX: number, seedY: number): void {
    const { w, h, solid } = this;
    for (let x = 0; x < w; x++) solid[x] = solid[(h - 1) * w + x] = SOLID;
    for (let y = 0; y < h; y++) solid[y * w] = solid[y * w + w - 1] = SOLID;
    let seed = this.idx(seedX, seedY);
    // nearest open cell to the requested seed
    for (let r = 0; solid[seed] !== OPEN && r < Math.max(w, h); r++) {
      const sc = seed % w;
      const sr = Math.floor(seed / w);
      for (let d = -r; d <= r && solid[seed] !== OPEN; d++) {
        for (const [c, rr] of [[sc + d, sr - r], [sc + d, sr + r], [sc - r, sr + d], [sc + r, sr + d]]) {
          if (c >= 0 && rr >= 0 && c < w && rr < h && solid[rr * w + c] === OPEN) {
            seed = rr * w + c;
            break;
          }
        }
      }
    }
    const seen = new Uint8Array(w * h);
    const stack = [seed];
    seen[seed] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (!seen[j] && solid[j] === OPEN) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    for (let i = 0; i < w * h; i++)
      if (solid[i] === OPEN && !seen[i]) {
        solid[i] = BUILDING; // closed courtyard: as tall as its walls, roughly
        this.height[i] = Math.max(this.height[i - 1], this.height[i + 1], this.height[i - w], this.height[i + w], 10);
      }
  }

  static fromMap(map: MapData, cell: number): Grid {
    const g = new Grid(map.width, map.height, cell);
    const s = 1 / map.q;
    for (const b of map.buildings) g.fillPolygon(b, BUILDING, 1, s, b[0]);
    for (const p of map.water) g.fillPolygon(p, SOLID, 0, s);
    forEachWaterRun(map, (x0, x1, y0, y1) => {
      for (let y = Math.floor(y0 / cell); y < Math.ceil(y1 / cell) && y < g.h; y++)
        for (let x = Math.floor(x0 / cell); x < Math.ceil(x1 / cell) && x < g.w; x++) g.solid[y * g.w + x] = SOLID;
    });
    g.sealUnreachable(map.width / 2, map.height / 2);
    return g;
  }
}
