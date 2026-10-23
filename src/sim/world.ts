import { CFG, type UnitType, type Upgrades } from '../config';
import { FieldSolver, INF } from './field';
import { BUILDING, Grid, OPEN } from './grid';
import { SpatialHash } from './hash';
import { Rng } from './rng';
import { updateRecruits } from './support';
import { IN_BUILDING, updateUnits, type Effect, type Strike, type Shell, type Unit } from './units';

// Agent kinds
export const FREE = 0;
export const CIV = 1;
export const INFECTED = 2; // bitten, still looks and acts human until it turns
export const ZOMBIE = 3;
export const RECRUIT = 4; // civilian armed by a barracks

export type Phase = 'planning' | 'battle' | 'won' | 'lost';

export interface Stats {
  population: number;
  evacuated: number;
  infected: number; // total ever bitten
  friendlyFire: number; // civilians killed by our own fire
  zombiesKilled: number;
  cured: number;
  recruited: number;
}

export interface Mods {
  sniperRange: number;
  turretRate: number;
  mortarBlast: number;
  evacRate: number;
  airstrikeWidth: number;
}

export function modsFrom(up: Upgrades): Mods {
  const u = CFG.upgrades;
  return {
    sniperRange: 1 + (up.sniperRange ?? 0) * u.sniperRange.step,
    turretRate: 1 + (up.turretRate ?? 0) * u.turretRate.step,
    mortarBlast: 1 + (up.mortarBlast ?? 0) * u.mortarBlast.step,
    evacRate: 1 + (up.evacRate ?? 0) * u.evacRate.step,
    airstrikeWidth: 1 + (up.airstrikeWidth ?? 0) * u.airstrikeWidth.step,
  };
}

export class World {
  readonly rng: Rng;
  readonly grid: Grid;
  readonly widthM: number;
  readonly heightM: number;
  readonly cap: number;
  n = 0; // high-water mark of used agent slots

  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly px: Float32Array; // previous tick position, for render interpolation
  readonly py: Float32Array;
  readonly kind: Uint8Array;
  readonly timer: Float32Array; // bite cooldown / incubation / panic
  readonly speed: Float32Array;
  readonly heading: Float32Array;
  readonly home: Int32Array; // recruit -> barracks unit id

  readonly civHash: SpatialHash; // civilians, carriers, recruits
  readonly zomHash: SpatialHash;
  readonly crowd: Uint16Array;
  readonly preyField: Uint16Array;
  readonly zombieField: Uint16Array;
  readonly evacField: Uint16Array;
  readonly unitAt: Int32Array; // cell -> unit id + 1 that zombies can hit there
  private readonly solver: FieldSolver;
  private readonly srcBuf: Int32Array;
  private preyT = 0;
  private zomT = 0;
  private evacT = 0;
  evacDirty = true;
  barricadeCells: number[] = [];

  units: Unit[] = [];
  shells: Shell[] = [];
  strikes: Strike[] = [];
  effects: Effect[] = [];
  splats: { x: number; y: number; z: boolean }[] = [];
  nextUnitId = 1;

  phase: Phase = 'planning';
  time = 0;
  tickNo = 0;
  budget = 0;
  airstrikes = 0;
  counts = { civ: 0, infected: 0, zombie: 0, recruit: 0 };
  stats: Stats = { population: 0, evacuated: 0, infected: 0, friendlyFire: 0, zombiesKilled: 0, cured: 0, recruited: 0 };
  mods: Mods;
  outbreak: { x: number; y: number; n: number; infected: number; r: number }[] = [];

  constructor(grid: Grid, widthM: number, heightM: number, capacity: number, seed: number, mods?: Mods) {
    this.grid = grid;
    this.widthM = widthM;
    this.heightM = heightM;
    this.cap = capacity;
    this.rng = new Rng(seed);
    this.mods = mods ?? modsFrom({});
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.px = new Float32Array(capacity);
    this.py = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.timer = new Float32Array(capacity);
    this.speed = new Float32Array(capacity);
    this.heading = new Float32Array(capacity);
    this.home = new Int32Array(capacity);
    const cells = grid.w * grid.h;
    this.crowd = new Uint16Array(cells);
    this.preyField = new Uint16Array(cells).fill(INF);
    this.zombieField = new Uint16Array(cells).fill(INF);
    this.evacField = new Uint16Array(cells).fill(INF);
    this.unitAt = new Int32Array(cells);
    this.srcBuf = new Int32Array(cells);
    this.solver = new FieldSolver(grid);
    this.civHash = new SpatialHash(widthM, heightM, CFG.sim.hashCell, capacity);
    this.zomHash = new SpatialHash(widthM, heightM, CFG.sim.hashCell, capacity);
  }

