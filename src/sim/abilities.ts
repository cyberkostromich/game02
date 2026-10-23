import { CFG, type AbilityId } from '../config';
import { CIV, RECRUIT, type World } from './world';

// Called-in support with a price and a cooldown: gas (freezes zombies), fire
// (a burning strip that kills anyone crossing it), paratroopers (a free squad
// that hunts zombies) and "call to arms" (arms the crowd around a point).

export interface Cloud {
  kind: 'gas' | 'fire';
  x: number;
  y: number;
  r: number;
  t: number; // seconds left
}

export interface Drop {
  x: number;
  y: number;
  t: number; // seconds until the squad lands
}

export const LINE_ABILITIES: ReadonlySet<AbilityId> = new Set(['fire']);

export function abilityReady(w: World, id: AbilityId): boolean {
  return w.phase === 'battle' && w.cooldowns[id] <= 0 && w.budget >= CFG.abilities[id].cost;
}

/** Fires an ability at (x0, y0); line abilities run towards (x1, y1). */
export function useAbility(w: World, id: AbilityId, x0: number, y0: number, x1 = x0, y1 = y0): boolean {
  if (!abilityReady(w, id)) return false;
  const a = CFG.abilities;
  switch (id) {
    case 'gas':
      w.clouds.push({ kind: 'gas', x: x0, y: y0, r: a.gas.radius, t: a.gas.duration });
      break;
    case 'fire': {
      w.sfx.push({ k: 'boom', x: x0, y: y0 });
      const len = Math.hypot(x1 - x0, y1 - y0) || 1;
      const dx = (x1 - x0) / len;
      const dy = (y1 - y0) / len;
      const r = a.fire.width / 2;
      for (let d = 0; d <= a.fire.length; d += r * 1.4) w.clouds.push({ kind: 'fire', x: x0 + dx * d, y: y0 + dy * d, r, t: a.fire.duration });
      break;
    }
    case 'para':
      w.drops.push({ x: x0, y: y0, t: a.para.delay });
      w.sfx.push({ k: 'plane', x: x0, y: y0 });
      break;
    case 'arms': {
      let armed = 0;
      w.civHash.forEachInRadius(w.x, w.y, x0, y0, a.arms.radius, (i) => {
        if (armed >= a.arms.max || w.kind[i] !== CIV) return;
        w.kind[i] = RECRUIT;
        w.home[i] = 0;
        w.timer[i] = 0;
        armed++;
      });
      w.stats.recruited += armed;
      break;
    }
  }
  w.budget -= a[id].cost;
  w.cooldowns[id] = a[id].cooldown;
  return true;
}

export function updateAbilities(w: World, dt: number): void {
  for (const id of Object.keys(w.cooldowns) as AbilityId[]) w.cooldowns[id] = Math.max(0, w.cooldowns[id] - dt);

  const kill = CFG.abilities.fire.killRate * dt;
  for (const c of w.clouds) {
    c.t -= dt;
    if (c.kind !== 'fire') continue;
    const burn = (i: number) => {
      if (w.rng.next() < kill && w.kind[i] !== 0) w.hit(i, 'fire');
    };
    w.zomHash.forEachInRadius(w.x, w.y, c.x, c.y, c.r, burn);
    w.civHash.forEachInRadius(w.x, w.y, c.x, c.y, c.r, burn);
  }
  w.clouds = w.clouds.filter((c) => c.t > 0);

  for (const d of w.drops) {
    d.t -= dt;
    if (d.t > 0) continue;
    const p = w.grid.nearestOpen(d.x, d.y);
    for (let k = 0; k < CFG.abilities.para.squad; k++) {
      const i = w.spawn(RECRUIT, p.x + w.rng.range(-4, 4), p.y + w.rng.range(-4, 4));
      if (i >= 0 && !w.grid.open(w.grid.idx(w.x[i], w.y[i]))) {
        w.x[i] = w.px[i] = p.x;
        w.y[i] = w.py[i] = p.y;
      }
    }
    w.stats.population += CFG.abilities.para.squad; // soldiers count as lives to save
  }
  w.drops = w.drops.filter((d) => d.t > 0);
}
