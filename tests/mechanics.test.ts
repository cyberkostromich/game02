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
    expect(w.budget).toBe(before + 2); // bounty
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
    expect(near.ammo).toBe(30);
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
