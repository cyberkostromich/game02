import { CFG } from '../config';
import { lineOfSight, type Unit } from './units';
import { CIV, INFECTED, RECRUIT, ZOMBIE, type World } from './world';

// Safe zones and the building specialisations that work inside them:
// medic (cures carriers, heals units), repair (barricades, units),
// barracks (turns civilians into armed recruits).

/** A safe zone surrounds every evacuation point. */
export function inSafeZone(w: World, x: number, y: number): boolean {
  const r2 = CFG.safeZone.radius ** 2;
  return w.units.some((u) => u.type === 'evac' && (u.x - x) ** 2 + (u.y - y) ** 2 < r2);
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
      u.acc = Math.min(u.acc + d.cureRate * dt, d.cureRate * 2);
      w.civHash.forEachInRadius(w.x, w.y, u.x, u.y, d.radius, (i) => {
        if (u.acc < 1 || w.kind[i] !== INFECTED) return;
        u.acc -= 1;
        w.kind[i] = CIV;
        w.timer[i] = 0;
        w.stats.cured++;
      });
      healUnits(w, u, d.healRadius, d.healRate * dt);
      break;
    }
    case 'repair': {
      const d = CFG.units.repair;
      const g = w.grid;
      const r2 = d.radius * d.radius;
      for (const c of w.barricadeCells)
        if ((g.cx(c) - u.x) ** 2 + (g.cy(c) - u.y) ** 2 < r2)
          g.barricade[c] = Math.min(CFG.barricade.hp, g.barricade[c] + d.rate * dt);
      healUnits(w, u, d.radius, d.rate * 0.5 * dt);
      break;
    }
    case 'barracks': {
      const d = CFG.units.barracks;
      u.acc = Math.min(u.acc + d.rate * dt, 2);
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
 * Recruits guard their barracks: shoot the nearest zombie in sight, close in on
 * zombies near home, otherwise drift back. Zombies bite them like anyone else.
 */
export function updateRecruits(w: World, dt: number, move: (i: number, tx: number, ty: number, dist: number) => void): void {
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
        w.effects.push({ kind: 'tracer', x, y, x2: w.x[t], y2: w.y[t], r: 0, t: 0, life: 0.07 });
        if (w.rng.next() < r.accuracy) w.kill(t);
      }
      continue; // hold position while shooting
    }
    const home = homes.get(w.home[i]);
    if (!home) continue;
    const d = Math.hypot(home.x - x, home.y - y);
    if (d > r.guard * 0.5) move(i, home.x, home.y, r.speed * dt);
  }
}
