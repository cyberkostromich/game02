import { CFG, type UpgradeId, type Upgrades } from './config';

// Campaign progress, kept in the browser only.
export interface Progress {
  stars: Record<string, number>;
  upgrades: Upgrades;
}

const KEY = 'zombies-nyc-progress-v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { stars: {}, upgrades: {}, ...JSON.parse(raw) };
  } catch {
    /* private mode or blocked storage: play without saving */
  }
  return { stars: {}, upgrades: {} };
}

export function saveProgress(p: Progress): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

/** Medals = stars earned minus stars already spent on upgrades. */
export function medals(p: Progress): number {
  const earned = Object.values(p.stars).reduce((a, b) => a + b, 0);
  const spent = Object.values(p.upgrades).reduce((a, lvl) => a + (lvl * (lvl + 1)) / 2, 0);
  return earned - spent;
}

export function upgradeCost(p: Progress, id: UpgradeId): number {
  return (p.upgrades[id] ?? 0) + 1;
}

export function canUpgrade(p: Progress, id: UpgradeId): boolean {
  return (p.upgrades[id] ?? 0) < CFG.upgrades[id].max && medals(p) >= upgradeCost(p, id);
}

export function starsFor(savedShare: number, won: boolean): number {
  if (!won) return 0;
  return CFG.stars.filter((t) => savedShare >= t).length;
}
