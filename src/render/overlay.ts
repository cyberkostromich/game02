import { CFG, type UnitType } from '../config';
import { unitRange, type Unit } from '../sim/units';
import type { World } from '../sim/world';
import type { Camera } from './camera';
import { LEAN } from './mapLayer';

export const UNIT_COLOR: Record<UnitType, string> = {
  medic: '#ff6b8a',
  repair: '#ffb347',
  barracks: '#9b8cff',
  sniper: '#5fb4ff',
  turret: '#4f8dff',
  mortar: '#8fa8ff',
  garrison: '#6fd0ff',
  evac: '#3fe0c8',
  heli: '#b8d4ff',
};

const MAX_SPLATS = 6000;

/** Below the agents: blood, barricades. */
export function drawGround(ctx: CanvasRenderingContext2D, w: World, cam: Camera, dpr: number): void {
  const z = cam.zoom * dpr;
  ctx.setTransform(z, 0, 0, z, dpr * (cam.vw / 2 - cam.x * cam.zoom), dpr * (cam.vh / 2 - cam.y * cam.zoom));
  if (w.splats.length > MAX_SPLATS) w.splats.splice(0, w.splats.length - MAX_SPLATS);
  const sz = Math.max(1.6, 2.5 / cam.zoom);
  ctx.fillStyle = 'rgba(90,150,40,0.45)';
  for (const s of w.splats) if (s.z) ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);
  ctx.fillStyle = 'rgba(150,20,20,0.55)';
  for (const s of w.splats) if (!s.z) ctx.fillRect(s.x - sz / 2, s.y - sz / 2, sz, sz);

  const g = w.grid;
  for (const c of w.barricadeCells) {
    const hp = g.barricade[c] / CFG.barricade.hp;
    ctx.fillStyle = `rgba(255,${Math.round(120 + 80 * hp)},60,${0.5 + 0.5 * hp})`;
    ctx.fillRect(g.cx(c) - g.cell / 2 + 0.3, g.cy(c) - g.cell / 2 + 0.3, g.cell - 0.6, g.cell - 0.6);
  }
}

function unitSize(cam: Camera): number {
  return Math.max(9, Math.min(22, cam.zoom * 5));
}

/** Screen position of a unit, lifted onto its roof in the 2.5D view. */
export function unitScreen(cam: Camera, u: Unit): [number, number] {
  const [sx, sy] = cam.toScreen(u.x, u.y);
  return [sx, sy - u.elev * LEAN * cam.zoom];
}

