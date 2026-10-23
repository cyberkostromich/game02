import { Sound } from './audio';
import { CFG, type UnitType, type Upgrades } from './config';
import { attachInput } from './input';
import { landmark, type Mission } from './missions';
import { starsFor } from './progress';
import { AgentRenderer } from './render/agents';
import { Camera } from './render/camera';
import { LEAN, MapLayer, MAX_VISUAL_H } from './render/mapLayer';
import { drawGround, drawRange, drawTop, rangeOf, stragglers, UNIT_COLOR, unitScreen, ZONE_FILL, ZONE_LINE } from './render/overlay';
import { abilityReady, useAbility } from './sim/abilities';
import { BUILDING, type Grid, type MapData } from './sim/grid';
import { zoneCost, zoneFromDrag } from './sim/support';
import {
  barricadeCells,
  callAirstrike,
  canLevelUp,
  canPlace,
  dropSquad,
  inExclusion,
  levelUp,
  levelUpCost,
  magazineOf,
  MOVABLE,
  SPECIALISTS,
  type Unit,
} from './sim/units';
import { modsFrom, World } from './sim/world';
import { ALL_TOOLS, costLabel, GROUPS, isAbility, isUnit, LINE_TOOLS, toolColor, toolCost, type Tool } from './tools';

const STEP = 1 / CFG.sim.hz;
const MAX_TICKS_PER_FRAME = 10;
const SIM_BUDGET_MS = 12;
const sound = new Sound();

function placeError(t: UnitType): string {
  if (SPECIALISTS.has(t)) return 'Нужно здание у улицы внутри safe zone';
  if (t === 'tank' || t === 'bmp' || t === 'evac' || t === 'mines') return 'Сюда нельзя: нужна открытая улица';
  return 'Нужна улица или здание не дальше ~40 м от улицы';
}

export interface GameResult {
  won: boolean;
  stars: number;
  saved: number;
  population: number;
}

export class Game {
  readonly world: World;
  private cam = new Camera();
  private mapLayer: MapLayer;
  private agents: AgentRenderer;
  private mapCanvas: HTMLCanvasElement;
  private topCanvas: HTMLCanvasElement;
  private mapCtx: CanvasRenderingContext2D;
  private topCtx: CanvasRenderingContext2D;
  private mapCache = document.createElement('canvas');
  private mapCacheKey = '';
  private dpr = 1;
  private tool: Tool | null = null;
  private group: (typeof GROUPS)[number]['id'] = 'deploy';
  private openGroup: (typeof GROUPS)[number]['id'] | null = null;
  private glide = { x: 0, y: 0 }; // camera inertia after a pan, px/s
  private selected: Unit | null = null;
  private hoverPt: { x: number; y: number } | null = null;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private speed = 1;
  private acc = 0;
  private last = 0;
  private hudT = 0;
  private raf = 0;
  private ended = false;
  private flashUntil = 0;
  private el = (id: string) => document.getElementById(id)!;

