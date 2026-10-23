import { CFG, type UnitType } from '../config';
import { magazineOf, unitRange, type Unit } from '../sim/units';
import type { World } from '../sim/world';
import type { Camera } from './camera';
import { LEAN } from './mapLayer';

// Palette after the original's look: combat units in magenta/pink, logistics
// in teal, safe zones in violet, zombies neon green.
export const UNIT_COLOR: Record<UnitType, string> = {
  sniper: '#ff5fb0',
  garrison: '#e0479e',
  turret: '#c04bd8',
  mortar: '#9b5cff',
  mines: '#f2c14e',
  evac: '#2fd1b8',
  medic: '#ff7a8f',
  repair: '#f29b4e',
  barracks: '#6aa8ff',
  heli: '#d8e4ff',
};
export const ZONE_FILL = 'rgba(126,92,255,0.22)';
export const ZONE_LINE = 'rgba(150,120,255,0.85)';

const MAX_SPLATS = 6000;

/** Below the agents: safe zones, spikes, barricades, blood. */
export function drawGround(ctx: CanvasRenderingContext2D, w: World, cam: Camera, dpr: number): void {
  ctx.setTransform(...cam.matrix(dpr));
  const g = w.grid;

  for (const z of w.zones) {
    ctx.fillStyle = ZONE_FILL;
    ctx.fillRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    ctx.strokeStyle = ZONE_LINE;
    ctx.lineWidth = 2 / cam.zoom;
    ctx.setLineDash([8 / cam.zoom, 5 / cam.zoom]);
    ctx.strokeRect(z.x0, z.y0, z.x1 - z.x0, z.y1 - z.y0);
    ctx.setLineDash([]);
  }

  if (w.splats.length > MAX_SPLATS) w.splats.splice(0, w.splats.length - MAX_SPLATS);
  const sz = Math.max(1.6, 2.5 / cam.zoom);
  ctx.fillStyle = 'rgba(90,170,40,0.4)';
  for (const s of w.splats) if (s.z) ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
  ctx.fillStyle = 'rgba(170,25,25,0.55)';
  for (const s of w.splats) if (!s.z) ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);

  ctx.fillStyle = 'rgba(190,190,200,0.55)';
  for (const c of w.spikeCells) {
    const x = g.cx(c);
    const y = g.cy(c);
    for (let k = -1; k <= 1; k++) ctx.fillRect(x + k * 1.2 - 0.3, y - 1.5, 0.6, 3);
  }

  for (const c of w.barricadeCells) {
    const hp = g.barricade[c] / CFG.barricade.hp;
    ctx.fillStyle = `rgba(255,${Math.round(120 + 80 * hp)},60,${0.55 + 0.45 * hp})`;
    ctx.fillRect(g.cx(c) - g.cell / 2 + 0.3, g.cy(c) - g.cell / 2 + 0.3, g.cell - 0.6, g.cell - 0.6);
  }
}

/** Screen position of a unit, lifted onto its roof in the 2.5D view. */
export function unitScreen(cam: Camera, u: Unit): [number, number] {
  const [sx, sy] = cam.toScreen(u.x, u.y);
  return [sx, sy - u.elev * LEAN * cam.zoom];
}

function unitSize(cam: Camera): number {
  return Math.max(9, Math.min(22, cam.zoom * 5));
}

function bar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, f: number, color: string): void {
  ctx.fillStyle = 'rgba(10,12,20,0.8)';
  ctx.fillRect(x, y, w, 4);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w * Math.max(0, Math.min(1, f)), 4);
}