  // ---------- spawning ----------

  spawn(kind: number, x: number, y: number): number {
    let i = -1;
    if (this.n < this.cap) i = this.n++;
    else for (let k = 0; k < this.n; k++) if (this.kind[k] === FREE) { i = k; break; }
    if (i < 0) return -1;
    this.x[i] = this.px[i] = x;
    this.y[i] = this.py[i] = y;
    this.kind[i] = kind;
    this.timer[i] = 0;
    this.heading[i] = this.rng.next() * Math.PI * 2;
    this.speed[i] =
      kind === ZOMBIE
        ? this.rng.range(CFG.zombie.speedMin, CFG.zombie.speedMax)
        : this.rng.range(CFG.civilian.speedSpread[0], CFG.civilian.speedSpread[1]);
    return i;
  }

  /** Scatters civilians over open cells. */
  populate(count: number): void {
    const g = this.grid;
    const open: number[] = [];
    for (let i = 0; i < g.w * g.h; i++) if (g.solid[i] === OPEN) open.push(i);
    for (let k = 0; k < count; k++) {
      const c = open[this.rng.int(open.length)];
      const half = g.cell / 2;
      this.spawn(CIV, g.cx(c) + this.rng.range(-half, half), g.cy(c) + this.rng.range(-half, half));
    }
    this.stats.population += count;
  }

  /** Extra civilians on open cells within r of (x, y). */
  populateNear(x: number, y: number, r: number, count: number): void {
    const g = this.grid;
    let placed = 0;
    for (let tries = 0; placed < count && tries < count * 20; tries++) {
      const a = this.rng.next() * Math.PI * 2;
      const d = Math.sqrt(this.rng.next()) * r;
      const px = x + Math.cos(a) * d;
      const py = y + Math.sin(a) * d;
      if (!g.open(g.idx(px, py))) continue;
      this.spawn(CIV, px, py);
      placed++;
    }
    this.stats.population += placed;
  }

  /** Starts the outbreak: zombies appear at the marked origins. */
  startBattle(): void {
    if (this.phase !== 'planning') return;
    for (const o of this.outbreak) {
      const c = this.grid.nearestOpen(o.x, o.y);
      for (let k = 0; k < o.n; k++) {
        const a = this.rng.next() * Math.PI * 2;
        const r = this.rng.next() * 6;
        const x = c.x + Math.cos(a) * r;
        const y = c.y + Math.sin(a) * r;
        const ok = this.grid.open(this.grid.idx(x, y));
        this.spawn(ZOMBIE, ok ? x : c.x, ok ? y : c.y);
      }
      // hidden carriers already in the crowd, turning at different times
      const near: number[] = [];
      for (let i = 0; i < this.n; i++)
        if (this.kind[i] === CIV && Math.hypot(this.x[i] - o.x, this.y[i] - o.y) < o.r) near.push(i);
      for (let k = 0; k < o.infected && near.length; k++) {
        const i = near.splice(this.rng.int(near.length), 1)[0];
        this.kind[i] = INFECTED;
        this.timer[i] = this.rng.range(2, CFG.outbreak.incubationMax);
        this.stats.infected++;
      }
    }
    this.phase = 'battle';
    this.preyT = this.zomT = this.evacT = 0;
  }

  kill(i: number, splat = true): void {
    if (splat) this.splats.push({ x: this.x[i], y: this.y[i], z: this.kind[i] === ZOMBIE });
    if (this.kind[i] === ZOMBIE) this.stats.zombiesKilled++;
    else this.stats.friendlyFire++;
    this.kind[i] = FREE;
  }

  // ---------- units & barricades ----------

