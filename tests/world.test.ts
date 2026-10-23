import { describe, expect, it } from 'vitest';
import { CIV, INFECTED, ZOMBIE } from '../src/sim/world';
import { barricadeCells, callAirstrike, canPlace, lineOfSight } from '../src/sim/units';
import { arena, run } from './helpers';

describe('outbreak', () => {
  it('zombies bite civilians, who turn after incubation', () => {
    const w = arena();
    const c = w.spawn(CIV, 100, 100);
    w.startBattle();
    w.spawn(ZOMBIE, 101, 100);
    run(w, 0.5);
    expect(w.kind[c]).toBe(INFECTED);
    run(w, 10);
    expect(w.kind[c]).toBe(ZOMBIE);
    expect(w.stats.infected).toBe(1);
  });

  it('civilians flee from nearby zombies', () => {
    const w = arena(400);
    const c = w.spawn(CIV, 200, 200);
    w.outbreak = [{ x: 215, y: 200, n: 1, infected: 0, r: 0 }];
    w.startBattle();
    run(w, 1.5);
    expect(w.x[c]).toBeLessThan(198);
  });

  it('hidden carriers start among the crowd and turn later', () => {
    const w = arena(300);
    for (let k = 0; k < 50; k++) w.spawn(CIV, 140 + (k % 10) * 2, 140 + Math.floor(k / 10) * 2);
    w.outbreak = [{ x: 150, y: 150, n: 0, infected: 10, r: 40 }];
    w.startBattle();
    expect(w.stats.infected).toBe(10);
    run(w, 1 / 15);
    expect(w.counts.zombie).toBe(0);
    run(w, 40);
    expect(w.counts.zombie).toBeGreaterThanOrEqual(10);
  });

  it('nothing can be deployed in the outbreak zone before it starts', () => {
    const w = arena(500);
    w.outbreak = [{ x: 100, y: 100, n: 1, infected: 0, r: 0 }];
    expect(canPlace(w, 'sniper', 150, 100)).toBe(false);
    expect(canPlace(w, 'sniper', 400, 400)).toBe(true);
    expect(barricadeCells(w, 100, 120, 100, 160)).toEqual([]);
    w.startBattle();
    expect(canPlace(w, 'sniper', 150, 100)).toBe(true);
  });

  it('ends in victory when no zombies or infected remain', () => {
    const w = arena();
    w.populate(10);
    w.startBattle();
    w.tick(1 / 15);
    expect(w.phase).toBe('won');
  });
});

describe('defences', () => {
  it('a barricade holds zombies back until it breaks', () => {
    const w = arena(200);
    w.placeBarricade(barricadeCells(w, 100, 4, 100, 196).concat(barricadeCells(w, 100, 100, 100, 196)));
    // wall across the whole arena (two max-length segments may not be enough; fill the rest)
    for (let y = 4; y < 196; y += 4) w.placeBarricade([w.grid.idx(100, y)]);
    const civ = w.spawn(CIV, 150, 100);
    w.outbreak = [{ x: 40, y: 100, n: 20, infected: 0, r: 0 }];
    w.startBattle();
    run(w, 30);
    expect(w.kind[civ]).toBe(CIV);
    for (let i = 0; i < w.n; i++) if (w.kind[i] === ZOMBIE) expect(w.x[i]).toBeLessThan(100);
  });

  it('sniper kills a zombie in sight but not behind a building', () => {
    const w = arena(300, [[140, 0, 160, 260]]);
    // a long building between the sniper and the zombie
    w.addUnit('sniper', 60, 150);
    w.outbreak = [{ x: 250, y: 150, n: 1, infected: 0, r: 0 }];
    w.startBattle();
    expect(lineOfSight(w, 60, 150, 2, 250, 150)).toBe(false);
    run(w, 5);
    expect(w.counts.zombie).toBe(1);

    const w2 = arena(300);
    w2.addUnit('sniper', 60, 150);
    w2.outbreak = [{ x: 200, y: 150, n: 1, infected: 0, r: 0 }];
    w2.startBattle();
    run(w2, 5);
    expect(w2.stats.zombiesKilled).toBe(1);
  });

  it('evacuation station takes civilians off the map', () => {
    const w = arena(200);
    w.addUnit('evac', 100, 100);
    for (let k = 0; k < 20; k++) w.spawn(CIV, 60 + k, 150);
    w.stats.population = 20;
    w.outbreak = [{ x: 10, y: 10, n: 1, infected: 0, r: 0 }];
    w.startBattle();
    run(w, 40);
    expect(w.stats.evacuated).toBeGreaterThan(15);
  });

  it('airstrike costs budget and destroys everything along its line', () => {
    const w = arena(400);
    w.budget = 1000;
    w.outbreak = [{ x: 200, y: 200, n: 30, infected: 0, r: 0 }];
    const civ = w.spawn(CIV, 200, 205);
    w.startBattle();
    expect(callAirstrike(w, 100, 200, 300, 200)).toBe(true);
    expect(w.budget).toBe(500);
    run(w, 6);
    expect(w.stats.zombiesKilled).toBeGreaterThan(18);
    expect(w.kind[civ]).not.toBe(CIV); // collateral damage is real
  });

  it('garrison must sit in a building next to a street', () => {
    const w = arena(200, [[80, 80, 120, 120]]);
    expect(canPlace(w, 'garrison', 82, 100)).toBe(true);
    expect(canPlace(w, 'garrison', 50, 50)).toBe(false);
    expect(canPlace(w, 'turret', 50, 50)).toBe(true);
    expect(canPlace(w, 'turret', 100, 100)).toBe(false);
  });
});