function drawUnit(ctx: CanvasRenderingContext2D, u: Unit, cam: Camera, time: number, selected: boolean): void {
  const [sx, sy] = unitScreen(cam, u);
  const s = unitSize(cam);
  const col = UNIT_COLOR[u.type];
  ctx.save();
  ctx.translate(sx, sy);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#11131c';
  ctx.fillStyle = col;
  switch (u.type) {
    case 'sniper':
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.6);
      ctx.lineTo(s * 0.6, 0);
      ctx.lineTo(0, s * 0.6);
      ctx.lineTo(-s * 0.6, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.rotate(u.aim + cam.angle);
      ctx.fillRect(0, -1, s * 0.9, 2);
      break;
    case 'turret':
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.rotate(u.aim + cam.angle);
      ctx.fillStyle = '#f3e6ff';
      ctx.fillRect(0, -2, s * 0.85, 4);
      break;
    case 'mortar':
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#11131c';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'garrison':
      ctx.globalAlpha = 0.85;
      ctx.fillRect(-s * 0.75, -s * 0.75, s * 1.5, s * 1.5);
      ctx.globalAlpha = 1;
      ctx.strokeRect(-s * 0.75, -s * 0.75, s * 1.5, s * 1.5);
      ctx.fillStyle = '#ffe3f2';
      for (let k = 0; k < 4; k++) ctx.fillRect(-s * 0.45 + (k % 2) * s * 0.6, -s * 0.45 + Math.floor(k / 2) * s * 0.6, s * 0.3, s * 0.3);
      break;
    case 'mines':
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.arc(0, 0, Math.max(s * 0.7, CFG.units.mines.radius * cam.zoom), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        ctx.fillRect(Math.cos(a) * s * 0.4 - 1.5, Math.sin(a) * s * 0.4 - 1.5, 3, 3);
      }
      break;
    case 'evac':
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#06261f';
      ctx.fillRect(-s * 0.12, -s * 0.42, s * 0.24, s * 0.84);
      ctx.fillRect(-s * 0.42, -s * 0.12, s * 0.84, s * 0.24);
      break;
    case 'medic':
    case 'repair':
    case 'barracks':
      ctx.fillRect(-s * 0.65, -s * 0.65, s * 1.3, s * 1.3);
      ctx.strokeRect(-s * 0.65, -s * 0.65, s * 1.3, s * 1.3);
      ctx.fillStyle = '#11131c';
      ctx.font = `800 ${Math.round(s * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.type === 'medic' ? '+' : u.type === 'repair' ? '⚒' : '★', 0, s * 0.05);
      break;
    case 'heli':
      ctx.rotate(u.aim + cam.angle);
      ctx.fillRect(-s * 0.7, -s * 0.18, s * 1.3, s * 0.36);
      ctx.beginPath();
      ctx.ellipse(s * 0.2, 0, s * 0.45, s * 0.3, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.rotate(time * 25);
      ctx.strokeStyle = 'rgba(220,235,255,0.7)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-s, 0);
      ctx.lineTo(s, 0);
      ctx.moveTo(0, -s);
      ctx.lineTo(0, s);
      ctx.stroke();
      break;
  }
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx - s, sy - s, s * 2, s * 2);
  }
  for (let k = 1; k < u.level; k++) {
    ctx.fillStyle = '#f2c14e';
    ctx.fillRect(sx + s * 0.6 + 1, sy - s * 0.6 + (k - 1) * 5, 4, 4);
  }
  let by = sy - s - 7;
  if (u.hp < u.maxHp && u.type !== 'heli' && u.type !== 'mines') {
    const f = u.hp / u.maxHp;
    bar(ctx, sx - s * 0.8, by, s * 1.6, f, f > 0.5 ? '#6be06b' : f > 0.25 ? '#e0c84f' : '#e05050');
    by -= 5;
  }
  const mag = magazineOf(u);
  if (Number.isFinite(mag) && u.ammo < mag) {
    bar(ctx, sx - s * 0.8, by, s * 1.6, u.ammo / mag, '#f2c14e');
    if (u.ammo <= 0) {
      ctx.fillStyle = '#ff5a4f';
      ctx.font = '700 11px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('НЕТ ПАТРОНОВ', sx, by - 6);
    }
  }
}

export function drawRange(ctx: CanvasRenderingContext2D, cam: Camera, x: number, y: number, r: number, color: string, rMin = 0): void {
  const [sx, sy] = cam.toScreen(x, y);
  ctx.strokeStyle = color;
  ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.06)');
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.arc(sx, sy, r * cam.zoom, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  if (rMin > 0) {
    ctx.beginPath();
    ctx.arc(sx, sy, rMin * cam.zoom, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

export function rangeOf(w: World, type: UnitType, elev = 0, level = 1): { r: number; rMin: number } {
  const u = CFG.units;
  if (type === 'evac') return { r: u.evac.radius, rMin: 0 };
  if (type === 'mortar') return { r: u.mortar.range, rMin: u.mortar.rangeMin };
  if (type === 'medic') return { r: u.medic.healRadius, rMin: u.medic.radius };
  if (type === 'repair') return { r: u.repair.radius, rMin: 0 };
  if (type === 'barracks') return { r: CFG.recruit.guard, rMin: u.barracks.radius };
  if (type === 'mines') return { r: u.mines.radius, rMin: 0 };
  return { r: unitRange(w, type, elev, level), rMin: 0 };
}

/** Above the agents: units, shots, explosions, clouds, outbreak markers. */
export function drawTop(
  ctx: CanvasRenderingContext2D,
  w: World,
  cam: Camera,
  dpr: number,
  now: number,
  selectedId: number,
  showSafe: boolean,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const z = cam.zoom;

  for (const c of w.clouds) {
    const [sx, sy] = cam.toScreen(c.x, c.y);
    const r = Math.max(4, c.r * z);
    ctx.fillStyle =
      c.kind === 'gas'
        ? `rgba(200,230,90,${0.14 + 0.06 * Math.sin(now / 300 + c.x)})`
        : `rgba(255,${120 + Math.round(60 * Math.random())},40,${0.28 + 0.12 * Math.random()})`;
    ctx.beginPath();
    ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const e of w.effects) {
    const k = e.t / e.life;
    const [sx, sy] = cam.toScreen(e.x, e.y);
    if (e.kind === 'tracer') {
      const [ex, ey] = cam.toScreen(e.x2, e.y2);
      const lift = (e.h ?? 0) * LEAN * z;
      ctx.strokeStyle = `rgba(255,236,160,${0.9 * (1 - k)})`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(sx, sy - lift);
      ctx.lineTo(ex, ey);
      ctx.stroke();
    } else if (e.kind === 'boom') {
      ctx.fillStyle = `rgba(255,${Math.round(200 - 120 * k)},60,${0.85 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(3, e.r * z * (0.5 + k)), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.fillStyle = `rgba(90,90,96,${0.3 * (1 - k)})`;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(4, e.r * z * (0.8 + k * 0.6)), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  for (const s of w.shells) {
    const [sx, sy] = cam.toScreen(s.x, s.y);
    ctx.strokeStyle = 'rgba(255,90,60,0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy, Math.max(4, s.r * z * (0.4 + s.t / s.flight)), 0, Math.PI * 2);
    ctx.stroke();
  }

  for (const d of w.drops) {
    const [sx, sy] = cam.toScreen(d.x, d.y);
    const lift = d.t * 6;
    ctx.strokeStyle = '#d8e4ff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(sx, sy - 14 - lift, 8, Math.PI, 0);
    ctx.moveTo(sx - 8, sy - 14 - lift);
    ctx.lineTo(sx, sy - lift);
    ctx.lineTo(sx + 8, sy - 14 - lift);
    ctx.stroke();
  }

  const a = CFG.airstrike;
  for (const s of w.strikes) {
    const [x0, y0] = cam.toScreen(s.x, s.y);
    const [x1, y1] = cam.toScreen(s.x + s.dx * a.length, s.y + s.dy * a.length);
    ctx.strokeStyle = 'rgba(255,60,60,0.55)';
    ctx.lineWidth = Math.max(3, s.width * z);
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    const p = s.dropped > 0 ? s.dropped / a.bombs : 0;
    ctx.save();
    ctx.translate(x0 + (x1 - x0) * p, y0 + (y1 - y0) * p);
    ctx.rotate(Math.atan2(y1 - y0, x1 - x0));
    ctx.fillStyle = '#f2a33a';
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-8, -14);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, 14);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (const u of w.units) {
    if (u.type !== 'evac') continue;
    const [sx, sy] = cam.toScreen(u.x, u.y);
    ctx.strokeStyle = showSafe ? ZONE_LINE : 'rgba(150,120,255,0.3)';
    ctx.fillStyle = showSafe ? 'rgba(126,92,255,0.1)' : 'rgba(126,92,255,0.035)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 6]);
    ctx.beginPath();
    ctx.arc(sx, sy, CFG.safeZone.radius * z, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
  }

  if (w.phase === 'planning') {
    for (const o of w.outbreak) {
      const [sx, sy] = cam.toScreen(o.x, o.y);
      ctx.fillStyle = 'rgba(125,255,90,0.07)';
      ctx.strokeStyle = 'rgba(125,255,90,0.6)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, CFG.outbreak.exclusion * z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const pulse = (now / 900) % 1;
      ctx.strokeStyle = `rgba(125,255,90,${1 - pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, 10 + pulse * 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#7dff5a';
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '700 12px "IBM Plex Mono", monospace';
      ctx.textAlign = 'center';
      ctx.fillText('ОЧАГ', sx, sy - 22);
    }
  }

  for (const u of w.units) drawUnit(ctx, u, cam, now / 1000, u.id === selectedId);
}
