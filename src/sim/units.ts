import { CFG, type UnitType } from '../config';
import { BUILDING, OPEN } from './grid';
import { inSafeZone, updateSpecialist } from './support';
import { FREE, CIV, RECRUIT, ZOMBIE, type World } from './world';

export interface Unit {
  id: number;
  type: UnitType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  cd: number; // weapon cooldown
  acc: number; // evac throughput accumulator
  age: number;
  tx: number; // helicopter destination
  ty: number;
  aim: number; // last firing direction, for rendering
  elev: number; // m above the street (roof or window)
  level: number;
  ammo: number; // shots (or mine charges) left; Infinity = no limit
  kills: number;
  moving: boolean;
  route: Uint16Array | null; // distance field to the march destination
  dest: { x: number; y: number; inside: boolean } | null;
  dir: number; // hull heading (vehicles, marching units)
  aux: number; // secondary cooldown: tank machine gun, BMP squad drop
}

export const MOVABLE: ReadonlySet<UnitType> = new Set(['sniper', 'garrison', 'turret', 'mortar', 'tank', 'bmp']);
/** Vehicles keep fighting on the move and shrug off bites. */
export const VEHICLES: ReadonlySet<UnitType> = new Set(['tank', 'bmp']);

/** Height a unit sits at in a building with this roof: roofs for gunners, windows for squads. */
export function elevFor(type: UnitType, roof: number): number {
  return type === 'garrison' ? Math.min(roof, 8) : roof;
}

/** Fire-rate / throughput multiplier from the unit's level. */
export function levelRate(u: Unit): number {
  return 1 + CFG.levels.rate * (u.level - 1);
}

export function levelUpCost(u: Unit): number {
  return Math.round(CFG.units[u.type].cost * CFG.levels.costShare * u.level);
}

export function canLevelUp(u: Unit): boolean {
  return u.level < CFG.levels.max && u.type !== 'heli' && u.type !== 'mines';
}

export function levelUp(w: World, u: Unit): boolean {
  const cost = levelUpCost(u);
  if (!canLevelUp(u) || w.budget < cost) return false;
  w.budget -= cost;
  u.level++;
  const add = CFG.units[u.type].hp * CFG.levels.hp;
  u.maxHp += add;
  u.hp += add;
  return true;
}

export function magazineOf(u: Unit): number {
  const d = CFG.units[u.type];
  return 'magazine' in d ? d.magazine : Infinity;
}

/** Units that live inside a building; the rest stand on the street. */
/** Building specialisations, allowed only inside a safe zone. */
export const SPECIALISTS: ReadonlySet<UnitType> = new Set(['medic', 'repair', 'barracks']);
/** Units that need open ground; everything else combat may also take a building. */
export const STREET_ONLY: ReadonlySet<UnitType> = new Set(['evac', 'mines', 'tank', 'bmp']);

export interface Shell {
  x: number;
  y: number;
  t: number;
  r: number;
  flight: number;
  by: string; // kill credit
  owner?: Unit;
}

export interface Strike {
  x: number;
  y: number;
  dx: number; // unit direction
  dy: number;
  t: number; // countdown to first bomb
  dropped: number;
  width: number;
}

export interface Effect {
  kind: 'tracer' | 'boom' | 'smoke' | 'evac';
  x: number;
  y: number;
  x2: number;
  y2: number;
  r: number;
  t: number;
  life: number;
  h?: number; // shooter elevation, for drawing
}

/**
 * Height-aware line of sight. A building blocks the shot only if it rises above
 * the line from the shooter's eye (h0) to a target standing in the street, so a
 * rooftop sniper sees over low blocks. Cells of the shooter's own building are
 * ignored until the line first reaches open ground.
 */
export function lineOfSight(w: World, x0: number, y0: number, h0: number, x1: number, y1: number): boolean {
  const g = w.grid;
  const eye = CFG.sight.eye;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  const step = g.cell * 0.5;
  const n = Math.floor(len / step);
  let leaving = g.solid[g.idx(x0, y0)] === BUILDING; // only a shooter inside a building looks out of it
  for (let k = 1; k < n; k++) {
    const t = (k * step) / len;
    const c = g.idx(x0 + dx * t, y0 + dy * t);
    if (g.solid[c] !== BUILDING) {
      leaving = false;
      continue;
    }
    if (leaving) continue;
    if (g.height[c] > h0 + (eye - h0) * t) return false;
  }
  return true;
}

