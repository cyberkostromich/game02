import { CFG, type AbilityId, type UnitType, type Upgrades } from '../config';
import type { SfxEvent } from '../audio';
import { updateAbilities, type Cloud, type Drop } from './abilities';
import { FieldSolver, INF } from './field';
import { BUILDING, Grid, OPEN } from './grid';
import { SpatialHash } from './hash';
import { Rng } from './rng';
import { inRect, updateRecruits, type Zone } from './support';
import { doorsOf, IN_BUILDING, MOVABLE, updateUnits, type Effect, type Strike, type Shell, type Unit } from './units';

// Agent kinds
export const FREE = 0;
export const CIV = 1;
export const INFECTED = 2; // bitten, still looks and acts human until it turns
export const ZOMBIE = 3;
export const RECRUIT = 4; // armed civilian or paratrooper

export type Phase = 'planning' | 'battle' | 'won' | 'lost';

export interface Stats {
  population: number;
  evacuated: number;
  infected: number; // total ever bitten
  friendlyFire: number; // civilians killed by our own fire
  zombiesKilled: number;
  cured: number;
  recruited: number;
  bounty: number; // $ earned for kills
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
  readonly home: Int32Array; // recruit -> barracks unit id; 0 = free squad that hunts
  readonly zhp: Uint8Array; // zombie hit points
  zombieHp = 1;
  readonly spikes: Uint8Array; // cells with spike strips
  spikeCells: number[] = [];

  readonly civHash: SpatialHash; // civilians, carriers, recruits
  readonly zomHash: SpatialHash;
  readonly crowd: Uint16Array;
  readonly preyField: Uint16Array;
  readonly zombieField: Uint16Array;
  /** distance to the nearest evacuation point (within its radius) */
  readonly evacField: Uint16Array;
  /** distance to the nearest drawn safe zone (0 inside) */
  readonly shelterField: Uint16Array;
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
  zones: Zone[] = [];
  clouds: Cloud[] = [];
  drops: Drop[] = [];
  cooldowns: Record<AbilityId, number> = { gas: 0, fire: 0, para: 0, arms: 0 };
  killsBy: Record<string, number> = {};
  sfx: SfxEvent[] = []; // sound events for the renderer; drained every frame
  moveMarks: { x: number; y: number; t: number }[] = []; // UI: where a march was ordered
  nextUnitId = 1;

