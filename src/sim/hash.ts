// Uniform bucket grid rebuilt every tick with a counting sort: O(N), no allocs.
export class SpatialHash {
  readonly bw: number;
  readonly bh: number;
  readonly start: Int32Array; // bucket b holds items[start[b] .. start[b+1])
  items: Int32Array;
  private readonly count: Int32Array;

  constructor(widthM: number, heightM: number, readonly size: number, capacity: number) {
    this.bw = Math.ceil(widthM / size);
    this.bh = Math.ceil(heightM / size);
    this.start = new Int32Array(this.bw * this.bh + 1);
    this.count = new Int32Array(this.bw * this.bh);
    this.items = new Int32Array(capacity);
  }

  bucket(x: number, y: number): number {
    const bx = Math.min(this.bw - 1, Math.max(0, Math.floor(x / this.size)));
    const by = Math.min(this.bh - 1, Math.max(0, Math.floor(y / this.size)));
    return by * this.bw + bx;
  }

  /** Indexes agents i < n whose kind bit is set in `mask`. */
  build(xs: Float32Array, ys: Float32Array, kind: Uint8Array, n: number, mask: number): void {
    const { count, start } = this;
    count.fill(0);
    let total = 0;
    for (let i = 0; i < n; i++) {
      if (!((1 << kind[i]) & mask)) continue;
      count[this.bucket(xs[i], ys[i])]++;
      total++;
    }
    if (this.items.length < total) this.items = new Int32Array(total * 2);
    let acc = 0;
    for (let b = 0; b < count.length; b++) {
      start[b] = acc;
      acc += count[b];
      count[b] = start[b];
    }
    start[count.length] = acc;
    for (let i = 0; i < n; i++) {
      if (!((1 << kind[i]) & mask)) continue;
      this.items[count[this.bucket(xs[i], ys[i])]++] = i;
    }
  }

  /** Nearest indexed agent within [rMin, r] accepted by `ok`, or -1. */
  nearest(
    xs: Float32Array,
    ys: Float32Array,
    x: number,
    y: number,
    r: number,
    rMin = 0,
    ok?: (i: number) => boolean,
  ): number {
    const bx = Math.floor(x / this.size);
    const by = Math.floor(y / this.size);
    const rings = Math.ceil(r / this.size);
    let best = -1;
    let bestD = r * r;
    const minD = rMin * rMin;
    for (let ring = 0; ring <= rings; ring++) {
      for (let dy = -ring; dy <= ring; dy++) {
        const yy = by + dy;
        if (yy < 0 || yy >= this.bh) continue;
        const edge = dy === -ring || dy === ring;
        for (let dx = -ring; dx <= ring; dx += edge ? 1 : 2 * ring || 1) {
          const xx = bx + dx;
          if (xx < 0 || xx >= this.bw) continue;
          const b = yy * this.bw + xx;
          for (let k = this.start[b]; k < this.start[b + 1]; k++) {
            const i = this.items[k];
            const d = (xs[i] - x) ** 2 + (ys[i] - y) ** 2;
            if (d < bestD && d >= minD && (!ok || ok(i))) {
              bestD = d;
              best = i;
            }
          }
        }
      }
      // anything in a further ring is at least ring*size away
      if (best >= 0 && bestD <= (ring * this.size) ** 2) break;
    }
    return best;
  }

  /** Calls fn for every indexed agent within r of (x, y). */
  forEachInRadius(xs: Float32Array, ys: Float32Array, x: number, y: number, r: number, fn: (i: number) => void): void {
    const b0x = Math.max(0, Math.floor((x - r) / this.size));
    const b1x = Math.min(this.bw - 1, Math.floor((x + r) / this.size));
    const b0y = Math.max(0, Math.floor((y - r) / this.size));
    const b1y = Math.min(this.bh - 1, Math.floor((y + r) / this.size));
    const r2 = r * r;
    for (let by = b0y; by <= b1y; by++) {
      for (let bx = b0x; bx <= b1x; bx++) {
        const b = by * this.bw + bx;
        for (let k = this.start[b]; k < this.start[b + 1]; k++) {
          const i = this.items[k];
          if ((xs[i] - x) ** 2 + (ys[i] - y) ** 2 <= r2) fn(i);
        }
      }
    }
  }

  countInRadius(xs: Float32Array, ys: Float32Array, x: number, y: number, r: number): number {
    let n = 0;
    this.forEachInRadius(xs, ys, x, y, r, () => n++);
    return n;
  }
}
