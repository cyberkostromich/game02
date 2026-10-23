import { expect, test, type Page } from '@playwright/test';

type Pt = { x: number; y: number };
const game = (page: Page) => page.evaluate.bind(page);

/** Screen point of a world point, lifted onto the roof if it is a building. */
async function screenOf(page: Page, p: Pt, roof = false): Promise<Pt> {
  const [x, y] = await page.evaluate(
    ({ p, roof }) => {
      const g = (window as any).__zf;
      const [sx, sy] = g.cam.toScreen(p.x, p.y);
      const h = roof ? Math.min(g.world.grid.height[g.world.grid.idx(p.x, p.y)], 300) : 0;
      return [sx, sy - h * 0.42 * g.cam.zoom];
    },
    { p, roof },
  );
  return { x, y };
}

/** A building cell and a street cell near the screen centre, away from the outbreak. */
async function spots(page: Page): Promise<{ bld: Pt; street: Pt; street2: Pt }> {
  return page.evaluate(() => {
    const g = (window as any).__zf;
    const w = g.world;
    const grid = w.grid;
    const [cx, cy] = g.cam.toWorld(g.cam.vw / 2, g.cam.vh / 3);
    const far = (x: number, y: number) => w.outbreak.every((o: Pt) => Math.hypot(o.x - x, o.y - y) > 200);
    let bld: Pt | null = null;
    let street: Pt | null = null;
    let street2: Pt | null = null;
    for (let r = 0; r < 600 && !(bld && street && street2); r += 4)
      for (let a = 0; a < 6.28; a += 0.2) {
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        const c = grid.idx(x, y);
        if (!far(x, y)) continue;
        if (!bld && grid.solid[c] === 1 && grid.height[c] > 10 && grid.height[c] < 40) bld = { x: grid.cx(c), y: grid.cy(c) };
        if (grid.solid[c] === 0) {
          if (!street) street = { x: grid.cx(c), y: grid.cy(c) };
          else if (!street2 && Math.hypot(street.x - x, street.y - y) > 60) street2 = { x: grid.cx(c), y: grid.cy(c) };
        }
      }
    return { bld: bld!, street: street!, street2: street2! };
  });
}

test.beforeEach(async ({ page }) => {
  await page.goto('./?mission=times-square');
  await page.waitForFunction(() => (window as any).__zf);
  await page.evaluate(() => {
    const c = (window as any).__zf.cam;
    c.zoom = 1.6;
    c.x -= 300;
    c.y -= 150;
  });
  await page.waitForTimeout(200);
});

test('assault squad goes into a building by tapping its roof, and on a street', async ({ page }) => {
  const s = await spots(page);
  await page.keyboard.press('2');
  const roof = await screenOf(page, s.bld, true);
  await page.mouse.click(roof.x, roof.y);
  const inBuilding = await game(page)(() => {
    const w = (window as any).__zf.world;
    const u = w.units.at(-1);
    return u && w.grid.solid[w.grid.idx(u.x, u.y)] === 1;
  });
  expect(inBuilding).toBe(true);
  const st = await screenOf(page, s.street);
  await page.mouse.click(st.x, st.y);
  expect(await game(page)(() => (window as any).__zf.world.units.length)).toBe(2);
});

test('a tank drives to a tapped street point', async ({ page }) => {
  const s = await spots(page);
  await page.keyboard.press('8');
  const a = await screenOf(page, s.street);
  await page.mouse.click(a.x, a.y);
  await page.keyboard.press('Escape');
  await page.click('#btn-start');
  const tank = await screenOf(page, s.street);
  await page.mouse.click(tank.x, tank.y); // select
  await expect(page.locator('#sel')).toContainText('Танк');
  const b = await screenOf(page, s.street2);
  await page.mouse.click(b.x, b.y); // move order
  expect(await game(page)(() => (window as any).__zf.world.units[0].moving)).toBe(true);
});

test('two overlapping safe zones merge and the overlap is not paid twice', async ({ page }) => {
  await page.keyboard.press('b');
  const box = (await page.locator('#top').boundingBox())!;
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x1, y1, { steps: 4 });
    await page.mouse.up();
  };
  const b0 = await game(page)(() => (window as any).__zf.world.budget);
  await drag(box.width * 0.2, box.height * 0.25, box.width * 0.32, box.height * 0.45);
  const b1 = await game(page)(() => (window as any).__zf.world.budget);
  await drag(box.width * 0.27, box.height * 0.35, box.width * 0.39, box.height * 0.55);
  const b2 = await game(page)(() => (window as any).__zf.world.budget);
  expect(await game(page)(() => (window as any).__zf.world.zoneParts.length)).toBe(1);
  expect(b0 - b1).toBeGreaterThan(b1 - b2); // second rectangle shares cells with the first
});

test('a finished run lands in the personal top', async ({ page }) => {
  await page.click('#btn-start');
  await page.evaluate(() => {
    const w = (window as any).__zf.world;
    w.stats.evacuated = 1234;
    w.phase = 'lost';
  });
  await expect(page.locator('#modal')).toContainText('новый рекорд эвакуации');
  await page.click('#r-menu');
  await expect(page.locator('#menu')).toContainText('Ваш топ');
  await expect(page.locator('#menu')).toContainText('1 234');
});
