import { CFG, type UpgradeId, type Upgrades } from './config';

// Campaign progress, kept in the browser only.
export interface Run {
  mission: string;
  date: string; // ISO day
  evacuated: number;
  savedPct: number;
  won: boolean;
  kills: number;
}

export interface Progress {
  stars: Record<string, number>;
  upgrades: Upgrades;
  best: Record<string, { evacuated: number; savedPct: number }>;
  runs: Run[]; // top runs by people evacuated
}

const TOP = 10;

const KEY = 'zombies-nyc-progress-v1';

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { stars: {}, upgrades: {}, best: {}, runs: [], ...JSON.parse(raw) };
  } catch {
    /* private mode or blocked storage: play without saving */
  }
  return { stars: {}, upgrades: {}, best: {}, runs: [] };
}

/** Records a finished run; returns which personal bests it beat. */
export function recordRun(p: Progress, run: Run): { evacuated: boolean; saved: boolean; place: number } {
  const prev = p.best[run.mission];
  const evacuated = !prev || run.evacuated > prev.evacuated;
  const saved = !prev || run.savedPct > prev.savedPct;
  p.best[run.mission] = {
    evacuated: Math.max(run.evacuated, prev?.evacuated ?? 0),
    savedPct: Math.max(run.savedPct, prev?.savedPct ?? 0),
  };
  p.runs.push(run);
  p.runs.sort((a, b) => b.evacuated - a.evacuated || b.savedPct - a.savedPct);
  p.runs = p.runs.slice(0, TOP);
  return { evacuated, saved, place: p.runs.indexOf(run) + 1 };
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
