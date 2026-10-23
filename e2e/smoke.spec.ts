import { expect, test } from '@playwright/test';

test('menu → mission → deploy → outbreak runs without errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto('./');
  await page.click('[data-play="0"]');
  await expect(page.locator('#stats .title')).toHaveText('Ночь на Таймс-сквер');

  // the outbreak zone is closed during planning: a tap in its centre is refused
  await page.click('[data-tool="sniper"]');
  const box = (await page.locator('#top').boundingBox())!;
  await page.mouse.click(box.width / 2, box.height / 2);
  await expect(page.locator('#hint')).toContainText('зону очага');
  await expect(page.locator('#budget')).toHaveText('$2 400');

  await page.click('#btn-start');
  await page.click('[data-s="4"]');
  await page.waitForTimeout(4000);
  await expect(page.locator('#stats .phase')).toContainText('ВСПЫШКА');
  const zombies = Number((await page.locator('#stats .c-zom b').textContent())!.replace(/\D/g, ''));
  expect(zombies).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
