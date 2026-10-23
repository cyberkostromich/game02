import { CFG } from '../config';
import { levelRate, lineOfSight, type Unit } from './units';
import { CIV, INFECTED, RECRUIT, ZOMBIE, type World } from './world';

// Safe zones and the building specialisations that work inside them:
// medic (cures carriers, heals units), repair (barricades, units),
// barracks (turns civilians into armed recruits).

export interface Zone {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Safe zones: the drawn (merged) zone cells plus a circle around every evac point. */
export function inSafeZone(w: World, x: number, y: number): boolean {
  if (w.zoneMask[w.grid.idx(x, y)]) return true;
  const r2 = CFG.safeZone.radius ** 2;
  return w.units.some((u) => u.type === 'evac' && (u.x - x) ** 2 + (u.y - y) ** 2 < r2);
}

/** Normalised rectangle from a drag, or null if too small / too big. */
export function zoneFromDrag(x0: number, y0: number, x1: number, y1: number): Zone | null {
  const z = { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
  const s = CFG.safeZone;
  if (z.x1 - z.x0 < s.minSide || z.y1 - z.y0 < s.minSide) return null;
  if ((z.x1 - z.x0) * (z.y1 - z.y0) > s.maxArea) return null;
  return z;
}

/** Grid cells a rectangle covers. */
export function rectCells(w: World, z: Zone): number[] {
  const g = w.grid;
  const out: number[] = [];
  const c0x = Math.max(1, Math.floor(z.x0 / g.cell));
  const c1x = Math.min(g.w - 2, Math.floor(z.x1 / g.cell));
  const c0y = Math.max(1, Math.floor(z.y0 / g.cell));
  const c1y = Math.min(g.h - 2, Math.floor(z.y1 / g.cell));
  for (let y = c0y; y <= c1y; y++) for (let x = c0x; x <= c1x; x++) out.push(y * g.w + x);
  return out;
}

/** Price of extending the safe zone by this rectangle: only cells not already covered. */
export function zoneCost(w: World, z: Zone): number {
  const fresh = rectCells(w, z).filter((c) => !w.zoneMask[c]).length;
  return Math.ceil(fresh * w.grid.cell * w.grid.cell * CFG.safeZone.costPerM2);
}

function healUnits(w: World, u: Unit, radius: number, rate: number): void {
  for (const v of w.units)
    if (v !== u && v.hp < v.maxHp && (v.x - u.x) ** 2 + (v.y - u.y) ** 2 < radius * radius)
      v.hp = Math.min(v.maxHp, v.hp + rate);
}

export function updateSpecialist(w: World, u: Unit, dt: number): void {
  switch (u.type) {
    case 'medic': {
      const d = CFG.units.medic;
      u.acc = Math.min(u.acc + d.cureRate * levelRate(u) * dt, d.cureRate * 2);
      w.civHash.forEachInRadius(w.x, w.y, u.x, u.y, d.radius, (i) => {
        if (u.acc < 1 || w.kind[i] !== INFECTED) return;
        u.acc -= 1;
        w.kind[i] = CIV;
        w.timer[i] = 0;
        w.stats.cured++;
      });
      healUnits(w, u, d.healRadius, d.healRate * levelRate(u) * dt);
      break;
    }
    case 'repair': {
      const d = CFG.units.repair;
      const g = w.grid;
      const r2 = d.radius * d.radius;
      for (const c of w.barricadeCells)
        if ((g.cx(c) - u.x) ** 2 + (g.cy(c) - u.y) ** 2 < r2)
          g.barricade[c] = Math.min(CFG.barricade.hp, g.barricade[c] + d.rate * levelRate(u) * dt);
      healUnits(w, u, d.radius, d.rate * 0.5 * levelRate(u) * dt);
      break;
    }
    case 'barracks': {
      const d = CFG.units.barracks;
      u.acc = Math.min(u.acc + d.rate * levelRate(u) * dt, 2);
      let have = 0;
      for (let i = 0; i < w.n; i++) if (w.kind[i] === RECRUIT && w.home[i] === u.id) have++;
      if (have >= d.max) break;
      w.civHash.forEachInRadius(w.x, w.y, u.x, u.y, d.radius, (i) => {
        if (u.acc < 1 || have >= d.max || w.kind[i] !== CIV) return;
        u.acc -= 1;
        have++;
        w.kind[i] = RECRUIT;
        w.home[i] = u.id;
        w.timer[i] = 0;
        w.stats.recruited++;
      });
      break;
    }
  }
}

/**
 * Recruits shoot the nearest zombie in sight. Barracks recruits drift back home
 * when idle; free squads (paratroopers, call to arms: home 0) hunt zombies.
 * Zombies bite them like anyone else.
 */
export function updateRecruits(
  w: World,
  dt: number,
  move: (i: number, tx: number, ty: number, dist: number) => void,
  hunt: (i: number, dist: number) => void,
): void {
  const r = CFG.recruit;
  const eye = CFG.sight.eye;
  const homes = new Map<number, Unit>();
  for (const u of w.units) if (u.type === 'barracks') homes.set(u.id, u);
  for (let i = 0; i < w.n; i++) {
    if (w.kind[i] !== RECRUIT) continue;
    w.timer[i] -= dt;
    const x = w.x[i];
    const y = w.y[i];
    const t = w.zomHash.nearest(w.x, w.y, x, y, r.range, 0, (j) => w.kind[j] === ZOMBIE && lineOfSight(w, x, y, eye, w.x[j], w.y[j]));
    if (t >= 0) {
      if (w.timer[i] <= 0) {
        w.timer[i] = r.reload * w.rng.range(0.8, 1.2);
        w.effects.push({ kind: 'tracer', x, y, x2: w.x[t], y2: w.y[t], r: 1, t: 0, life: 0.18 });
        w.sfx.push({ k: 'rifle', x, y });
        if (w.rng.next() < r.accuracy) w.hit(t, 'recruits');
      }
      continue; // hold position while shooting
    }
    if (w.home[i] === 0) {
      hunt(i, r.speed * dt);
      continue;
    }
    const home = homes.get(w.home[i]);
    if (!home) {
      w.home[i] = 0; // barracks lost: the squad goes hunting
      continue;
    }
    const d = Math.hypot(home.x - x, home.y - y);
    if (d > r.guard * 0.5) move(i, home.x, home.y, r.speed * dt);
  }
}