export function unitRange(w: World, type: UnitType, elev = 0, level = 1): number {
  const d = CFG.units[type];
  const r = ('range' in d ? d.range : 0) * (1 + CFG.levels.range * (level - 1));
  if (type !== 'sniper') return r;
  const s = CFG.sight;
  return r * w.mods.sniperRange + Math.min(elev * s.sniperRoofBonus, s.sniperRoofBonusMax);
}

function boom(w: World, x: number, y: number, r: number, by: string): void {
  w.sfx.push({ k: 'boom', x, y });
  w.effects.push({ kind: 'boom', x, y, x2: x, y2: y, r, t: 0, life: 0.6 });
  w.effects.push({ kind: 'smoke', x, y, x2: x, y2: y, r: r * 1.4, t: 0, life: 4 });
  const kill = (i: number) => {
    if (w.kind[i] === FREE) return;
    const d = Math.hypot(w.x[i] - x, w.y[i] - y);
    if (d < r * 0.75 || w.rng.next() < 0.7) w.kill(i, by);
  };
  w.zomHash.forEachInRadius(w.x, w.y, x, y, r, kill);
  w.civHash.forEachInRadius(w.x, w.y, x, y, r, kill);
  // explosions also wreck barricades and units caught in them
  for (const u of w.units)
    if (u.type !== 'heli' && u.type !== 'mines' && Math.hypot(u.x - x, u.y - y) < r * 0.7) u.hp -= VEHICLES.has(u.type) ? 10 : 80;
}

function fireAt(w: World, u: Unit, range: number, reload: number, accuracy: number, los: boolean): void {
  if (u.cd > 0 || u.ammo <= 0) return;
  const h0 = u.elev + CFG.sight.eye;
  const t = w.zomHash.nearest(w.x, w.y, u.x, u.y, range, 0, (i) =>
    w.kind[i] === ZOMBIE && (!los || lineOfSight(w, u.x, u.y, h0, w.x[i], w.y[i])),
  );
  if (t < 0) return;
  u.cd = (reload / levelRate(u)) * (u.moving ? (CFG.moveFire[u.type] ?? 1) : 1);
  if (!w.infiniteAmmo && --u.ammo === 0) w.notes.push({ k: 'dry', type: u.type });
  u.aim = Math.atan2(w.y[t] - u.y, w.x[t] - u.x);
  w.sfx.push({ k: u.type === 'sniper' ? 'sniper' : 'gun', x: u.x, y: u.y });
  w.effects.push({ kind: 'tracer', x: u.x, y: u.y, x2: w.x[t], y2: w.y[t], t: 0, life: u.type === 'sniper' ? 0.45 : 0.22, h: u.elev, r: u.type === 'sniper' ? 2 : 1 });
  if (w.rng.next() < accuracy && w.hit(t, u.type)) u.kills++;
}

/** Main gun (blast, holds fire near civilians) plus a coaxial machine gun. */
function tankFire(w: World, u: Unit, dt: number): void {
  const d = CFG.units.tank;
  u.aux -= dt;
  if (u.aux <= 0) {
    const mgCd = u.cd;
    u.cd = 0;
    const ammo = u.ammo;
    u.ammo = Infinity; // the MG has its own belt
    fireAt(w, u, d.mgRange, d.mgReload, d.mgAccuracy, true);
    if (u.cd > 0) u.aux = u.cd;
    u.cd = mgCd;
    u.ammo = ammo;
  }
  if (u.cd > 0 || u.ammo <= 0) return;
  const h0 = u.elev + CFG.sight.eye;
  const range = unitRange(w, 'tank', 0, u.level);
  const t = w.zomHash.nearest(w.x, w.y, u.x, u.y, range, 12, (i) => w.kind[i] === ZOMBIE && lineOfSight(w, u.x, u.y, h0, w.x[i], w.y[i]));
  if (t < 0) return;
  const tx = w.x[t];
  const ty = w.y[t];
  if (w.civHash.countInRadius(w.x, w.y, tx, ty, d.blast) > CFG.armour.tankCivilianRisk) return;
  u.cd = d.reload / levelRate(u);
  if (!w.infiniteAmmo) u.ammo--;
  u.aim = Math.atan2(ty - u.y, tx - u.x);
  w.effects.push({ kind: 'tracer', x: u.x, y: u.y, x2: tx, y2: ty, r: 3, t: 0, life: 0.3 });
  const before = w.stats.zombiesKilled;
  boom(w, tx, ty, d.blast, 'tank');
  u.kills += w.stats.zombiesKilled - before;
}