  addUnit(type: UnitType, x: number, y: number): Unit {
    const def = CFG.units[type];
    const c = this.grid.idx(x, y);
    const roof = this.grid.solid[c] === BUILDING ? this.grid.height[c] : 0;
    // snipers climb to the roof; squads in a building fire from low windows
    const elev = type === 'sniper' ? roof : Math.min(roof, 8);
    const u: Unit = { id: this.nextUnitId++, type, x, y, hp: def.hp, maxHp: def.hp, cd: 0, acc: 0, age: 0, tx: x, ty: y, aim: -Math.PI / 2, elev };
    this.units.push(u);
    if (type === 'evac') this.evacDirty = true;
    this.rebuildUnitAt();
    return u;
  }

  removeUnit(u: Unit): void {
    this.units = this.units.filter((v) => v !== u);
    if (u.type === 'evac') this.evacDirty = true;
    this.rebuildUnitAt();
  }

  /** Cells from which zombies can attack each ground unit. */
  rebuildUnitAt(): void {
    const g = this.grid;
    this.unitAt.fill(0);
    for (const u of this.units) {
      if (u.type === 'heli') continue;
      const c = g.idx(u.x, u.y);
      // zombies reach a building unit through the street cells at its doors
      const r = IN_BUILDING.has(u.type) || g.solid[c] === BUILDING ? 2 : 0;
      for (let dy = -r - 1; dy <= r + 1; dy++)
        for (let dx = -r - 1; dx <= r + 1; dx++) {
          const n = c + dy * g.w + dx;
          if (n >= 0 && n < g.w * g.h && g.solid[n] === OPEN) this.unitAt[n] = u.id;
        }
    }
  }

  placeBarricade(cells: number[]): void {
    for (const c of cells) {
      if (!this.grid.open(c) || this.grid.barricade[c] > 0) continue;
      this.grid.barricade[c] = CFG.barricade.hp;
      this.barricadeCells.push(c);
    }
  }

  // ---------- simulation ----------

  tick(dt: number): void {
    if (this.phase !== 'battle') return;
    this.time += dt;
    this.tickNo++;
    const n = this.n;
    this.px.set(this.x.subarray(0, n));
    this.py.set(this.y.subarray(0, n));

    this.civHash.build(this.x, this.y, this.kind, n, (1 << CIV) | (1 << INFECTED) | (1 << RECRUIT));
    this.zomHash.build(this.x, this.y, this.kind, n, 1 << ZOMBIE);
    this.updateCrowd();
    this.updateFields(dt);
    this.moveCivilians(dt);
    this.moveZombies(dt);
    updateRecruits(this, dt, (i, tx, ty, dist) => {
      const dx = tx - this.x[i];
      const dy = ty - this.y[i];
      const len = Math.hypot(dx, dy) || 1;
      if (!this.tryMove(i, (dx / len) * dist, (dy / len) * dist, false)) this.wander(i, dist, false);
    });
    updateUnits(this, dt);
    this.recount();
    if (this.counts.zombie === 0 && this.counts.infected === 0 && this.strikes.length === 0) this.phase = 'won';
    else if (this.saved() < this.stats.population * CFG.lostBelow) this.phase = 'lost';
  }

  private updateCrowd(): void {
    const { crowd, grid, kind, x, y } = this;
    crowd.fill(0);
    for (let i = 0; i < this.n; i++) if (kind[i] === ZOMBIE) crowd[grid.idx(x[i], y[i])]++;
  }

  private updateFields(dt: number): void {
    const g = this.grid;
    const src = this.srcBuf;
    const s = CFG.sim;
    this.preyT -= dt;
    this.zomT -= dt;
    this.evacT -= dt;
    if (this.zomT <= 0) {
      // zombie proximity: drives civilian panic and bounds the prey search
      this.zomT = s.fieldEvery;
      this.preyT = s.fieldEvery / 2;
      let k = 0;
      for (let i = 0; i < this.n; i++) if (this.kind[i] === ZOMBIE) src[k++] = g.idx(this.x[i], this.y[i]);
      this.solver.solve(src, k, this.zombieField, { cap: Math.ceil((CFG.zombie.senseRadius / g.cell) * 2) });
    } else if (this.preyT <= 0) {
      this.preyT = s.fieldEvery;
      const zf = this.zombieField;
      let k = 0;
      for (let i = 0; i < this.n; i++) {
        if (this.kind[i] !== CIV && this.kind[i] !== RECRUIT) continue;
        const c = g.idx(this.x[i], this.y[i]);
        if (zf[c] < INF) src[k++] = c;
      }
      for (let c = 0; c < this.unitAt.length; c++) if (this.unitAt[c] && zf[c] < INF) src[k++] = c;
      this.solver.solve(src, k, this.preyField, { barricadeCost: CFG.zombie.barricadeCost, targets: this.crowd });
    }
    if (this.evacT <= 0 || this.evacDirty) {
      this.evacT = s.evacFieldEvery;
      this.evacDirty = false;
      let k = 0;
      for (const u of this.units) if (u.type === 'evac') src[k++] = g.idx(u.x, u.y);
      this.solver.solve(src, k, this.evacField, { cap: Math.ceil((CFG.units.evac.radius / g.cell) * 2) });
    }
  }

