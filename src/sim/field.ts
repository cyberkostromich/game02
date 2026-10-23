import { Grid } from './grid';

// Multi-source distance field on the walk grid (Dial's bucket queue).
// Costs: orthogonal step 2, diagonal 3 (≈ Euclid ×2). Values are in half-cells.
export const INF = 0xffff;
const ORTH = 2;
const DIAG = 3;

export interface FieldOptions {
  /** stop expanding beyond this distance (half-cells) */
  cap?: number;
  /** extra cost to enter a barricaded cell; undefined = barricades are free */
  barricadeCost?: number;
  /**
   * Early exit: stop once every cell with targets[c] > 0 is settled. Cells the
   * targets would descend into are always settled first, so gradients stay exact.
   */
  targets?: Uint16Array;
}

export class FieldSolver {
  private head: Int32Array;
  private entryCell: Int32Array;
  private entryNext: Int32Array;
  private used = 0;
  private readonly nb: Int32Array;
  private readonly diag: Uint8Array;

  constructor(private readonly grid: Grid) {
    const w = grid.w;
    this.head = new Int32Array(64);
    this.entryCell = new Int32Array(grid.w * grid.h);
    this.entryNext = new Int32Array(grid.w * grid.h);
    this.nb = Int32Array.from([-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1]);
    this.diag = Uint8Array.from([0, 0, 0, 0, 1, 1, 1, 1]);
  }

  private push(bucket: number, cell: number): void {
    if (this.used >= this.entryCell.length) {
      const n = this.entryCell.length * 2;
      const c = new Int32Array(n);
      c.set(this.entryCell);
      const x = new Int32Array(n);
      x.set(this.entryNext);
      this.entryCell = c;
      this.entryNext = x;
    }
    const e = this.used++;
    this.entryCell[e] = cell;
    this.entryNext[e] = this.head[bucket];
    this.head[bucket] = e;
  }

  /** Fills `out` with distances from the given source cells. */
  solve(sources: ArrayLike<number>, nSources: number, out: Uint16Array, opt: FieldOptions = {}): void {
    const { grid, nb, diag } = this;
    const solid = grid.solid;
    const bar = grid.barricade;
    const w = grid.w;
    const cap = Math.min(opt.cap ?? INF - 1, INF - 1);
    const bc = opt.barricadeCost;
    const maxEdge = DIAG + (bc ?? 0);
    const nBuckets = maxEdge + 1;
    if (this.head.length < nBuckets) this.head = new Int32Array(nBuckets);
    this.head.fill(-1, 0, nBuckets);
    this.used = 0;
    out.fill(INF);

    let left = -1;
    const targets = opt.targets;
    if (targets) {
      left = 0;
      for (let c = 0; c < targets.length; c++) if (targets[c] > 0) left++;
    }
    let pending = 0;
    for (let k = 0; k < nSources; k++) {
      const c = sources[k];
      if (solid[c] !== 0 || out[c] === 0) continue;
      out[c] = 0;
      this.push(0, c);
      pending++;
    }
    let d = 0;
    while (pending > 0) {
      const b = d % nBuckets;
      let e = this.head[b];
      this.head[b] = -1;
      while (e !== -1) {
        const c = this.entryCell[e];
        e = this.entryNext[e];
        pending--;
        if (out[c] !== d) continue; // stale entry
        if (targets && targets[c] > 0 && --left === 0) {
          pending = 0;
          break;
        }
        for (let k = 0; k < 8; k++) {
          const n = c + nb[k];
          if (solid[n] !== 0) continue;
          let cost = ORTH;
          if (diag[k]) {
            // no corner cutting through walls
            const dx = (n % w) - (c % w);
            const dy = n > c ? w : -w;
            if (solid[c + dx] !== 0 || solid[c + dy] !== 0) continue;
            if (bc !== undefined && (bar[c + dx] > 0 || bar[c + dy] > 0)) continue;
            cost = DIAG;
          }
          if (bc !== undefined && bar[n] > 0) cost += bc;
          const nd = d + cost;
          if (nd > cap || nd >= out[n]) continue;
          out[n] = nd;
          this.push(nd % nBuckets, n);
          pending++;
        }
      }
      d++;
    }
  }
}
