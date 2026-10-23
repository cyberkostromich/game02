import { describe, expect, it } from 'vitest';
import { useAbility } from '../src/sim/abilities';
import { canPlace, levelUp, levelUpCost } from '../src/sim/units';
import { CIV, RECRUIT, ZOMBIE } from '../src/sim/world';
import { arena, run } from './helpers';

describe('zombie toughness', () => {
  it('a zombie with 2 HP survives the first hit', () => {
    const w = arena();
    w.zombieHp = 2;
    w.startBattle();
    const z = w.spawn(ZOMBIE, 100, 100);
    expect(w.hit(z, 'test')).toBe(false);
    expect(w.kind[z]).toBe(ZOMBIE);
    const before = w.budget;
    expect(w.hit(z, 'test')).toBe(true);
    expect(w.killsBy.test).toBe(1);
    expect(w.budget).toBe(before + 5); // bounty
  });
});

describe('unit levels and supply', () => {
  it('level-up costs money and raises hp', () => {
    const w = arena();
    w.budget = 1000;
    const u = w.addUnit('turret', 50, 50);
    const cost = levelUpCost(u);
    expect(levelUp(w, u)).toBe(true);
    expect(w.budget).toBe(1000 - cost);
    expect(u.level).toBe(2);
    expect(u.maxHp).toBeGreaterThan(240);
  });

  it('a unit outside any safe zone runs dry, inside one it is resupplied', () => {
    const w = arena(400);
    const far = w.addUnit('sniper', 50, 50);
    const near = w.addUnit('sniper', 300, 300);
    w.addUnit('evac', 320, 320);
    far.ammo = near.ammo = 0;
    w.startBattle();
    w.spawn(ZOMBIE, 60, 200); // keep the battle running
    run(w, 0.2);
    expect(far.ammo).toBe(0);
    expect(near.ammo).toBe(40);
  });
});

describe('traps', () => {
  it('a minefield blows up zombies that walk in and spends charges', () => {
    const w = arena(300);
    const m = w.addUnit('mines', 150, 150);
    expect(canPlace(w, 'mines', 150, 160)).toBe(true);
    w.startBattle();
    w.spawn(ZOMBIE, 152, 150);
    w.spawn(ZOMBIE, 20, 20);
    run(w, 1);
    expect(w.killsBy.mines).toBeGreaterThanOrEqual(1);
    expect(m.ammo).toBeLessThan(12);
  });

  it('spikes slow zombies down', () => {
    const run1 = (spikes: boolean) => {
      const w = arena(400);
      if (spikes) for (let x = 100; x < 300; x += 4) w.placeSpikes([w.grid.idx(x, 200)]);
      w.startBattle();
      const z = w.spawn(ZOMBIE, 100, 200);
      w.speed[z] = 2;
      w.heading[z] = 0;
      w.zhp[z] = 255; // survive the spikes for the test
      w.spawn(CIV, 230, 200);
      run(w, 5);
      return w.x[z];
    };
    expect(run1(true)).toBeLessThan(run1(false));
  });
});

describe('abilities', () => {
  it('gas freezes zombies in the cloud', () => {
    const w = arena(400);
    w.budget = 1000;
    const c = w.spawn(CIV, 200, 200);
    w.startBattle();
    const z = w.spawn(ZOMBIE, 203, 200);
    expect(useAbility(w, 'gas', 200, 200)).toBe(true);
    expect(useAbility(w, 'gas', 200, 200)).toBe(false); // cooldown
    const x0 = w.x[z];
    run(w, 3);
    expect(w.x[z]).toBe(x0);
    expect(w.kind[c]).toBe(CIV);
  });

  it('paratroopers land and hunt zombies; call to arms arms the crowd', () => {
    const w = arena(400);
    w.budget = 2000;
    for (let k = 0; k < 20; k++) w.spawn(CIV, 300 + (k % 5) * 2, 300 + Math.floor(k / 5) * 2);
    w.startBattle();
    for (let k = 0; k < 5; k++) w.spawn(ZOMBIE, 100 + k * 3, 100);
    w.tick(0.1);
    expect(useAbility(w, 'para', 160, 100)).toBe(true);
    expect(useAbility(w, 'arms', 304, 303)).toBe(true);
    expect(w.kind.filter((k) => k === RECRUIT).length).toBe(20);
    run(w, 30);
    expect(w.stats.zombiesKilled).toBe(5);
  });

  it('fire burns a strip', () => {
    const w = arena(400);
    w.budget = 1000;
    w.startBattle();
    for (let k = 0; k < 10; k++) w.spawn(ZOMBIE, 150 + k * 8, 200);
    w.spawn(ZOMBIE, 20, 380);
    useAbility(w, 'fire', 140, 200, 300, 200);
    run(w, 4);
    expect(w.killsBy.fire).toBeGreaterThanOrEqual(6);
  });
});

