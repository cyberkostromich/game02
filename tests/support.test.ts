import { describe, expect, it } from 'vitest';
import { BUILDING, Grid } from '../src/sim/grid';
import { canPlace, lineOfSight } from '../src/sim/units';
import { CIV, INFECTED, RECRUIT, World, ZOMBIE } from '../src/sim/world';
import { arena, run } from './helpers';

function town(): World {
  // a low block (10 m) between a tall tower (100 m) and the street beyond
  const g = new Grid(400, 200, 4);
  g.fillPolygon([40, 80, 80, 80, 80, 120, 40, 120], BUILDING, 0, 1, 100);
  g.fillPolygon([160, 60, 200, 60, 200, 140, 160, 140], BUILDING, 0, 1, 10);
  g.sealUnreachable(10, 10);
  return new World(g, 400, 200, 2000, 7);
}

describe('height and line of sight', () => {
  it('a rooftop sees over a low block, the street does not', () => {
    const w = town();
    expect(lineOfSight(w, 100, 100, 2, 300, 100)).toBe(false);
    expect(lineOfSight(w, 60, 100, 102, 300, 100)).toBe(true);
  });

  it('a rooftop sniper gets height and kills over the low block', () => {
    const w = town();
    expect(canPlace(w, 'sniper', 76, 100)).toBe(true);
    const u = w.addUnit('sniper', 76, 100);
    expect(u.elev).toBe(100);
    w.outbreak = [{ x: 300, y: 100, n: 1, infected: 0, r: 0 }];
    w.startBattle();
    run(w, 4);
    expect(w.stats.zombiesKilled).toBe(1);
  });
});

describe('safe zone specialisations', () => {
  it('only inside the safe zone of an evacuation point', () => {
    const w = arena(400, [[180, 180, 220, 220]]);
    expect(canPlace(w, 'medic', 182, 200)).toBe(false);
    w.addUnit('evac', 170, 170);
    expect(canPlace(w, 'medic', 182, 200)).toBe(true);
    expect(canPlace(w, 'medic', 100, 100)).toBe(false); // street, not a building
  });

  it('medic cures carriers nearby', () => {
    const w = arena(400, [[180, 180, 220, 220]]);
    w.addUnit('evac', 300, 300);
    w.addUnit('medic', 182, 200);
    const c = w.spawn(INFECTED, 172, 200);
    w.timer[c] = 30;
    w.startBattle();
    run(w, 2);
    expect(w.kind[c]).toBe(CIV);
    expect(w.stats.cured).toBe(1);
  });

  it('barracks arms civilians who then shoot zombies', () => {
    const w = arena(400, [[180, 180, 220, 220]]);
    w.addUnit('evac', 330, 200);
    w.addUnit('barracks', 182, 200);
    for (let k = 0; k < 10; k++) w.spawn(CIV, 176, 190 + k * 2);
    w.startBattle();
    w.spawn(ZOMBIE, 20, 380); // a far-off straggler keeps the battle going
    run(w, 25);
    expect(w.counts.recruit).toBeGreaterThanOrEqual(8);
    w.spawn(ZOMBIE, 150, 200);
    run(w, 10);
    expect(w.counts.zombie).toBeLessThanOrEqual(1);
    expect(w.stats.zombiesKilled).toBeGreaterThanOrEqual(1);
    expect(w.kind.filter((k) => k === RECRUIT).length).toBeGreaterThan(0);
  });
});
