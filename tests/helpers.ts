import { Grid, BUILDING } from '../src/sim/grid';
import { World } from '../src/sim/world';

/** Open square arena of `size` metres with a solid border; optional building rects. */
export function arena(size = 200, rects: [number, number, number, number][] = []): World {
  const g = new Grid(size, size, 4);
  for (const [x0, y0, x1, y1] of rects) g.fillPolygon([x0, y0, x1, y0, x1, y1, x0, y1], BUILDING);
  g.sealUnreachable(2 * 4 + 2, 2 * 4 + 2);
  return new World(g, size, size, 5000, 42);
}

export function run(w: World, seconds: number, dt = 1 / 15): void {
  for (let t = 0; t < seconds; t += dt) w.tick(dt);
}