describe('moving units', () => {
  it('a sniper marches around a building and climbs onto a roof', async () => {
    const { BUILDING } = await import('../src/sim/grid');
    const w = arena(300, [[120, 0, 160, 220]]); // a long block between start and goal
    for (let i = 0; i < w.grid.solid.length; i++) if (w.grid.solid[i] === BUILDING) w.grid.height[i] = 60;
    const u = w.addUnit('sniper', 60, 60);
    w.startBattle();
    w.spawn(ZOMBIE, 290, 290); // keep the battle going
    expect(w.orderMove(u, 150, 100)).toBe(true); // into the building -> its roof
    run(w, 200); // ~400 m around the block at 3 m/s
    expect(u.moving).toBe(false);
    expect(u.elev).toBe(60);
    expect(Math.hypot(u.x - 150, u.y - 100)).toBeLessThan(1);
  });

  it('turrets cannot be ordered into a building', () => {
    const w = arena(200, [[80, 80, 120, 120]]);
    const u = w.addUnit('mines', 30, 30);
    expect(w.orderMove(u, 50, 50)).toBe(false); // not movable
  });
});

describe('merged safe zones', () => {
  it('overlapping rectangles merge into one zone and overlap is free', async () => {
    const { zoneCost } = await import('../src/sim/support');
    const w = arena(400);
    const a = { x0: 40, y0: 40, x1: 140, y1: 140 };
    const b = { x0: 100, y0: 100, x1: 200, y1: 200 };
    const full = zoneCost(w, b);
    w.addZone(a, zoneCost(w, a));
    expect(zoneCost(w, b)).toBeLessThan(full); // the shared corner is already paid for
    w.addZone(b, zoneCost(w, b));
    expect(w.zoneParts.length).toBe(1);
    w.addZone({ x0: 300, y0: 300, x1: 360, y1: 360 });
    expect(w.zoneParts.length).toBe(2);
  });

  it('civilians shelter inside and units there are resupplied while it holds', () => {
    const w = arena(400);
    w.addZone({ x0: 200, y0: 200, x1: 300, y1: 300 });
    const civ = w.spawn(CIV, 150, 250);
    const u = w.addUnit('turret', 280, 280);
    u.ammo = 0;
    w.startBattle();
    w.spawn(ZOMBIE, 20, 20);
    run(w, 30);
    expect(w.zoneMask[w.grid.idx(w.x[civ], w.y[civ])]).toBe(1);
    expect(u.ammo).toBe(400);
  });
});

describe('armour', () => {
  it('a tank crushes zombies in its path', () => {
    const w = arena(400);
    const t = w.addUnit('tank', 40, 200);
    w.startBattle();
    for (let k = 0; k < 8; k++) w.spawn(ZOMBIE, 120 + k * 10, 200);
    w.speed.fill(0); // zombies stand still for the test
    expect(w.orderMove(t, 340, 200)).toBe(true);
    run(w, 80);
    expect(w.killsBy.tank).toBeGreaterThanOrEqual(6);
  });

  it('the tank holds its main gun when civilians are in the blast', () => {
    const w = arena(400);
    const t = w.addUnit('tank', 100, 200);
    w.startBattle();
    for (let k = 0; k < 5; k++) w.spawn(CIV, 180 + k, 202);
    const z = w.spawn(ZOMBIE, 182, 200);
    w.speed[z] = 0;
    w.tick(0.1);
    expect(t.ammo).toBe(40); // no shell fired
  });

  it('a BMP drops a hunting squad once per cooldown', async () => {
    const { dropSquad } = await import('../src/sim/units');
    const w = arena(400);
    const b = w.addUnit('bmp', 100, 100);
    w.startBattle();
    w.spawn(ZOMBIE, 300, 300);
    expect(dropSquad(w, b)).toBe(true);
    expect(dropSquad(w, b)).toBe(false);
    run(w, 0.1);
    expect(w.counts.recruit).toBe(6);
  });
});

describe('personal top', () => {
  it('keeps the best runs by people evacuated and flags records', async () => {
    const { recordRun } = await import('../src/progress');
    const p: import('../src/progress').Progress = { stars: {}, upgrades: {}, best: {}, runs: [], infiniteAmmo: false };
    const run = (ev: number) => ({ mission: 'm', date: '2026-10-23', evacuated: ev, savedPct: 50, won: true, kills: 1 });
    expect(recordRun(p, run(100)).evacuated).toBe(true);
    expect(recordRun(p, run(50)).evacuated).toBe(false);
    const r = recordRun(p, run(300));
    expect(r.evacuated).toBe(true);
    expect(r.place).toBe(1);
    for (let k = 0; k < 20; k++) recordRun(p, run(k));
    expect(p.runs.length).toBe(10);
    expect(p.best.m.evacuated).toBe(300);
  });
});

