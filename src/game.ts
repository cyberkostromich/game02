import { CFG, type UnitType } from './config';
import { attachInput } from './input';
import { landmark, type Mission } from './missions';
import { starsFor } from './progress';
import { AgentRenderer } from './render/agents';
import { Camera } from './render/camera';
import { MapLayer } from './render/mapLayer';
import { drawGround, drawRange, drawTop, rangeOf, UNIT_COLOR, unitScreen } from './render/overlay';
import type { Grid, MapData } from './sim/grid';
import { barricadeCells, callAirstrike, canPlace, IN_BUILDING, inExclusion, SPECIALISTS, type Unit } from './sim/units';
import { modsFrom, World } from './sim/world';
import type { Upgrades } from './config';

type Tool = UnitType | 'barricade' | 'airstrike';

const TOOLS: { id: Tool; name: string; hint: string }[] = [
  { id: 'sniper', name: 'Снайпер', hint: 'Дальний точный огонь, нужна прямая видимость. На крыше высотки видит поверх домов и бьёт дальше.' },
  { id: 'garrison', name: 'Штурмовики', hint: 'Отряд в здании у улицы: очень прочный, стреляет из окон. Ставится на дом.' },
  { id: 'turret', name: 'Турель', hint: 'Шквальный огонь на 75 м, держит удар. Хороша на перекрытой улице.' },
  { id: 'mortar', name: 'Миномёт', hint: 'Бьёт по скоплениям на 50–340 м. Не стреляет, если рядом много мирных.' },
  { id: 'evac', name: 'Эвакуация', hint: 'Мирные в радиусе 300 м бегут к пункту и вывозятся. Вокруг пункта — safe zone для спецзданий.' },
  { id: 'barricade', name: 'Баррикада', hint: 'Проведите линию поперёк улицы. Зомби ломают её, мирные проходят.' },
  { id: 'medic', name: 'Медпункт', hint: 'Здание в safe zone: лечит заражённых рядом (до превращения) и чинит бойцов.' },
  { id: 'repair', name: 'Мастерская', hint: 'Здание в safe zone: восстанавливает баррикады и технику в радиусе 110 м.' },
  { id: 'barracks', name: 'Казарма', hint: 'Здание в safe zone: вооружает проходящих мирных — рекруты сами отстреливаются.' },
  { id: 'heli', name: 'Вертолёт', hint: 'Пулемёт с воздуха на 70 с. Выберите вертолёт и коснитесь карты, чтобы перенаправить.' },
  { id: 'airstrike', name: 'Авиаудар', hint: 'Проведите линию захода. Бомбят всё на полосе — и мирных тоже. Только во время боя.' },
];

function placeError(t: UnitType): string {
  if (SPECIALISTS.has(t)) return 'Нужно здание у улицы внутри safe zone (вокруг пункта эвакуации)';
  if (IN_BUILDING.has(t)) return 'Штурмовики занимают здание у улицы';
  if (t === 'sniper') return 'Снайпер — на улицу или на крышу у улицы';
  return 'Сюда нельзя: нужна открытая улица';
}

function toolCost(t: Tool): number {
  if (t === 'barricade') return CFG.barricade.costPerCell;
  if (t === 'airstrike') return CFG.airstrike.cost;
  return CFG.units[t].cost;
}

