import { describe, expect, it } from 'vitest';
import { BUILDING, Grid, OPEN, SOLID } from '../src/sim/grid';
import { FieldSolver, INF } from '../src/sim/field';

describe('Grid', () => {
  it('rasterises a polygon into cells', () => {
    const g = new Grid(40, 40, 4);
    g.fillPolygon([8, 8, 24, 8, 24, 24, 8, 24], BUILDING);
    expect(g.solid[g.idx(16, 16)]).toBe(BUILDING);
    expect(g.solid[g.idx(30, 30)]).toBe(OPEN);
  });

  it('seals the edge and pockets not connected to the seed', () => {
    const g = new Grid(80, 80, 4);
    // a closed ring of buildings with a courtyard inside
    g.fillPolygon([40, 40, 72, 40, 72, 44, 40, 44], BUILDING);
    g.fillPolygon([40, 68, 72, 68, 72, 72, 40, 72], BUILDING);
    g.fillPolygon([40, 40, 44, 40, 44, 72, 40, 72], BUILDING);
    g.fillPolygon([68, 40, 72, 40, 72, 72, 68, 72], BUILDING);
    g.sealUnreachable(10, 10);
    expect(g.solid[0]).toBe(SOLID);
    expect(g.solid[g.idx(56, 56)]).toBe(BUILDING); // courtyard sealed
    expect(g.solid[g.idx(10, 10)]).toBe(OPEN);
  });
});

describe('FieldSolver', () => {
  it('measures distance in half-cells and detours around walls', () => {
    const g = new Grid(80, 80, 4);
    g.fillPolygon([36, 0, 44, 0, 44, 64, 36, 64], BUILDING); // wall with a gap at the bottom
    g.sealUnreachable(10, 10);
    const f = new Uint16Array(g.w * g.h);
    new FieldSolver(g).solve([g.idx(10, 10)], 1, f);
    expect(f[g.idx(10, 10)]).toBe(0);
    expect(f[g.idx(18, 10)]).toBe(4); // two cells east
    // straight line through the wall would be ~16 cells; the detour is longer
    expect(f[g.idx(70, 10)]).toBeGreaterThan(40);
    expect(f[g.idx(40, 20)]).toBe(INF); // inside the wall
  });

  it('charges extra for barricades and respects the cap', () => {
    const g = new Grid(80, 40, 4);
    g.sealUnreachable(10, 10);
    for (let y = 0; y < 40; y += 4) g.barricade[g.idx(40, y)] = 100;
    const s = new FieldSolver(g);
    const f = new Uint16Array(g.w * g.h);
    s.solve([g.idx(10, 20)], 1, f, { barricadeCost: 60 });
    expect(f[g.idx(60, 20)]).toBeGreaterThan(60);
    s.solve([g.idx(10, 20)], 1, f, { cap: 10 });
    expect(f[g.idx(60, 20)]).toBe(INF);
  });
});