function drawUnit(ctx: CanvasRenderingContext2D, u: Unit, cam: Camera, time: number, selected: boolean): void {
  const [sx, sy] = unitScreen(cam, u);
  const s = unitSize(cam);
  const col = UNIT_COLOR[u.type];
  ctx.save();
  ctx.translate(sx, sy);
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#0a0d12';
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
      ctx.rotate(u.aim);
      ctx.fillRect(0, -1, s * 0.9, 2);
      break;
    case 'turret':
      ctx.fillRect(-s / 2, -s / 2, s, s);
      ctx.strokeRect(-s / 2, -s / 2, s, s);
      ctx.rotate(u.aim);
      ctx.fillStyle = '#dbe8ff';
      ctx.fillRect(0, -2, s * 0.85, 4);
      break;
    case 'mortar':
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0a0d12';
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.2, 0, Math.PI * 2);
      ctx.fill();
      break;
    case 'garrison':
      ctx.strokeStyle = col;
      ctx.lineWidth = 3;
      ctx.strokeRect(-s * 0.7, -s * 0.7, s * 1.4, s * 1.4);
      for (let k = 0; k < 4; k++) {
        ctx.fillRect(-s * 0.45 + (k % 2) * s * 0.6, -s * 0.45 + Math.floor(k / 2) * s * 0.6, s * 0.3, s * 0.3);
      }
      break;
    case 'evac': {
      ctx.beginPath();
      ctx.arc(0, 0, s * 0.65, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#06261f';
      ctx.fillRect(-s * 0.12, -s * 0.42, s * 0.24, s * 0.84);
      ctx.fillRect(-s * 0.42, -s * 0.12, s * 0.84, s * 0.24);
      break;
    }
    case 'medic':
    case 'repair':
    case 'barracks': {
      ctx.fillRect(-s * 0.65, -s * 0.65, s * 1.3, s * 1.3);
      ctx.strokeRect(-s * 0.65, -s * 0.65, s * 1.3, s * 1.3);
      ctx.fillStyle = '#10141a';
      ctx.font = `800 ${Math.round(s * 0.9)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(u.type === 'medic' ? '+' : u.type === 'repair' ? '⚒' : '★', 0, s * 0.05);
      break;
    }
    case 'heli': {
      ctx.rotate(u.aim);
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
  }
  ctx.restore();
  if (selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(sx - s, sy - s, s * 2, s * 2);
  }
  if (u.hp < u.maxHp && u.type !== 'heli') {
    const f = Math.max(0, u.hp / u.maxHp);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(sx - s * 0.8, sy - s - 6, s * 1.6, 4);
    ctx.fillStyle = f > 0.5 ? '#6be06b' : f > 0.25 ? '#e0c84f' : '#e05050';
    ctx.fillRect(sx - s * 0.8, sy - s - 6, s * 1.6 * f, 4);
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

export function rangeOf(w: World, type: UnitType, elev = 0): { r: number; rMin: number } {
  const u = CFG.units;
  if (type === 'evac') return { r: u.evac.radius, rMin: 0 };
  if (type === 'mortar') return { r: u.mortar.range, rMin: u.mortar.rangeMin };
  if (type === 'medic') return { r: u.medic.healRadius, rMin: u.medic.radius };
  if (type === 'repair') return { r: u.repair.radius, rMin: 0 };
  if (type === 'barracks') return { r: CFG.recruit.guard, rMin: u.barracks.radius };
  return { r: unitRange(w, type, elev), rMin: 0 };
}

/** Above the agents: units, shots, explosions, outbreak markers. */
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

  for (const e of w.effects) {
    const k = e.t / e.life;
    const [sx, sy] = cam.toScreen(e.x, e.y);
    if (e.kind === 'tracer') {
      const [ex, ey] = cam.toScreen(e.x2, e.y2);
      const lift = (e.h ?? 0) * LEAN * z;
      ctx.strokeStyle = `rgba(255,230,140,${0.9 * (1 - k)})`;
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
      ctx.fillStyle = `rgba(120,120,120,${0.25 * (1 - k)})`;
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
    // bomber silhouette sweeping along the run
    const p = s.dropped > 0 ? s.dropped / a.bombs : 0;
    const bx = x0 + (x1 - x0) * p;
    const by = y0 + (y1 - y0) * p;
    ctx.save();
    ctx.translate(bx, by);
    ctx.rotate(Math.atan2(s.dy, s.dx));
    ctx.fillStyle = '#d0d6e0';
    ctx.beginPath();
    ctx.moveTo(14, 0);
    ctx.lineTo(-8, -12);
    ctx.lineTo(-4, 0);
    ctx.lineTo(-8, 12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  for (const u of w.units) {
    if (u.type !== 'evac') continue;
    const [sx, sy] = cam.toScreen(u.x, u.y);
    ctx.strokeStyle = showSafe ? 'rgba(63,224,200,0.75)' : 'rgba(63,224,200,0.22)';
    ctx.fillStyle = showSafe ? 'rgba(63,224,200,0.08)' : 'rgba(63,224,200,0.025)';
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
      ctx.fillStyle = 'rgba(255,60,50,0.07)';
      ctx.strokeStyle = 'rgba(255,90,79,0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([8, 6]);
      ctx.beginPath();
      ctx.arc(sx, sy, CFG.outbreak.exclusion * z, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.setLineDash([]);
      const pulse = (now / 900) % 1;
      ctx.strokeStyle = `rgba(120,255,60,${1 - pulse})`;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(sx, sy, 10 + pulse * 40, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = '#7dff4a';
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = '700 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('ОЧАГ', sx, sy - 18);
    }
  }

  for (const u of w.units) drawUnit(ctx, u, cam, now / 1000, u.id === selectedId);
}