const STEP = 1 / CFG.sim.hz;
const MAX_TICKS_PER_FRAME = 8;

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
  private selected: Unit | null = null;
  private hoverPt: { x: number; y: number } | null = null;
  private drag: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private speed = 1;
  private acc = 0;
  private last = 0;
  private hudT = 0;
  private raf = 0;
  private ended = false;
  private el = (id: string) => document.getElementById(id)!;

  constructor(
    map: MapData,
    grid: Grid,
    private readonly mission: Mission,
    upgrades: Upgrades,
    private readonly onEnd: (r: GameResult) => void,
    private readonly onQuit: () => void,
  ) {
    const g = grid;
    g.barricade.fill(0);
    this.world = new World(g, map.width, map.height, Math.ceil(mission.population * 1.4) + 4000, mission.seed, modsFrom(upgrades));
    const w = this.world;
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
    // open on the outbreak, close enough to see the streets
    const o = w.outbreak[0];
    this.cam.x = o.x;
    this.cam.y = o.y;
    this.cam.zoom = Math.max(this.cam.zoom, Math.min(1.1, this.cam.vw / 700));

    this.buildHud();
    attachInput(this.topCanvas, this.cam, {
      wantsLine: () => this.tool === 'barricade' || this.tool === 'airstrike',
      tap: (x, y, sx, sy) => this.tap(x, y, sx, sy),
      line: (x0, y0, x1, y1, done) => this.line(x0, y0, x1, y1, done),
      hover: (x, y) => (this.hoverPt = { x, y }),
      cameraMoved: () => this.cam.clamp(map.width, map.height),
    });
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.key);
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.key);
    // input listeners die with the replaced canvas
    const top = this.topCanvas;
    top.replaceWith(top.cloneNode());
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
    const n = Number(e.key);
    if (n >= 1 && n <= TOOLS.length) this.setTool(TOOLS[n - 1].id);
    else if (e.key === 'Escape') this.setTool(null);
    else if (e.key === ' ') {
      e.preventDefault();
      if (this.world.phase === 'planning') this.start();
      else this.setSpeed(this.speed === 0 ? 1 : 0);
    }
  };

  // ---------- actions ----------

  private start(): void {
    this.world.startBattle();
    this.el('btn-start').classList.add('hidden');
    this.el('speed').classList.remove('hidden');
    this.el('btn-retreat').classList.remove('hidden');
    this.refreshHud();
  }

  private setSpeed(s: number): void {
    this.speed = s;
    this.el('speed').querySelectorAll('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.s) === s));
  }

  private setTool(t: Tool | null): void {
    this.tool = this.tool === t ? null : t;
    this.selected = null;
    this.drag = null;
    this.refreshHud();
  }

  private tap(x: number, y: number, sx: number, sy: number): void {
    const w = this.world;
    if (this.tool && this.tool !== 'barricade' && this.tool !== 'airstrike') {
      const t = this.tool;
      const cost = toolCost(t);
      if (w.budget < cost) return this.flash('Не хватает бюджета');
      if (inExclusion(w, x, y)) return this.flash('До начала вспышки в зону очага не войти');
      if (!canPlace(w, t, x, y)) return this.flash(placeError(t));
      w.budget -= cost;
      const u = w.addUnit(t, x, y);
      if (t === 'heli') u.aim = 0;
      this.refreshHud();
      return;
    }
    // select a unit under the finger
    const hit = this.unitAtScreen(sx, sy);
    if (hit) {
      this.selected = hit === this.selected ? null : hit;
    } else if (this.selected?.type === 'heli') {
      this.selected.tx = x;
      this.selected.ty = y;
    } else this.selected = null;
    this.refreshHud();
  }

  private unitAtScreen(sx: number, sy: number): Unit | null {
    let best: Unit | null = null;
    let bestD = 22;
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
    if (this.tool === 'barricade') {
      let cells = barricadeCells(w, x0, y0, x1, y1);
      cells = cells.slice(0, Math.floor(w.budget / CFG.barricade.costPerCell));
      if (!cells.length) return this.flash('Не хватает бюджета или нет места');
      w.budget -= cells.length * CFG.barricade.costPerCell;
      w.placeBarricade(cells);
    } else if (this.tool === 'airstrike') {
      if (Math.hypot(x1 - x0, y1 - y0) < 10) return this.flash('Проведите линию — это направление захода');
      if (w.phase !== 'battle') return this.flash('Авиаудар доступен после начала вспышки');
      if (!callAirstrike(w, x0, y0, x1, y1)) return this.flash('Не хватает бюджета');
    }
    this.refreshHud();
  }

  private removeSelected(): void {
    const u = this.selected;
    if (!u) return;
    const refund = this.world.phase === 'planning' ? 1 : 0.5;
    this.world.budget += Math.floor(CFG.units[u.type].cost * refund * (u.hp / u.maxHp));
    this.world.removeUnit(u);
    this.selected = null;
    this.refreshHud();
  }

  private flash(msg: string): void {
    const h = this.el('hint');
    h.textContent = msg;
    h.style.color = '#ffb3ad';
    setTimeout(() => {
      h.style.color = '';
      this.refreshHud();
    }, 1400);
  }

  // ---------- HUD ----------

  private buildHud(): void {
    this.el('m-title').textContent = this.mission.title;
    const tools = this.el('tools');
    tools.innerHTML = '';
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.className = 'tool';
      b.dataset.tool = t.id;
      const color = t.id === 'barricade' ? '#ffb347' : t.id === 'airstrike' ? '#ff5a4f' : UNIT_COLOR[t.id];
      const shape = t.id === 'sniper' ? 'transform:rotate(45deg) scale(.8)' : t.id === 'mortar' || t.id === 'evac' ? 'border-radius:50%' : '';
      b.innerHTML = `<div class="ico" style="background:${color};${shape}"></div><div class="nm">${t.name}</div><div class="cost num">$${toolCost(t.id)}${t.id === 'barricade' ? '/кл' : ''}</div>`;
      b.onclick = () => this.setTool(t.id);
      tools.appendChild(b);
    }
    this.el('btn-start').classList.remove('hidden');
    this.el('speed').classList.add('hidden');
    this.el('btn-retreat').classList.add('hidden');
    this.el('btn-start').onclick = () => this.start();
    this.el('btn-menu').onclick = () => this.onQuit();
    this.el('btn-retreat').onclick = () => {
      if (confirm('Отступить? Оставшиеся на улицах мирные будут потеряны.')) this.finish(false);
    };
    this.el('speed')
      .querySelectorAll('button')
      .forEach((b) => (b.onclick = () => this.setSpeed(Number((b as HTMLButtonElement).dataset.s))));
    this.setSpeed(1);
    this.refreshHud();
  }

  private refreshHud(): void {
    const w = this.world;
    const fmt = (n: number) => n.toLocaleString('ru-RU');
    this.el('budget').textContent = `$${fmt(w.budget)}`;
    const mm = Math.floor(w.time / 60);
    const ss = Math.floor(w.time % 60).toString().padStart(2, '0');
    this.el('m-phase').textContent = w.phase === 'planning' ? 'Подготовка: расставьте силы' : `Вспышка · ${mm}:${ss}`;
    this.el('c-civ').textContent = `${fmt(w.counts.civ || (w.phase === 'planning' ? w.stats.population : 0))} мирных`;
    this.el('c-zom').textContent = `${fmt(w.counts.zombie)} зомби`;
    this.el('c-inf').textContent = `${fmt(w.counts.infected)} заражено`;
    this.el('c-evac').textContent = `${fmt(w.stats.evacuated)} эвакуировано`;
    this.el('c-rec').textContent = `${fmt(w.counts.recruit)} рекрутов`;
    this.el('c-rec').parentElement!.classList.toggle('hidden', w.counts.recruit === 0);
    this.el('tools')
      .querySelectorAll<HTMLButtonElement>('.tool')
      .forEach((b) => {
        const t = b.dataset.tool as Tool;
        b.classList.toggle('active', t === this.tool);
        b.disabled = w.budget < toolCost(t) || (t === 'airstrike' && w.phase !== 'battle');
      });
    const hint = this.el('hint');
    const tool = TOOLS.find((t) => t.id === this.tool);
    hint.textContent = tool
      ? tool.hint
      : w.phase === 'planning'
        ? 'Зелёным отмечен очаг. Выберите силы внизу и коснитесь карты. Затем — «Начать».'
        : 'Двигайте карту пальцем, масштаб — щипком или колесом. Коснитесь юнита, чтобы выбрать.';

    const sel = this.el('sel');
    const u = this.selected;
    if (u && this.world.units.includes(u)) {
      const name = TOOLS.find((t) => t.id === u.type)!.name;
      const refund = Math.floor(CFG.units[u.type].cost * (w.phase === 'planning' ? 1 : 0.5) * (u.hp / u.maxHp));
      sel.innerHTML = `<b>${name}</b><div style="color:var(--muted);font-size:12px">${
        u.type === 'heli'
          ? `Осталось ${Math.max(0, Math.ceil(CFG.units.heli.duration - u.age))} с · коснитесь карты, чтобы лететь`
          : `Прочность ${Math.ceil(u.hp)}/${u.maxHp}${u.elev > 0 && u.type === 'sniper' ? ` · крыша ${u.elev} м, дальность ${Math.round(rangeOf(w, 'sniper', u.elev).r)} м` : ''}`
      }</div>`;
      if (u.type !== 'heli') {
        const b = document.createElement('button');
        b.textContent = `Снять (+$${refund})`;
        b.onclick = () => this.removeSelected();
        sel.appendChild(b);
      }
      sel.classList.remove('hidden');
    } else {
      if (u) this.selected = null;
      sel.classList.add('hidden');
    }
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
    if (w.phase === 'battle') {
      this.acc += dt * this.speed;
      let n = 0;
      while (this.acc >= STEP && n < MAX_TICKS_PER_FRAME) {
        w.tick(STEP);
        this.acc -= STEP;
        n++;
      }
      if (n === MAX_TICKS_PER_FRAME) this.acc = 0; // device can't keep up: slow down instead of spiralling
    }
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
    const key = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.zoom.toFixed(4)},${cam.vw},${cam.vh}`;
    if (key !== this.mapCacheKey) {
      this.mapLayer.draw(this.mapCache.getContext('2d')!, cam, dpr);
      this.mapCacheKey = key;
    }
    const mc = this.mapCtx;
    mc.setTransform(1, 0, 0, 1, 0, 0);
    mc.drawImage(this.mapCache, 0, 0);
    drawGround(mc, w, cam, dpr);

    this.agents.draw(w, cam, dpr, Math.min(1, this.acc / STEP));

    const tc = this.topCtx;
    tc.setTransform(1, 0, 0, 1, 0, 0);
    tc.clearRect(0, 0, this.topCanvas.width, this.topCanvas.height);
    const t = this.tool;
    this.mapLayer.drawLabels(tc, cam, dpr);
    drawTop(tc, w, cam, dpr, now, this.selected?.id ?? -1, t !== null && SPECIALISTS.has(t as UnitType));

    if (this.selected && this.selected.type !== 'heli' && t === null) {
      const r = rangeOf(w, this.selected.type, this.selected.elev);
      drawRange(tc, cam, this.selected.x, this.selected.y, r.r, 'rgba(95,180,255,0.7)', r.rMin);
    }
    if (t && t !== 'barricade' && t !== 'airstrike' && this.hoverPt) {
      const ok = canPlace(w, t, this.hoverPt.x, this.hoverPt.y);
      const c = w.grid.idx(this.hoverPt.x, this.hoverPt.y);
      const r = rangeOf(w, t, t === 'sniper' ? w.grid.height[c] : 0);
      drawRange(tc, cam, this.hoverPt.x, this.hoverPt.y, r.r, ok ? 'rgba(125,255,74,0.7)' : 'rgba(255,90,79,0.7)', r.rMin);
    }
    if (this.drag) {
      const d = this.drag;
      if (t === 'barricade') {
        const cells = barricadeCells(w, d.x0, d.y0, d.x1, d.y1);
        const g = w.grid;
        tc.fillStyle = 'rgba(255,179,71,0.6)';
        for (const c of cells) {
          const [sx, sy] = cam.toScreen(g.cx(c) - g.cell / 2, g.cy(c) - g.cell / 2);
          tc.fillRect(sx, sy, g.cell * cam.zoom, g.cell * cam.zoom);
        }
      } else if (t === 'airstrike') {
        const len = Math.hypot(d.x1 - d.x0, d.y1 - d.y0) || 1;
        const a = CFG.airstrike;
        const [sx, sy] = cam.toScreen(d.x0, d.y0);
        const [ex, ey] = cam.toScreen(d.x0 + ((d.x1 - d.x0) / len) * a.length, d.y0 + ((d.y1 - d.y0) / len) * a.length);
        tc.strokeStyle = 'rgba(255,90,79,0.5)';
        tc.lineWidth = Math.max(4, a.width * w.mods.airstrikeWidth * cam.zoom);
        tc.beginPath();
        tc.moveTo(sx, sy);
        tc.lineTo(ex, ey);
        tc.stroke();
      }
    }
  }
}