/** BMP drops its squad as a free hunting team. */
export function dropSquad(w: World, u: Unit): boolean {
  const d = CFG.units.bmp;
  if (u.type !== 'bmp' || u.aux > 0 || w.phase !== 'battle') return false;
  for (let k = 0; k < d.squad; k++) {
    const i = w.spawn(RECRUIT, u.x + w.rng.range(-3, 3), u.y + w.rng.range(-3, 3));
    if (i >= 0 && !w.grid.open(w.grid.idx(w.x[i], w.y[i]))) {
      w.x[i] = w.px[i] = u.x;
      w.y[i] = w.py[i] = u.y;
    }
  }
  w.stats.population += d.squad; // soldiers count as lives to save
  u.aux = d.squadCooldown;
  return true;
}

/** Picks the zombie cluster with the most zombies and acceptable civilian risk. */
function mortarTarget(w: World, u: Unit, blast: number): { x: number; y: number } | null {
  const def = CFG.units.mortar;
  const h = w.zomHash;
  const g = w.grid;
  const reach = Math.ceil(def.range / h.size);
  const bx = Math.floor(u.x / h.size);
  const by = Math.floor(u.y / h.size);
  let best: { x: number; y: number } | null = null;
  let bestN = 2; // never waste a shell on a lone zombie
  const cr = Math.ceil(blast / g.cell);
  for (let yy = Math.max(0, by - reach); yy <= Math.min(h.bh - 1, by + reach); yy++) {
    for (let xx = Math.max(0, bx - reach); xx <= Math.min(h.bw - 1, bx + reach); xx++) {
      const b = yy * h.bw + xx;
      if (h.start[b] === h.start[b + 1]) continue;
      const i = h.items[h.start[b]];
      const d = Math.hypot(w.x[i] - u.x, w.y[i] - u.y);
      if (d > def.range || d < def.rangeMin) continue;
      const c = g.idx(w.x[i], w.y[i]);
      let n = 0;
      for (let dy = -cr; dy <= cr; dy++)
        for (let dx = -cr; dx <= cr; dx++) {
          const cc = c + dy * g.w + dx;
          if (cc >= 0 && cc < w.crowd.length) n += w.crowd[cc];
        }
      if (n <= bestN) continue;
      const civ = w.civHash.countInRadius(w.x, w.y, w.x[i], w.y[i], blast);
      if (civ > n * CFG.mortarCivilianRatio) continue;
      bestN = n;
      best = { x: w.x[i], y: w.y[i] };
    }
  }
  return best;
}

function evacuate(w: World, u: Unit, dt: number): void {
  const rate = CFG.units.evac.rate * w.mods.evacRate * levelRate(u);
  u.acc = Math.min(u.acc + rate * dt, rate);
  w.civHash.forEachInRadius(w.x, w.y, u.x, u.y, CFG.units.evac.pickup, (i) => {
    if (u.acc < 1 || w.kind[i] !== CIV) return;
    u.acc -= 1;
    w.kind[i] = FREE;
    w.stats.evacuated++;
    u.kills++; // evac points count people taken out
    w.effects.push({ kind: 'evac', x: w.x[i], y: w.y[i], x2: u.x, y2: u.y, r: 0, t: 0, life: 1.2 });
  });
}