describe('round 3 fixes', () => {
  it('a BMP crushes zombies it drives over', () => {
    const w = arena(400);
    const b = w.addUnit('bmp', 40, 200);
    w.startBattle();
    for (let k = 0; k < 6; k++) w.spawn(ZOMBIE, 140 + k * 12, 200);
    w.speed.fill(0);
    b.ammo = 0; // no shooting: only the wheels can kill
    w.infiniteAmmo = false;
    expect(w.orderMove(b, 340, 200)).toBe(true);
    run(w, 60);
    expect(w.killsBy.bmp).toBeGreaterThanOrEqual(4);
  });

  it('assault squads shoot on the march but slower; snipers do not', () => {
    const fire = (type: 'garrison' | 'sniper') => {
      const w = arena(400);
      const u = w.addUnit(type, 40, 100);
      w.startBattle();
      for (let k = 0; k < 30; k++) w.spawn(ZOMBIE, 60 + k * 2, 150);
      w.speed.fill(0);
      w.orderMove(u, 360, 100);
      run(w, 5);
      return u.kills;
    };
    expect(fire('garrison')).toBeGreaterThan(0);
    expect(fire('sniper')).toBe(0);
  });

  it('people walk into a safe zone first, then on to the evac point inside it', () => {
    const w = arena(600);
    w.addZone({ x0: 300, y0: 260, x1: 420, y1: 360 });
    w.addUnit('evac', 400, 340);
    for (let k = 0; k < 20; k++) w.spawn(CIV, 80 + k, 100); // 300+ m away, outside the evac radius
    w.stats.population = 20;
    w.startBattle();
    w.spawn(ZOMBIE, 580, 580);
    run(w, 300); // ~300 m on foot, then the queue at the evac point
    expect(w.stats.evacuated).toBeGreaterThan(15);
  });

  it('infinite ammo mode never empties a magazine', () => {
    const w = arena(300);
    w.infiniteAmmo = true;
    const u = w.addUnit('sniper', 50, 150);
    w.startBattle();
    for (let k = 0; k < 5; k++) w.spawn(ZOMBIE, 200 + k * 3, 150);
    run(w, 6);
    expect(u.kills).toBeGreaterThan(0);
    expect(u.ammo).toBe(40);
  });
});

describe('review regressions', () => {
  it('mines inside a safe zone keep finite charges', () => {
    const w = arena(300);
    w.addZone({ x0: 100, y0: 100, x1: 200, y1: 200 });
    const m = w.addUnit('mines', 150, 150);
    m.ammo = 3;
    w.startBattle();
    w.spawn(ZOMBIE, 20, 20);
    run(w, 1);
    expect(m.ammo).toBe(3);
  });

  it('a failed new order does not freeze a marching unit', () => {
    const w = arena(400);
    const u = w.addUnit('sniper', 40, 40);
    w.startBattle();
    w.spawn(ZOMBIE, 390, 390);
    expect(w.orderMove(u, 300, 40)).toBe(true);
    expect(w.orderMove(u, 2, 2)).toBe(false); // solid map edge
    const x0 = u.x;
    run(w, 5);
    expect(u.x).toBeGreaterThan(x0 + 5);
  });

  it('a street shooter beside a building cannot see through it', async () => {
    const { lineOfSight } = await import('../src/sim/units');
    const w = arena(300, [[120, 0, 180, 260]]);
    expect(lineOfSight(w, 118, 100, 2, 240, 100)).toBe(false);
  });

  it('the zombie census never underflows when people turn', () => {
    const w = arena(200);
    for (let k = 0; k < 30; k++) w.spawn(CIV, 90 + (k % 6) * 2, 90 + Math.floor(k / 6) * 2);
    w.outbreak = [{ x: 100, y: 100, n: 2, infected: 20, r: 30 }];
    w.startBattle();
    for (let t = 0; t < 400; t++) {
      w.tick(0.1);
      expect(Math.max(...w.crowd)).toBeLessThan(1000);
    }
  });
});

describe('stragglers', () => {
  it('groups the last zombies so the player can find them', async () => {
    const { stragglers } = await import('../src/render/overlay');
    const w = arena(800);
    w.startBattle();
    w.spawn(ZOMBIE, 100, 100);
    w.spawn(ZOMBIE, 110, 105);
    w.spawn(ZOMBIE, 700, 700);
    w.recount();
    const g = stragglers(w).sort((a, b) => b.n - a.n);
    expect(g.map((q) => q.n)).toEqual([2, 1]);
  });
});