  constructor(
    map: MapData,
    grid: Grid,
    private readonly mission: Mission,
    upgrades: Upgrades,
    infiniteAmmo: boolean,
    private readonly onEnd: (r: GameResult) => void,
    private readonly onQuit: () => void,
  ) {
    grid.barricade.fill(0);
    this.world = new World(grid, map.width, map.height, Math.ceil(mission.population * 1.4) + 4000, mission.seed, modsFrom(upgrades));
    const w = this.world;
    w.zombieHp = mission.zombieHp ?? 1;
    w.infiniteAmmo = infiniteAmmo;
    w.populate(mission.population - (mission.crowds ?? []).reduce((a, c) => a + c.n, 0));
    for (const c of mission.crowds ?? []) {
      const p = landmark(map, c.at);
      w.populateNear(p.x, p.y, c.r, c.n);
    }
    w.outbreak = mission.outbreak.map((o) => {
      const p = landmark(map, o.at);
      return { ...grid.nearestOpen(p.x, p.y), n: o.n, infected: o.infected, r: o.r };
    });
    w.budget = Math.round(mission.budget * (1 + (upgrades.budget ?? 0) * CFG.upgrades.budget.step));

    this.mapLayer = new MapLayer(map);
    this.mapCanvas = this.el('map') as HTMLCanvasElement;
    this.topCanvas = this.el('top') as HTMLCanvasElement;
    this.mapCtx = this.mapCanvas.getContext('2d')!;
    this.topCtx = this.topCanvas.getContext('2d')!;
    this.agents = AgentRenderer.for(this.el('agents') as HTMLCanvasElement);

    this.resize();
    this.cam.fit(map.width, map.height);
    const o = w.outbreak[0];
    this.cam.x = o.x;
    this.cam.y = o.y;
    this.cam.zoom = Math.max(this.cam.zoom, Math.min(1.1, this.cam.vw / 700));

    this.buildHud();
    attachInput(this.topCanvas, this.cam, {
      wantsLine: () => this.tool !== null && LINE_TOOLS.has(this.tool),
      tap: (x, y, sx, sy) => this.tap(x, y, sx, sy),
      line: (x0, y0, x1, y1, done) => this.line(x0, y0, x1, y1, done),
      hover: (x, y) => (this.hoverPt = { x, y }),
      cameraMoved: () => this.cam.clamp(map.width, map.height),
      rotate: (d) => this.rotate(d),
      fling: (vx, vy) => (this.glide = { x: vx, y: vy }),
      cancelLine: () => (this.drag = null),
    });
    this.topCanvas.addEventListener('pointerdown', () => sound.unlock());
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.key);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.key);
    const top = this.topCanvas;
    top.replaceWith(top.cloneNode()); // drops the input listeners
  }

  private resize = () => {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    this.cam.vw = vw;
    this.cam.vh = vh;
    for (const c of [this.mapCanvas, this.topCanvas, this.agents.canvas]) {
      c.width = Math.round(vw * this.dpr);
      c.height = Math.round(vh * this.dpr);
    }
    this.mapCache.width = this.mapCanvas.width;
    this.mapCache.height = this.mapCanvas.height;
    this.mapCacheKey = '';
  };

  private key = (e: KeyboardEvent) => {
    sound.unlock();
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const t = ALL_TOOLS.find((d) => d.key === k);
    if (t) return this.setTool(t.id);
    if (k === 'Escape') return this.setTool(null);
    if (k === 'Q' || k === 'Й' || k === ',') return this.rotate(-30);
    if (k === 'E' || k === 'У' || k === '.') return this.rotate(30);
    if (k === 'M' || k === 'Ь') return this.toggleSound();
    if (k === 'U' && this.selected) return this.upgradeSelected();
    if (k === 'X' && this.selected) return this.removeSelected();
    if (k === 'D' && this.selected) return this.dropSelected();
    if (k === 'F' && this.selected) return this.occupyNearest();
    const f = ['F1', 'F2', 'F3', 'F4', 'F5'].indexOf(k);
    if (f >= 0 && this.world.phase === 'battle') {
      e.preventDefault();
      return this.setSpeed([0.5, 1, 2, 4, 8][f]);
    }
    if (k === ' ') {
      e.preventDefault();
      if (this.world.phase === 'planning') this.start();
      else this.setSpeed(this.speed === 0 ? 1 : 0);
    }
  };

  // ---------- actions ----------

  private rotate(d: number): void {
    this.cam.rotate(d);
    this.mapCacheKey = '';
    sound.ui('click');
  }

  private toggleSound(): void {
    sound.unlock();
    const muted = sound.toggle();
    this.el('btn-sound').textContent = muted ? '🔇' : '🔊';
  }

  private start(): void {
    sound.unlock();
    this.world.startBattle();
    sound.ui('siren');
    this.el('btn-start').classList.add('hidden');
    this.el('btn-refund').classList.add('hidden');
    this.el('speed').classList.remove('hidden');
    this.el('btn-retreat').classList.remove('hidden');
    sound.ui('place');
    this.refreshHud();
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.el('speed').querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === s));
  }

  private setTool(t: Tool | null): void {
    this.tool = this.tool === t ? null : t;
    this.selected = null;
    this.drag = null;
    if (this.tool) this.group = GROUPS.find((g) => g.tools.some((d) => d.id === this.tool))!.id;
    sound.ui('click');
    this.refreshHud();
  }

  private flash(msg: string): void {
    const h = this.el('hint');
    h.textContent = msg;
    h.classList.add('warn');
    this.flashUntil = performance.now() + 1600;
    sound.ui('error');
  }

  /**
   * What the finger is on in the 2.5D view: roofs and walls are drawn shifted
   * up the screen, so walk back along the view direction to find the building
   * whose roof or wall covers this point (frontmost first).
   */
  private pick(x: number, y: number): { x: number; y: number } {
    const g = this.world.grid;
    const [dx, dy] = this.cam.down();
    for (let s = MAX_VISUAL_H * LEAN; s >= 0; s -= 1) {
      const qx = x + dx * s;
      const qy = y + dy * s;
      if (qx < 0 || qy < 0 || qx >= this.world.widthM || qy >= this.world.heightM) continue;
      const c = g.idx(qx, qy);
      if (g.solid[c] === BUILDING && Math.min(g.height[c], MAX_VISUAL_H) * LEAN >= s - 1) return { x: qx, y: qy };
    }
    return { x, y };
  }

  private tap(tx: number, ty: number, sx: number, sy: number): void {
    const w = this.world;
    const t = this.tool;
    const picked = this.pick(tx, ty);
    // a roof drawn over a street: street-only units still take the street underneath
    const forType = (type: UnitType) => (!canPlace(w, type, picked.x, picked.y) && canPlace(w, type, tx, ty) ? { x: tx, y: ty } : picked);
    const want = t && isUnit(t) ? t : this.selected?.type;
    const { x, y } = want ? forType(want) : picked;
    // touching an existing unit selects it, even with a tool in hand
    const onUnit = this.unitAtScreen(sx, sy);
    if (onUnit && t && !LINE_TOOLS.has(t)) {
      this.tool = null;
      this.selected = onUnit;
      sound.ui('click');
      return this.refreshHud();
    }
    if (t && isAbility(t) && !LINE_TOOLS.has(t)) {
      if (w.phase !== 'battle') return this.flash('Поддержка доступна после начала вспышки');
      if (!abilityReady(w, t)) return this.flash(w.cooldowns[t] > 0 ? 'Перезарядка' : 'Не хватает бюджета');
      useAbility(w, t, x, y);
      sound.ui('place');
      return this.refreshHud();
    }
    if (t && isUnit(t)) {
      if (w.budget < toolCost(t)) return this.flash('Не хватает бюджета');
      if (inExclusion(w, x, y)) return this.flash('До начала вспышки в зону очага не войти');
      if (!canPlace(w, t, x, y)) return this.flash(placeError(t));
      if (t === 'heli' && (x !== tx || y !== ty)) return this.placeAt(t, tx, ty);
      return this.placeAt(t, x, y);
    }
    const hit = this.unitAtScreen(sx, sy);
    const sel = this.selected;
    if (hit) this.selected = hit === sel ? null : hit;
    else if (sel?.type === 'heli') {
      sel.tx = tx;
      sel.ty = ty;
    } else if (sel && MOVABLE.has(sel.type)) {
      if (w.phase === 'planning' && inExclusion(w, x, y)) return this.flash('До начала вспышки в зону очага не войти');
      if (!canPlace(w, sel.type, x, y)) return this.flash(placeError(sel.type));
      if (w.phase === 'planning') w.relocate(sel, x, y);
      else if (!w.orderMove(sel, x, y)) return this.flash('Туда не пройти');
      w.moveMarks.push({ x, y, t: 1 });
      sound.ui('click');
    } else this.selected = null;
    this.refreshHud();
  }

  private placeAt(t: UnitType, x: number, y: number): void {
    const w = this.world;
    w.budget -= toolCost(t);
    const u = w.addUnit(t, x, y);
    if (t === 'heli') u.aim = 0;
    if (w.grid.solid[w.grid.idx(x, y)] === BUILDING) {
      const name = ALL_TOOLS.find((d) => d.id === t)!.name;
      this.toast(`${name}: здание занято · ${u.elev > 8 ? `крыша ${u.elev} м` : 'стрельба из окон'}`, 'good');
    }
    sound.ui('place');
    this.refreshHud();
  }

  /** Nearest building cell (within ~40 m) a street unit could move into. */
  private nearestBuilding(u: Unit): { x: number; y: number } | null {
    const g = this.world.grid;
    const c0 = g.idx(u.x, u.y);
    const cx = c0 % g.w;
    const cy = Math.floor(c0 / g.w);
    for (let r = 1; r <= 10; r++)
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const c = (cy + dy) * g.w + cx + dx;
          if (c >= 0 && c < g.solid.length && g.solid[c] === BUILDING) {
            // step two cells further in so the squad sits inside, not on the wall
            const nx = g.cx(c) + Math.sign(dx) * g.cell;
            const ny = g.cy(c) + Math.sign(dy) * g.cell;
            const inner = g.solid[g.idx(nx, ny)] === BUILDING;
            return inner ? { x: nx, y: ny } : { x: g.cx(c), y: g.cy(c) };
          }
        }
    return null;
  }

  private occupyNearest(): void {
    const u = this.selected;
    const w = this.world;
    if (!u || !MOVABLE.has(u.type) || u.type === 'tank' || u.type === 'bmp') return;
    const b = this.nearestBuilding(u);
    if (!b) return this.flash('Рядом нет здания');
    if (w.phase === 'planning') {
      w.relocate(u, b.x, b.y);
      this.toast('Здание занято', 'good');
    } else if (!w.orderMove(u, b.x, b.y)) return this.flash('Туда не пройти');
    sound.ui('place');
    this.refreshHud();
  }

  private unitAtScreen(sx: number, sy: number): Unit | null {
    let best: Unit | null = null;
    let bestD = 24;
    for (const u of this.world.units) {
      const [ux, uy] = unitScreen(this.cam, u);
      const d = Math.hypot(ux - sx, uy - sy);
      if (d < bestD) {
        bestD = d;
        best = u;
      }
    }
    return best;
  }

  private line(x0: number, y0: number, x1: number, y1: number, done: boolean): void {
    const w = this.world;
    this.drag = done ? null : { x0, y0, x1, y1 };
    if (!done) return;
    const t = this.tool;
    if (t === 'barricade' || t === 'spikes') {
      const per = t === 'barricade' ? CFG.barricade.costPerCell : CFG.spikes.costPerCell;
      const max = t === 'barricade' ? CFG.barricade.maxCells : CFG.spikes.maxCells;
      let cells = barricadeCells(w, x0, y0, x1, y1, max);
      if (t === 'spikes') cells = cells.filter((c) => !w.spikes[c]);
      cells = cells.slice(0, Math.floor(w.budget / per));
      if (!cells.length) return this.flash('Не хватает бюджета или нет места');
      w.budget -= cells.length * per;
      if (t === 'barricade') w.placeBarricade(cells);
      else w.placeSpikes(cells);
    } else if (t === 'zone') {
      const z = zoneFromDrag(x0, y0, x1, y1);
      if (!z) return this.flash(`Зона от ${CFG.safeZone.minSide} м по стороне и до ${CFG.safeZone.maxArea / 10000} га`);
      const ex = CFG.outbreak.exclusion;
      const touches = w.phase === 'planning' && w.outbreak.some((o) => o.x > z.x0 - ex && o.x < z.x1 + ex && o.y > z.y0 - ex && o.y < z.y1 + ex);
      if (touches) return this.flash('Safe zone не может задевать зону очага');
      const cost = zoneCost(w, z);
      if (w.budget < cost) return this.flash(`Не хватает бюджета: зона стоит $${cost}`);
      w.budget -= cost;
      w.addZone(z, cost);
    } else if (t === 'airstrike' || t === 'fire') {
      if (Math.hypot(x1 - x0, y1 - y0) < 10) return this.flash('Проведите линию — это направление захода');
      if (w.phase !== 'battle') return this.flash('Поддержка доступна после начала вспышки');
      const ok = t === 'airstrike' ? callAirstrike(w, x0, y0, x1, y1) : useAbility(w, 'fire', x0, y0, x1, y1);
      if (!ok) return this.flash(t === 'fire' && w.cooldowns.fire > 0 ? 'Перезарядка' : 'Не хватает бюджета');
    }
    sound.ui('place');
    this.refreshHud();
  }

  private refundOf(u: Unit): number {
    const share = this.world.phase === 'planning' ? 1 : 0.5;
    let spent = CFG.units[u.type].cost;
    for (let l = 1; l < u.level; l++) spent += Math.round(CFG.units[u.type].cost * CFG.levels.costShare * l);
    const left = u.type === 'mines' ? u.ammo / CFG.units.mines.charges : u.hp / u.maxHp;
    return Math.floor(spent * share * Math.max(0, Math.min(1, left)));
  }

  private removeSelected(): void {
    const u = this.selected;
    if (!u || u.type === 'heli') return; // helicopters leave on their own
    this.world.budget += this.refundOf(u);
    this.world.removeUnit(u);
    this.selected = null;
    sound.ui('click');
    this.refreshHud();
  }

  private dropSelected(): void {
    if (this.selected && dropSquad(this.world, this.selected)) sound.ui('place');
    else this.flash('Десант ещё не готов');
    this.refreshHud();
  }

  private upgradeSelected(): void {
    if (this.selected && levelUp(this.world, this.selected)) sound.ui('place');
    else this.flash('Не хватает бюджета');
    this.refreshHud();
  }

  /** Planning only: take everything back at full price. */
  private refundAll(): void {
    const w = this.world;
    if (w.phase !== 'planning') return;
    for (const u of [...w.units]) {
      w.budget += this.refundOf(u);
      w.removeUnit(u);
    }
    w.budget += w.barricadeCells.length * CFG.barricade.costPerCell + w.spikeCells.length * CFG.spikes.costPerCell;
    for (const c of w.barricadeCells) w.grid.barricade[c] = 0;
    for (const c of w.spikeCells) w.spikes[c] = 0;
    w.barricadeCells = [];
    w.spikeCells = [];
    w.budget += w.zoneSpent;
    w.clearZones();
    w.evacDirty = true;
    this.selected = null;
    sound.ui('click');
    this.refreshHud();
  }

  // ---------- HUD ----------

  private buildHud(): void {
    const rail = this.el('rail');
    rail.innerHTML = GROUPS.map((g) => `<button data-open="${g.id}" title="${g.title}">${g.icon}<span>${g.short}</span></button>`).join('');
    rail.querySelectorAll<HTMLButtonElement>('[data-open]').forEach(
      (b) =>
        (b.onclick = () => {
          const id = b.dataset.open as typeof this.group;
          this.openGroup = this.openGroup === id ? null : id;
          sound.ui('click');
          this.renderFlyout();
          this.refreshHud();
        }),
    );
    this.el('btn-start').classList.remove('hidden');
    this.el('btn-refund').classList.remove('hidden');
    this.el('speed').classList.add('hidden');
    this.el('btn-retreat').classList.add('hidden');
    this.el('btn-start').onclick = () => this.start();
    this.el('btn-hunt').onclick = () => this.huntNext();
    this.el('btn-refund').onclick = () => this.refundAll();
    this.el('btn-menu').onclick = () => this.onQuit();
    this.el('btn-rotl').onclick = () => this.rotate(-30);
    this.el('btn-rotr').onclick = () => this.rotate(30);
    this.el('btn-sound').onclick = () => this.toggleSound();
    this.el('btn-sound').textContent = sound.muted ? '🔇' : '🔊';
    // confirm in place: a second tap within 3 s retreats (no browser dialogs)
    const retreat = this.el('btn-retreat');
    retreat.textContent = 'Отступить';
    retreat.onclick = () => {
      if (retreat.dataset.armed) return this.finish(false);
      retreat.dataset.armed = '1';
      retreat.textContent = 'Точно? Ещё раз';
      setTimeout(() => {
        delete retreat.dataset.armed;
        retreat.textContent = 'Отступить';
      }, 3000);
    };
    this.el('speed')
      .querySelectorAll<HTMLButtonElement>('button')
      .forEach((b) => (b.onclick = () => this.setSpeed(Number(b.dataset.s))));
    this.setSpeed(1);
    this.openGroup = null;
    this.renderFlyout();
    this.refreshHud();
  }

  /** Grid of tool cells for the open group (built once per opening). */
  private renderFlyout(): void {
    const fly = this.el('flyout');
    const g = GROUPS.find((q) => q.id === this.openGroup);
    fly.classList.toggle('hidden', !g);
    if (!g) return;
    fly.innerHTML = `<div class="label">${g.title}</div><div class="cells">${g.tools
      .map(
        (d) =>
          `<button class="cell" data-tool="${d.id}" title="${d.hint}"><kbd>${d.key}</kbd><span class="ic" style="background:${toolColor(d.id)}"></span><span class="nm">${d.name}</span><span class="cost num">${costLabel(d.id)}</span></button>`,
      )
      .join('')}</div>`;
    fly.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(
      (b) =>
        (b.onclick = () => {
          this.setTool(b.dataset.tool as Tool);
          this.openGroup = null; // the grid folds away once a cell is picked
          this.renderFlyout();
          this.refreshHud();
        }),
    );
  }

  private huntIndex = 0;

  /** Jumps the camera to the next group of the last zombies. */
  private huntNext(): void {
    const groups = stragglers(this.world).sort((a, b) => b.n - a.n);
    if (!groups.length) return;
    const g = groups[this.huntIndex++ % groups.length];
    this.cam.x = g.x;
    this.cam.y = g.y;
    this.cam.zoom = Math.max(this.cam.zoom, 1);
    sound.ui('click');
  }

  /** Short message at the top of the screen. */
  private toast(text: string, kind: 'good' | 'bad' = 'bad'): void {
    const box = this.el('toasts');
    const t = document.createElement('div');
    t.className = `glass toast ${kind}`;
    t.textContent = text;
    box.appendChild(t);
    setTimeout(() => t.remove(), 3300);
    while (box.children.length > 3) box.firstChild!.remove();
  }

  private refreshHud(): void {
    const w = this.world;
    const fmt = (n: number) => Math.floor(n).toLocaleString('ru-RU');
    const pop = Math.max(1, w.stats.population);
    const civ = w.phase === 'planning' ? w.stats.population : w.counts.civ;
    const mm = Math.floor(w.time / 60);
    const ss = Math.floor(w.time % 60).toString().padStart(2, '0');
    const share = Math.round(((w.phase === 'planning' ? civ : w.saved()) / pop) * 100);
    this.el('stats').innerHTML = `<div class="title">${this.mission.title}</div>
      <div class="phase">${w.phase === 'planning' ? 'Подготовка' : `Вспышка · ${mm}:${ss}`}${w.infiniteAmmo ? ' · ∞ патроны' : ''}</div>
      <div class="money">$${fmt(w.budget)}</div>
      <div class="bounty">${w.stats.bounty ? `+$${fmt(w.stats.bounty)} за убийства` : `+$${CFG.bounty} за каждого зомби`}</div>
      <div class="rowv c-civ"><span>Мирные</span><b class="num">${fmt(civ)} · ${share}%</b></div>
      <div class="rowv c-zom"><span>Зомби${w.zombieHp > 1 ? ` (HP ${w.zombieHp})` : ''}</span><b class="num">${fmt(w.counts.zombie)}</b></div>
      ${w.counts.infected ? `<div class="rowv c-inf"><span>Заражены</span><b class="num">${fmt(w.counts.infected)}</b></div>` : ''}
      ${w.stats.evacuated ? `<div class="rowv c-evac"><span>Эвакуировано</span><b class="num">${fmt(w.stats.evacuated)}</b></div>` : ''}
      ${w.counts.recruit ? `<div class="rowv c-rec"><span>Бойцы-добровольцы</span><b class="num">${fmt(w.counts.recruit)}</b></div>` : ''}`;

    const toolGroup = this.tool ? GROUPS.find((g) => g.tools.some((d) => d.id === this.tool))?.id : null;
    document.querySelectorAll<HTMLElement>('[data-open]').forEach((b) => {
      b.classList.toggle('open', b.dataset.open === this.openGroup);
      b.classList.toggle('has', b.dataset.open === toolGroup);
    });
    document.querySelectorAll<HTMLButtonElement>('.cell').forEach((b) => {
      const t = b.dataset.tool as Tool;
      const def = ALL_TOOLS.find((d) => d.id === t)!;
      b.classList.toggle('active', t === this.tool);
      const cd = isAbility(t) ? w.cooldowns[t] : 0;
      b.disabled = w.budget < toolCost(t) || (!!def.battleOnly && w.phase !== 'battle') || cd > 0;
      b.querySelector('.cost')!.textContent = cd > 0 ? `${Math.ceil(cd)} с` : costLabel(t);
    });
    const few = w.phase === 'battle' && w.counts.zombie > 0 && w.counts.zombie <= 60;
    this.el('btn-hunt').classList.toggle('hidden', !few);
    if (few) this.el('btn-hunt').textContent = `К зомби · осталось ${w.counts.zombie}`;
    const chip = this.el('toolchip');
    const active = ALL_TOOLS.find((d) => d.id === this.tool);
    chip.classList.toggle('hidden', !active);
    if (active) chip.innerHTML = `<b>${active.name}</b> · Esc / ещё раз — отмена`;

    if (performance.now() > this.flashUntil) {
      const h = this.el('hint');
      h.classList.remove('warn');
      h.classList.toggle('idle', !active && w.phase !== 'planning');
      h.textContent = active
        ? active.hint
        : w.phase === 'planning'
          ? 'Зелёный круг — очаг, туда до начала не войти. Силы — в колонке справа.'
          : 'Тяните карту, щипок — масштаб, Q/E или два пальца — поворот. Коснитесь юнита, чтобы выбрать.';
    }
    this.refreshSelected();
  }

  private refreshSelected(): void {
    const sel = this.el('sel');
    const u = this.selected;
    const w = this.world;
    if (!u || !w.units.includes(u)) {
      this.selected = null;
      sel.classList.add('hidden');
      return;
    }
    const def = ALL_TOOLS.find((d) => d.id === u.type)!;
    const r = rangeOf(w, u.type, u.elev, u.level);
    const mag = magazineOf(u);
    const gauge = (name: string, f: number, val: string) =>
      `<div class="gauge"><span>${name}</span><div class="track"><div class="fill" style="width:${Math.round(Math.max(0, Math.min(1, f)) * 100)}%"></div></div><span class="num">${val}</span></div>`;
    const plain = (name: string, val: string) => `<div class="gauge"><span>${name}</span><span></span><span class="num">${val}</span></div>`;
    const rows = [
      u.type !== 'heli' && u.type !== 'mines' ? gauge('Прочность', u.hp / u.maxHp, `${Math.ceil(u.hp)}/${Math.round(u.maxHp)}`) : '',
      r.r ? gauge('Дальность', r.r / 400, `${Math.round(r.r)} м`) : '',
      Number.isFinite(mag) ? gauge('Патроны', u.ammo / mag, `${u.ammo}/${mag}`) : '',
      u.type === 'mines' ? gauge('Заряды', u.ammo / CFG.units.mines.charges, `${u.ammo}`) : '',
      u.type === 'heli' ? gauge('Топливо', 1 - u.age / CFG.units.heli.duration, `${Math.max(0, Math.ceil(CFG.units.heli.duration - u.age))} с`) : '',
      u.elev > 0 && u.type === 'sniper' ? plain('Крыша', `${u.elev} м`) : '',
      plain(u.type === 'evac' ? 'Вывезено' : 'Убито', `${u.kills}`),
      MOVABLE.has(u.type) ? plain('Позиция', w.grid.solid[w.grid.idx(u.x, u.y)] === BUILDING ? 'в здании · укрытие' : 'на улице') : '',
      u.moving ? plain('Статус', 'на марше') : MOVABLE.has(u.type) ? '<div style="color:var(--muted);font-size:11px">Коснитесь карты — переместить</div>' : '',
    ].join('');
    const up = canLevelUp(u)
      ? `<button class="up" id="sel-up" ${w.budget < levelUpCost(u) ? 'disabled' : ''}>[U] Ур.${u.level + 1} $${levelUpCost(u)}</button>`
      : '<button disabled>Макс. уровень</button>';
    const refund = u.type === 'heli' ? '<button disabled>—</button>' : `<button id="sel-x">[X] Снять +$${this.refundOf(u)}</button>`;
    const inside = w.grid.solid[w.grid.idx(u.x, u.y)] === BUILDING;
    const occupy =
      MOVABLE.has(u.type) && u.type !== 'tank' && u.type !== 'bmp' && !inside && !u.moving
        ? '<button id="sel-occupy" style="grid-column:1/-1">[F] Занять ближайшее здание</button>'
        : '';
    const squad =
      u.type === 'bmp'
        ? `<button id="sel-drop" style="grid-column:1/-1" ${u.aux > 0 || w.phase !== 'battle' ? 'disabled' : ''}>[D] Высадить десант${u.aux > 0 ? ` · ${Math.ceil(u.aux)} с` : ''}</button>`
        : '';
    const html = `<div class="head"><span>${def.name}</span><small>УР. ${u.level}/${CFG.levels.max}</small></div><div class="body">${rows}</div><div class="acts">${refund}${up}${squad}${occupy}</div>`;
    if (sel.dataset.html !== html) {
      sel.innerHTML = html;
      sel.dataset.html = html;
      document.getElementById('sel-x')?.addEventListener('click', () => this.removeSelected());
      document.getElementById('sel-up')?.addEventListener('click', () => this.upgradeSelected());
      document.getElementById('sel-drop')?.addEventListener('click', () => this.dropSelected());
      document.getElementById('sel-occupy')?.addEventListener('click', () => this.occupyNearest());
    }
    sel.classList.remove('hidden');
  }

  private finish(won: boolean): void {
    if (this.ended) return;
    this.ended = true;
    const w = this.world;
    const saved = won ? w.saved() : w.stats.evacuated;
    const share = saved / Math.max(1, w.stats.population);
    this.onEnd({ won, stars: starsFor(share, won), saved, population: w.stats.population });
  }

  // ---------- loop ----------

  private frame = (now: number) => {
    this.raf = requestAnimationFrame(this.frame);
    const w = this.world;
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (w.phase === 'battle' && !this.ended) {
      this.acc += dt * this.speed;
      // simulate within a time budget so the picture stays smooth; a slow device
      // plays slower instead of stuttering
      const t0 = performance.now();
      let n = 0;
      while (this.acc >= STEP && n < MAX_TICKS_PER_FRAME && (n === 0 || performance.now() - t0 < SIM_BUDGET_MS)) {
        w.tick(STEP);
        this.acc -= STEP;
        n++;
      }
      if (this.acc > STEP * 2) this.acc = STEP; // dropped time is not caught up later
    }
    if (Math.hypot(this.glide.x, this.glide.y) > 8) {
      this.cam.panBy(this.glide.x * dt, this.glide.y * dt);
      this.cam.clamp(w.widthM, w.heightM);
      const k = Math.exp(-dt * 4.5);
      this.glide.x *= k;
      this.glide.y *= k;
    }
    if (this.ended) w.sfx.length = 0;
    sound.drain(w.sfx, this.cam);
    for (const n of w.notes.splice(0)) {
      const name = n.type ? ALL_TOOLS.find((d) => d.id === n.type)?.name ?? '' : '';
      if (n.k === 'lost') this.toast(`${name}: потерян`);
      else if (n.k === 'breach') this.toast('Зомби прорвались в safe zone — снабжение прервано');
      else this.toast(`${name}: кончились патроны — отведите в safe zone`);
    }
    // horde drone: more zombies and a closer camera make it louder
    sound.setHorde(w.phase === 'battle' && !this.ended ? Math.log10(1 + w.counts.zombie) / 4 * Math.min(1, this.cam.zoom / 1.2 + 0.3) : 0);
    if (w.phase === 'won' || w.phase === 'lost') this.finish(w.phase === 'won');
    this.hudT -= dt;
    if (this.hudT <= 0) {
      this.hudT = 0.2;
      this.refreshHud();
    }
    this.render(now);
  };

  private render(now: number): void {
    const { cam, dpr, world: w } = this;
    const key = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.zoom.toFixed(4)},${cam.deg},${cam.vw},${cam.vh}`;
    if (key !== this.mapCacheKey) {
      this.mapLayer.draw(this.mapCache.getContext('2d')!, cam, dpr);
      this.mapCacheKey = key;
    }
    const mc = this.mapCtx;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.drawImage(this.mapCache, 0, 0);
    drawGround(mc, w, cam, dpr);
    for (const u of w.units)
      if (!u.moving && w.grid.solid[w.grid.idx(u.x, u.y)] === BUILDING) this.mapLayer.highlight(mc, cam, dpr, u.x, u.y, UNIT_COLOR[u.type]);
    // preview: the building a squad would take under the cursor
    if (this.tool && isUnit(this.tool) && this.hoverPt && !SPECIALISTS.has(this.tool)) {
      const p = this.pick(this.hoverPt.x, this.hoverPt.y);
      if (w.grid.solid[w.grid.idx(p.x, p.y)] === BUILDING && canPlace(w, this.tool, p.x, p.y))
        this.mapLayer.highlight(mc, cam, dpr, p.x, p.y, UNIT_COLOR[this.tool], 0.45);
    }

    this.agents.draw(w, cam, dpr, Math.min(1, this.acc / STEP));

    const tc = this.topCtx;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, this.topCanvas.width, this.topCanvas.height);
    const t = this.tool;
    this.mapLayer.drawLabels(tc, cam, dpr);
    drawTop(tc, w, cam, dpr, now, this.selected?.id ?? -1, t !== null && isUnit(t) && SPECIALISTS.has(t));

    if (this.selected && this.selected.type !== 'heli' && t === null) {
      const r = rangeOf(w, this.selected.type, this.selected.elev, this.selected.level);
      drawRange(tc, cam, this.selected.x, this.selected.y, r.r, 'rgba(214,66,143,0.8)', r.rMin);
    }
    if (t && isUnit(t) && this.hoverPt) {
      const p = t === 'heli' ? this.hoverPt : this.pick(this.hoverPt.x, this.hoverPt.y);
      const ok = canPlace(w, t, p.x, p.y);
      const c = w.grid.idx(p.x, p.y);
      const r = rangeOf(w, t, t === 'sniper' ? w.grid.height[c] : 0);
      drawRange(tc, cam, p.x, p.y, r.r, ok ? 'rgba(125,255,90,0.7)' : 'rgba(255,90,79,0.7)', r.rMin);
    }
    if (t === 'gas' && this.hoverPt) drawRange(tc, cam, this.hoverPt.x, this.hoverPt.y, CFG.abilities.gas.radius, 'rgba(200,230,90,0.8)');
    if (t === 'arms' && this.hoverPt) drawRange(tc, cam, this.hoverPt.x, this.hoverPt.y, CFG.abilities.arms.radius, 'rgba(90,200,255,0.8)');
    if (this.drag) this.drawDrag(tc);
  }

  private drawDrag(tc: CanvasRenderingContext2D): void {
    const { cam, world: w } = this;
    const d = this.drag!;
    const t = this.tool;
    if (t === 'barricade' || t === 'spikes') {
      const cells = barricadeCells(w, d.x0, d.y0, d.x1, d.y1, t === 'barricade' ? CFG.barricade.maxCells : CFG.spikes.maxCells);
      const g = w.grid;
      tc.save();
      tc.setTransform(...cam.matrix(this.dpr));
      tc.fillStyle = t === 'barricade' ? 'rgba(255,179,71,0.6)' : 'rgba(200,200,210,0.5)';
      for (const c of cells) tc.fillRect(g.cx(c) - g.cell / 2, g.cy(c) - g.cell / 2, g.cell, g.cell);
      tc.restore();
    } else if (t === 'zone') {
      const z = zoneFromDrag(d.x0, d.y0, d.x1, d.y1);
      const pts = [cam.toScreen(d.x0, d.y0), cam.toScreen(d.x1, d.y0), cam.toScreen(d.x1, d.y1), cam.toScreen(d.x0, d.y1)];
      tc.fillStyle = z ? ZONE_FILL : 'rgba(255,90,79,0.15)';
      tc.strokeStyle = z ? ZONE_LINE : 'rgba(255,90,79,0.8)';
      tc.lineWidth = 2;
      tc.beginPath();
      pts.forEach(([x, y], k) => (k ? tc.lineTo(x, y) : tc.moveTo(x, y)));
      tc.closePath();
      tc.fill();
      tc.stroke();
      const [cx, cy] = cam.toScreen((d.x0 + d.x1) / 2, (d.y0 + d.y1) / 2);
      tc.font = '600 13px "IBM Plex Mono", monospace';
      tc.textAlign = 'center';
      tc.fillStyle = '#fff';
      tc.fillText(z ? `$${zoneCost(w, z)}` : 'слишком мала или велика', cx, cy);
    } else if (t === 'airstrike' || t === 'fire') {
      const len = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) || 1;
      const L = t === 'airstrike' ? CFG.airstrike.length : CFG.abilities.fire.length;
      const W = t === 'airstrike' ? CFG.airstrike.width * w.mods.airstrikeWidth : CFG.abilities.fire.width;
      const [sx, sy] = cam.toScreen(d.x0, d.y0);
      const [ex, ey] = cam.toScreen(d.x0 + ((d.x1 - d.x0) / len) * L, d.y0 + ((d.y1 - d.y0) / len) * L);
      tc.strokeStyle = t === 'airstrike' ? 'rgba(255,90,79,0.5)' : 'rgba(255,122,47,0.55)';
      tc.lineWidth = Math.max(4, W * cam.zoom);
      tc.beginPath();
      tc.moveTo(sx, sy);
      tc.lineTo(ex, ey);
      tc.stroke();
    }
  }
}