  phase: Phase = 'planning';
  time = 0;
  tickNo = 0;
  budget = 0;
  airstrikes = 0;
  counts = { civ: 0, infected: 0, zombie: 0, recruit: 0 };
  stats: Stats = { population: 0, evacuated: 0, infected: 0, friendlyFire: 0, zombiesKilled: 0, cured: 0, recruited: 0, bounty: 0 };
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
    this.zhp = new Uint8Array(capacity);
    const cells = grid.w * grid.h;
    this.crowd = new Uint16Array(cells);
    this.preyField = new Uint16Array(cells).fill(INF);
    this.zombieField = new Uint16Array(cells).fill(INF);
    this.evacField = new Uint16Array(cells).fill(INF);
    this.shelterField = new Uint16Array(cells).fill(INF);
    this.unitAt = new Int32Array(cells);
    this.spikes = new Uint8Array(cells);
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
    this.home[i] = 0;
    this.zhp[i] = this.zombieHp;
    this.heading[i] = this.rng.next() * Math.PI * 2;
    this.speed[i] =
      kind === ZOMBIE ? this.zombieSpeed() : this.rng.range(CFG.civilian.speedSpread[0], CFG.civilian.speedSpread[1]);
    return i;
  }

  zombieSpeed(): number {
    const z = CFG.zombie;
    return this.rng.next() < z.runnerShare ? z.runnerSpeed : this.rng.range(z.speedMin, z.speedMax);
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

  /** Removes agent i; `by` credits a zombie kill to a unit type or ability. */
  kill(i: number, by = ''): void {
    this.splats.push({ x: this.x[i], y: this.y[i], z: this.kind[i] === ZOMBIE });
    if (this.kind[i] === ZOMBIE) {
      this.stats.zombiesKilled++;
      this.budget += CFG.bounty;
      this.stats.bounty += CFG.bounty;
      if (by) this.killsBy[by] = (this.killsBy[by] ?? 0) + 1;
    } else this.stats.friendlyFire++;
    this.kind[i] = FREE;
  }

  /** One point of damage: tougher zombies survive a hit. Returns true on a kill. */
  hit(i: number, by: string): boolean {
    if (this.kind[i] === ZOMBIE && this.zhp[i] > 1) {
      this.zhp[i]--;
      return false;
    }
    this.kill(i, by);
    return true;
  }

  // ---------- units & barricades ----------

  addUnit(type: UnitType, x: number, y: number): Unit {
    const def = CFG.units[type];
    const c = this.grid.idx(x, y);
    const roof = this.grid.solid[c] === BUILDING ? this.grid.height[c] : 0;
    // snipers climb to the roof; squads in a building fire from low windows
    const elev = type === 'sniper' ? roof : Math.min(roof, 8);
    const ammo = 'magazine' in def ? def.magazine : 'charges' in def ? def.charges : Infinity;
    const u: Unit = {
      id: this.nextUnitId++, type, x, y, hp: def.hp, maxHp: def.hp, cd: 0, acc: 0, age: 0,
      tx: x, ty: y, aim: -Math.PI / 2, elev, level: 1, ammo, kills: 0, moving: false, route: null, dest: null,
    };
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
      if (u.type === 'heli' || u.type === 'mines') continue; // out of reach / not a target
      const c = g.idx(u.x, u.y);
      if (u.moving) continue; // marching units are hit where they stand, below
      if (IN_BUILDING.has(u.type) || g.solid[c] === BUILDING) {
        // zombies reach a building unit through the street cells at its doors
        for (const d of doorsOf(this, c)) this.unitAt[d] = u.id;
        continue;
      }
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
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

  addZone(z: Zone): void {
    this.zones.push(z);
    this.evacDirty = true;
  }

  /**
   * Orders a unit to march to (x, y) along the streets. A building target is
   * entered through its nearest door. Returns false if unreachable.
   */
  orderMove(u: Unit, x: number, y: number): boolean {
    if (!MOVABLE.has(u.type)) return false;
    const g = this.grid;
    const c = g.idx(x, y);
    const inside = g.solid[c] === BUILDING;
    const goals = inside ? doorsOf(this, c) : g.solid[c] === OPEN ? [c] : [];
    if (!goals.length) return false;
    const route = u.route ?? new Uint16Array(g.w * g.h);
    this.solver.solve(goals, goals.length, route, { cap: Math.ceil((CFG.move.maxPath / g.cell) * 2) });
    let start = g.idx(u.x, u.y);
    if (g.solid[start] !== OPEN) {
      const doors = doorsOf(this, start);
      if (!doors.length) return false;
      start = doors.reduce((a, b) => (route[b] < route[a] ? b : a));
      if (route[start] >= INF) return false;
      u.x = g.cx(start); // step out of the building onto the street
      u.y = g.cy(start);
    } else if (route[start] >= INF) return false;
    u.route = route;
    u.dest = { x, y, inside };
    u.moving = true;
    u.elev = 0;
    this.rebuildUnitAt();
    return true;
  }

  /** Planning phase: redeploy instantly. */
  relocate(u: Unit, x: number, y: number): void {
    const g = this.grid;
    const c = g.idx(x, y);
    const roof = g.solid[c] === BUILDING ? g.height[c] : 0;
    u.x = x;
    u.y = y;
    u.elev = u.type === 'sniper' ? roof : Math.min(roof, 8);
    this.rebuildUnitAt();
  }

  /** One tick of a march; zombies close by maul the column. */
  marchStep(u: Unit, dt: number): void {
    const g = this.grid;
    const route = u.route!;
    const speed = CFG.move[u.type as keyof typeof CFG.move] as number;
    const near = this.zomHash.countInRadius(this.x, this.y, u.x, u.y, 3);
    u.hp -= near * CFG.zombie.unitDps * dt;
    const c = g.idx(u.x, u.y);
    if (route[c] <= 2) {
      const d = u.dest!;
      u.x = d.inside ? d.x : g.cx(c);
      u.y = d.inside ? d.y : g.cy(c);
      if (d.inside) {
        const roof = g.height[g.idx(d.x, d.y)];
        u.elev = u.type === 'sniper' ? roof : Math.min(roof, 8);
      }
      u.moving = false;
      u.route = null;
      u.dest = null;
      this.rebuildUnitAt();
      return;
    }
    const to = this.bestNeighbour(c, (nn) => route[nn], false);
    if (to < 0) return;
    const dx = g.cx(to) - u.x;
    const dy = g.cy(to) - u.y;
    const len = Math.hypot(dx, dy) || 1;
    const step = Math.min(len, speed * dt);
    u.x += (dx / len) * step;
    u.y += (dy / len) * step;
    u.aim = Math.atan2(dy, dx);
  }

  placeSpikes(cells: number[]): void {
    for (const c of cells) {
      if (!this.grid.open(c) || this.spikes[c]) continue;
      this.spikes[c] = 1;
      this.spikeCells.push(c);
    }
  }

  // ---------- simulation ----------

  tick(dt: number): void {
    if (this.phase !== 'battle') return;
    this.time += dt;
    this.tickNo++;
    if (this.sfx.length > 400) this.sfx.length = 0; // nobody is listening
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
    }, (i, dist) => {
      // free squads walk down the zombie-proximity field, around buildings
      const zf = this.zombieField;
      const c = this.grid.idx(this.x[i], this.y[i]);
      const to = zf[c] < INF ? this.bestNeighbour(c, (nn) => zf[nn], false) : -1;
      if (to >= 0) this.stepTowards(i, to, dist, false);
      else this.wander(i, dist * 0.5, false);
    });
    updateUnits(this, dt);
    updateAbilities(this, dt);
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
      this.preyT = Math.min(this.preyT, s.fieldEvery / 2); // keep the two solves on different ticks
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
      k = 0;
      for (const z of this.zones)
        for (let y = z.y0 + g.cell / 2; y < z.y1; y += g.cell)
          for (let x = z.x0 + g.cell / 2; x < z.x1; x += g.cell) src[k++] = g.idx(x, y);
      this.solver.solve(src, k, this.shelterField, { cap: Math.ceil((CFG.safeZone.attract / g.cell) * 2) });
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
    const { kind, grid, zombieField: zf, evacField: ef, shelterField: sf, crowd } = this;
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
          this.zhp[i] = this.zombieHp;
          this.speed[i] = this.zombieSpeed();
          this.timer[i] = 0;
          continue;
        }
      }
      const c = grid.idx(this.x[i], this.y[i]);
      const threatened = zf[c] < panicD;
      const run = threatened || ef[c] < INF || (sf[c] < INF && sf[c] > 0);
      const v = (run ? cv.run : cv.walk) * this.speed[i] * dt;
      if (ef[c] < INF) {
        // an evacuation point is in reach: it beats sheltering
        const to = this.bestNeighbour(c, (nn) => ef[nn] + (zf[nn] < 6 ? (6 - zf[nn]) * 6 : 0) + crowd[nn] * 2, false);
        if (to >= 0) this.stepTowards(i, to, v, false);
        else this.wander(i, v * 0.3, false);
      } else if (sf[c] === 0 && this.zones.some((z) => inRect(z, this.x[i], this.y[i]))) {
        // sheltering: mill about but stay inside the zone
        if ((i & 3) === phase) {
          const h = (this.heading[i] += this.rng.range(-0.6, 0.6));
          const nx = this.x[i] + Math.cos(h) * v;
          const ny = this.y[i] + Math.sin(h) * v;
          if (sf[grid.idx(nx, ny)] === 0 && grid.open(grid.idx(nx, ny))) {
            this.x[i] = nx;
            this.y[i] = ny;
          } else this.heading[i] += Math.PI;
        }
      } else if (sf[c] < INF) {
        // head for the safe zone, avoiding zombies on the way
        const to = this.bestNeighbour(c, (nn) => sf[nn] + (zf[nn] < 6 ? (6 - zf[nn]) * 6 : 0) + crowd[nn] * 2, false);
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
    const gas = this.clouds.filter((q) => q.kind === 'gas');
    const sp = CFG.spikes;
    for (let i = 0; i < this.n; i++) {
      if (kind[i] !== ZOMBIE) continue;
      if (this.timer[i] > 0) this.timer[i] -= dt;
      if (gas.length && gas.some((q) => (q.x - x[i]) ** 2 + (q.y - y[i]) ** 2 < q.r * q.r)) continue; // frozen
      const c = grid.idx(x[i], y[i]);
      let v = this.speed[i] * dt;
      if (this.spikes[c]) {
        v *= sp.slow;
        if (this.rng.next() < sp.killRate * dt && this.hit(i, 'spikes')) continue;
      }

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
              if (this.rng.next() < 0.3) this.sfx.push({ k: 'groan', x: x[i], y: y[i] });
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