export function updateUnits(w: World, dt: number): void {
  const before = w.units.length;
  for (const u of w.units)
    if (u.hp <= 0 && u.type !== 'mines') {
      boomQuiet(w, u);
      w.notes.push({ k: 'lost', type: u.type });
    }
  w.units = w.units.filter((u) => u.hp > 0 && !(u.type === 'heli' && u.age > CFG.units.heli.duration));
  if (w.units.length !== before) {
    w.rebuildUnitAt();
    w.evacDirty = true;
  }

  // supply: evac points with no zombie at the gate refill magazines in their safe zone
  const depots = w.units.filter(
    (u) => u.type === 'evac' && w.zomHash.nearest(w.x, w.y, u.x, u.y, CFG.supply.breachRadius) < 0,
  );
  const zone2 = CFG.safeZone.radius ** 2;
  // a zone part is intact while no zombie stands inside it
  const intact = w.zoneParts.map((cells) => !cells.some((c) => w.crowd[c] > 0));
  intact.forEach((ok, p) => {
    if (!ok && w.zoneHeld[p] !== false) w.notes.push({ k: 'breach' });
    w.zoneHeld[p] = ok;
  });
  const g = w.grid;
  const suppliedByZone = (u: Unit) => {
    const c = g.idx(u.x, u.y);
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const p = w.zonePart[c + dy * g.w + dx];
        if (p >= 0 && intact[p]) return true;
      }
    return false;
  };
  for (const u of w.units) {
    const mag = magazineOf(u);
    if (!Number.isFinite(mag) || u.ammo >= mag) continue; // mines keep their own charges
    if (depots.some((d) => (d.x - u.x) ** 2 + (d.y - u.y) ** 2 < zone2) || suppliedByZone(u)) u.ammo = mag;
  }

  for (const u of w.units) {
    u.age += dt;
    u.cd -= dt;
    if (u.moving) {
      w.marchStep(u, dt);
      if (!CFG.moveFire[u.type]) continue; // only squads and armour shoot on the march
    }
    switch (u.type) {
      case 'tank':
        tankFire(w, u, dt);
        break;
      case 'bmp': {
        const d = CFG.units.bmp;
        u.aux -= dt;
        fireAt(w, u, unitRange(w, 'bmp', 0, u.level), d.reload, d.accuracy, true);
        break;
      }
      case 'sniper': {
        const d = CFG.units.sniper;
        fireAt(w, u, unitRange(w, 'sniper', u.elev, u.level), d.reload, d.accuracy, true);
        break;
      }
      case 'turret': {
        const d = CFG.units.turret;
        fireAt(w, u, unitRange(w, 'turret', 0, u.level), d.reload / w.mods.turretRate, d.accuracy, true);
        break;
      }
      case 'garrison': {
        const d = CFG.units.garrison;
        fireAt(w, u, unitRange(w, 'garrison', 0, u.level), d.reload, d.accuracy, true);
        break;
      }
      case 'heli': {
        const d = CFG.units.heli;
        const dx = u.tx - u.x;
        const dy = u.ty - u.y;
        const len = Math.hypot(dx, dy);
        const step = Math.min(len, d.speed * dt);
        if (len > 0.01) {
          u.x += (dx / len) * step;
          u.y += (dy / len) * step;
        }
        fireAt(w, u, d.range, d.reload, d.accuracy, false);
        break;
      }
      case 'mortar': {
        if (u.cd > 0 || u.ammo <= 0) break;
        const d = CFG.units.mortar;
        const blast = d.blast * w.mods.mortarBlast;
        const t = mortarTarget(w, u, blast);
        if (!t) {
          u.cd = 0.5; // re-scan soon
          break;
        }
        u.cd = d.reload / levelRate(u);
        if (!w.infiniteAmmo) u.ammo--;
        u.aim = Math.atan2(t.y - u.y, t.x - u.x);
        w.shells.push({ x: t.x, y: t.y, t: d.flight, r: blast, flight: d.flight, by: 'mortar', owner: u });
        w.sfx.push({ k: 'thump', x: u.x, y: u.y });
        w.effects.push({ kind: 'tracer', x: u.x, y: u.y, x2: u.x, y2: u.y, r: 0, t: 0, life: 0.2 });
        break;
      }
      case 'evac':
        evacuate(w, u, dt);
        break;
      case 'mines': {
        const d = CFG.units.mines;
        if (u.cd > 0) break;
        const z = w.zomHash.nearest(w.x, w.y, u.x, u.y, d.radius, 0, (i) => w.kind[i] === ZOMBIE);
        if (z < 0) break;
        u.cd = d.reload;
        const before = w.stats.zombiesKilled;
        boom(w, w.x[z], w.y[z], d.blast, 'mines');
        u.kills += w.stats.zombiesKilled - before;
        if (--u.ammo <= 0) u.hp = 0;
        break;
      }
      default:
        updateSpecialist(w, u, dt);
    }
  }

  for (const s of w.shells) {
    s.t -= dt;
    if (s.t > 0) continue;
    const before = w.stats.zombiesKilled;
    boom(w, s.x, s.y, s.r, s.by);
    if (s.owner) s.owner.kills += w.stats.zombiesKilled - before;
  }
  w.shells = w.shells.filter((s) => s.t > 0);

  const a = CFG.airstrike;
  for (const s of w.strikes) {
    s.t -= dt;
    while (s.t <= 0 && s.dropped < a.bombs) {
      const along = (s.dropped / (a.bombs - 1)) * a.length;
      boom(w, s.x + s.dx * along, s.y + s.dy * along, s.width / 2, 'airstrike');
      s.dropped++;
      s.t += a.interval;
    }
  }
  w.strikes = w.strikes.filter((s) => s.dropped < a.bombs);

  for (const e of w.effects) e.t += dt;
  w.effects = w.effects.filter((e) => e.t < e.life);
}