  /** Picks the neighbour cell with the lowest score; returns its index or -1. */
  private bestNeighbour(c: number, score: (n: number) => number, isZombie: boolean): number {
    const g = this.grid;
    const w = g.w;
    let best = -1;
    let bestS = score(c);
    for (let dy = -w; dy <= w; dy += w)
      for (let dx = -1; dx <= 1; dx++) {
        const nidx = c + dy + dx;
        if (nidx === c || g.solid[nidx] !== OPEN) continue;
        // no squeezing diagonally past a wall corner (or a barricade, for zombies)
        if (dx !== 0 && dy !== 0) {
          const blocked = (q: number) => g.solid[q] !== OPEN || (isZombie && g.barricade[q] > 0);
          if (blocked(c + dx) || blocked(c + dy)) continue;
        }
        const sc = score(nidx);
        if (sc < bestS) {
          bestS = sc;
          best = nidx;
        }
      }
    return best;
  }

  /** Moves agent i towards the centre of cell `to` (with a per-agent lane offset). */
  private stepTowards(i: number, to: number, dist: number, isZombie: boolean): void {
    const g = this.grid;
    const off = ((i * 2654435761) >>> 0) / 4294967296;
    const tx = g.cx(to) + (off - 0.5) * g.cell * 0.8;
    const ty = g.cy(to) + (((off * 7.31) % 1) - 0.5) * g.cell * 0.8;
    const dx = tx - this.x[i];
    const dy = ty - this.y[i];
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) return;
    this.heading[i] = Math.atan2(dy, dx);
    this.tryMove(i, (dx / len) * Math.min(dist, len), (dy / len) * Math.min(dist, len), isZombie);
  }

  /** Axis-separated move with wall sliding. Returns false if fully blocked. */
  private tryMove(i: number, dx: number, dy: number, isZombie: boolean): boolean {
    const x = this.x[i];
    const y = this.y[i];
    if (this.free(x + dx, y + dy, isZombie)) {
      this.x[i] = x + dx;
      this.y[i] = y + dy;
      return true;
    }
    if (this.free(x + dx, y, isZombie)) {
      this.x[i] = x + dx;
      return true;
    }
    if (this.free(x, y + dy, isZombie)) {
      this.y[i] = y + dy;
      return true;
    }
    return false;
  }

  private free(x: number, y: number, isZombie: boolean): boolean {
    const c = this.grid.idx(x, y);
    return this.grid.solid[c] === OPEN && (!isZombie || this.grid.barricade[c] <= 0);
  }

  private wander(i: number, dist: number, isZombie: boolean): void {
    if (this.rng.next() < CFG.civilian.turnChance) this.heading[i] += this.rng.range(-1.5, 1.5);
    const h = this.heading[i];
    if (!this.tryMove(i, Math.cos(h) * dist, Math.sin(h) * dist, isZombie)) this.heading[i] += Math.PI * this.rng.range(0.5, 1.5);
  }

  private moveCivilians(dt: number): void {
    const { kind, grid, zombieField: zf, evacField: ef, crowd } = this;
    const cv = CFG.civilian;
    const panicD = (cv.panicRadius / grid.cell) * 2;
    // calm wanderers only need updating every 4th tick
    const phase = this.tickNo & 3;
    for (let i = 0; i < this.n; i++) {
      const k = kind[i];
      if (k !== CIV && k !== INFECTED) continue;
      if (k === INFECTED) {
        this.timer[i] -= dt;
        if (this.timer[i] <= 0) {
          kind[i] = ZOMBIE;
          this.speed[i] = this.rng.range(CFG.zombie.speedMin, CFG.zombie.speedMax);
          this.timer[i] = 0;
          continue;
        }
      }
      const c = grid.idx(this.x[i], this.y[i]);
      const threatened = zf[c] < panicD;
      const run = threatened || ef[c] < INF;
      const v = (run ? cv.run : cv.walk) * this.speed[i] * dt;
      if (ef[c] < INF) {
        // head to evacuation, avoiding zombies on the way
        const to = this.bestNeighbour(c, (nn) => ef[nn] + (zf[nn] < 6 ? (6 - zf[nn]) * 6 : 0) + crowd[nn] * 2, false);
        if (to >= 0) this.stepTowards(i, to, v, false);
        else this.wander(i, v * 0.3, false);
      } else if (threatened) {
        const to = this.bestNeighbour(c, (nn) => -zf[nn] + crowd[nn] * 3, false);
        if (to >= 0) this.stepTowards(i, to, v, false);
        else this.wander(i, v, false);
      } else if ((i & 3) === phase) {
        this.wander(i, v * 4, false);
      }
    }
  }

  private moveZombies(dt: number): void {
    const { kind, grid, preyField: pf, crowd, x, y } = this;
    const z = CFG.zombie;
    const bite2 = z.biteRange * z.biteRange;
    const cw = z.crowdWeight;
    for (let i = 0; i < this.n; i++) {
      if (kind[i] !== ZOMBIE) continue;
      if (this.timer[i] > 0) this.timer[i] -= dt;
      const c = grid.idx(x[i], y[i]);
      const v = this.speed[i] * dt;

      // attack a unit standing here
      const uid = this.unitAt[c];
      if (uid) {
        const u = this.units.find((q) => q.id === uid);
        if (u) {
          u.hp -= z.unitDps * dt;
          continue;
        }
      }

      if (pf[c] <= 3) {
        // prey is close: chase the nearest civilian directly and bite
        const t = this.civHash.nearest(x, y, x[i], y[i], grid.cell * 2.5, 0, (j) => kind[j] === CIV || kind[j] === RECRUIT);
        if (t >= 0) {
          const dx = x[t] - x[i];
          const dy = y[t] - y[i];
          const d2 = dx * dx + dy * dy;
          if (d2 <= bite2) {
            if (this.timer[i] <= 0) {
              kind[t] = INFECTED;
              this.timer[t] = this.rng.range(z.incubationMin, z.incubationMax);
              this.stats.infected++;
              this.timer[i] = z.biteCooldown;
            }
          } else {
            const d = Math.sqrt(d2);
            this.tryMove(i, (dx / d) * Math.min(v, d), (dy / d) * Math.min(v, d), true);
          }
          continue;
        }
      }
      if (pf[c] >= INF) {
        this.wander(i, v * 0.4, true);
        continue;
      }
      const to = this.bestNeighbour(c, (nn) => pf[nn] + crowd[nn] * cw, true);
      if (to < 0) {
        this.wander(i, v * 0.5, true);
        continue;
      }
      if (grid.barricade[to] > 0) {
        grid.barricade[to] -= z.barricadeDps * dt;
        if (grid.barricade[to] <= 0) {
          grid.barricade[to] = 0;
          this.barricadeCells = this.barricadeCells.filter((q) => q !== to);
        }
        continue;
      }
      crowd[c]--;
      crowd[to]++;
      this.stepTowards(i, to, v, true);
    }
  }

  recount(): void {
    let civ = 0;
    let inf = 0;
    let zom = 0;
    let rec = 0;
    let top = 0;
    for (let i = 0; i < this.n; i++) {
      const k = this.kind[i];
      if (k === CIV) civ++;
      else if (k === INFECTED) inf++;
      else if (k === ZOMBIE) zom++;
      else if (k === RECRUIT) rec++;
      if (k !== FREE) top = i + 1;
    }
    this.n = top;
    this.counts.civ = civ;
    this.counts.infected = inf;
    this.counts.zombie = zom;
    this.counts.recruit = rec;
  }

  /** Healthy civilians and recruits still in the city, plus evacuated. */
  saved(): number {
    return this.counts.civ + this.counts.recruit + this.stats.evacuated;
  }
}