function boomQuiet(w: World, u: Unit): void {
  w.sfx.push({ k: 'boom', x: u.x, y: u.y });
  w.effects.push({ kind: 'boom', x: u.x, y: u.y, x2: u.x, y2: u.y, r: 6, t: 0, life: 0.6 });
}

/** Open cells closest to building cell c (its "doors"), searched in square rings. */
export function doorsOf(w: World, c: number, maxRing = DOOR_RING): number[] {
  const g = w.grid;
  const cx = c % g.w;
  const cy = Math.floor(c / g.w);
  for (let r = 1; r <= maxRing; r++) {
    const out: number[] = [];
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
        if (g.solid[y * g.w + x] === OPEN) out.push(y * g.w + x);
      }
    if (out.length) return out;
  }
  return [];
}

const DOOR_RING = 10; // cells: building units may sit up to ~40 m from a street

function nearStreet(w: World, c: number): boolean {
  return doorsOf(w, c).length > 0;
}

/**
 * Where a unit may stand: street units on open ground, building units in a
 * building facing a street, snipers on either (a roof gives height), building
 * specialisations only inside a safe zone.
 */
export function canPlace(w: World, type: UnitType, x: number, y: number): boolean {
  const g = w.grid;
  if (x < 0 || y < 0 || x >= w.widthM || y >= w.heightM) return false;
  const c = g.idx(x, y);
  if (inExclusion(w, x, y)) return false;
  if (type === 'heli') return true;
  const street = g.solid[c] === OPEN && g.barricade[c] <= 0;
  const building = g.solid[c] === BUILDING && nearStreet(w, c);
  if (SPECIALISTS.has(type)) return building && inSafeZone(w, x, y);
  if (STREET_ONLY.has(type)) return street;
  return street || building;
}

/** During planning nothing may be deployed inside an outbreak zone. */
export function inExclusion(w: World, x: number, y: number): boolean {
  if (w.phase !== 'planning') return false;
  const r = CFG.outbreak.exclusion;
  return w.outbreak.some((o) => (o.x - x) ** 2 + (o.y - y) ** 2 < r * r);
}

export function callAirstrike(w: World, x0: number, y0: number, x1: number, y1: number): boolean {
  const a = CFG.airstrike;
  if (w.phase !== 'battle' || w.budget < a.cost) return false;
  const len = Math.hypot(x1 - x0, y1 - y0) || 1;
  w.budget -= a.cost;
  w.sfx.push({ k: 'plane', x: x0, y: y0 });
  w.strikes.push({ x: x0, y: y0, dx: (x1 - x0) / len, dy: (y1 - y0) / len, t: a.delay, dropped: 0, width: a.width * w.mods.airstrikeWidth });
  return true;
}

/** Grid cells along a dragged line, clipped to `max` cells. */
export function barricadeCells(w: World, x0: number, y0: number, x1: number, y1: number, max: number = CFG.barricade.maxCells): number[] {
  const g = w.grid;
  const len = Math.hypot(x1 - x0, y1 - y0);
  const n = Math.max(1, Math.ceil(len / (g.cell * 0.5)));
  const out: number[] = [];
  const add = (c: number) => {
    if (g.solid[c] !== OPEN || g.barricade[c] > 0 || out.includes(c) || out.length >= max) return;
    out.push(c);
  };
  let prev = -1;
  for (let k = 0; k <= n; k++) {
    const px = x0 + ((x1 - x0) * k) / n;
    const py = y0 + ((y1 - y0) * k) / n;
    if (inExclusion(w, px, py)) continue;
    const c = g.idx(px, py);
    // keep the wall 4-connected so nothing slips through a diagonal gap
    if (prev >= 0 && c !== prev && (c % g.w) !== (prev % g.w) && Math.floor(c / g.w) !== Math.floor(prev / g.w))
      add(Math.floor(c / g.w) * g.w + (prev % g.w));
    add(c);
    prev = c;
  }
  return out;
}
