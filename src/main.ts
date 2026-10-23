import { CFG, type UpgradeId } from './config';
import { Game, type GameResult } from './game';
import { MISSIONS, type Mission } from './missions';
import { canUpgrade, loadProgress, medals, saveProgress, upgradeCost } from './progress';
import { Grid, type MapData } from './sim/grid';

const $ = (id: string) => document.getElementById(id)!;
const progress = loadProgress();
let map: MapData;
let grid: Grid;
let game: Game | null = null;

const starStr = (n: number) => `${'★'.repeat(n)}<span class="off">${'★'.repeat(3 - n)}</span>`;

function unlocked(i: number): boolean {
  return i === 0 || (progress.stars[MISSIONS[i - 1].id] ?? 0) > 0;
}

function showMenu(): void {
  game?.destroy();
  game = null;
  $('game').classList.add('hidden');
  $('modal').classList.add('hidden');
  const m = $('menu');
  m.classList.remove('hidden');
  const missions = MISSIONS.map((ms, i) => {
    const open = unlocked(i);
    return `<div class="card ${open ? '' : 'locked'}">
      <div class="info"><b>${i + 1}. ${ms.title}</b><p>${ms.brief}</p>
      <div class="meta num">${ms.population.toLocaleString('ru-RU')} мирных · бюджет $${ms.budget.toLocaleString('ru-RU')} · очагов: ${ms.outbreak.length}</div></div>
      <div style="text-align:center"><div class="stars">${starStr(progress.stars[ms.id] ?? 0)}</div>
      <button class="btn" data-play="${i}" ${open ? '' : 'disabled'} style="margin-top:8px">${open ? 'Играть' : '🔒'}</button></div>
    </div>`;
  }).join('');
  const ups = (Object.keys(CFG.upgrades) as UpgradeId[]).map((id) => {
    const lvl = progress.upgrades[id] ?? 0;
    const def = CFG.upgrades[id];
    const maxed = lvl >= def.max;
    return `<div class="card"><div class="info"><b style="font-size:14px">${def.title}</b>
      <div class="meta">Уровень ${lvl}/${def.max}</div></div>
      <button class="btn ghost" data-up="${id}" ${canUpgrade(progress, id) ? '' : 'disabled'}>${maxed ? 'Макс.' : `★ ${upgradeCost(progress, id)}`}</button></div>`;
  }).join('');
  m.innerHTML = `<div class="wrap">
    <h1>Карантин: <span>Нью-Йорк</span></h1>
    <p class="lead">Стратегия сдерживания орды на реальной карте Мидтауна Манхэттена. Изучите очаг, расставьте снайперов, турели, миномёты, баррикады и пункты эвакуации — и спасите как можно больше людей.</p>
    <h2>Миссии</h2>${missions}
    <h2>Усиления · медалей: ${medals(progress)}</h2>
    <p class="lead" style="margin:-4px 0 10px;font-size:13px">Звёзды за миссии — это медали. Победа нужна, чтобы открыть следующую миссию.</p>
    ${ups}
    <p class="lead" style="font-size:12px;margin-top:24px">Карта: © OpenStreetMap contributors (ODbL). Вдохновлено игрой «Zombies Aren't Real» (Jogamedev); это независимая реконструкция механик, без чужих ассетов и кода.</p>
  </div>`;
  m.querySelectorAll<HTMLButtonElement>('[data-play]').forEach((b) => (b.onclick = () => play(MISSIONS[Number(b.dataset.play)])));
  m.querySelectorAll<HTMLButtonElement>('[data-up]').forEach(
    (b) =>
      (b.onclick = () => {
        const id = b.dataset.up as UpgradeId;
        if (!canUpgrade(progress, id)) return;
        progress.upgrades[id] = (progress.upgrades[id] ?? 0) + 1;
        saveProgress(progress);
        showMenu();
      }),
  );
}

function play(ms: Mission): void {
  game?.destroy();
  $('menu').classList.add('hidden');
  $('modal').classList.add('hidden');
  $('game').classList.remove('hidden');
  game = new Game(map, grid, ms, progress.upgrades, (r) => showResult(ms, r), showMenu);
}

function showResult(ms: Mission, r: GameResult): void {
  const w = game!.world;
  const prev = progress.stars[ms.id] ?? 0;
  if (r.stars > prev) {
    progress.stars[ms.id] = r.stars;
    saveProgress(progress);
  }
  const pct = Math.round((r.saved / Math.max(1, r.population)) * 100);
  const fmt = (n: number) => n.toLocaleString('ru-RU');
  const next = MISSIONS.indexOf(ms) + 1;
  const modal = $('modal');
  modal.innerHTML = `<div class="box">
    <h3>${r.won ? 'Заражение остановлено' : 'Мидтаун потерян'}</h3>
    <div style="color:var(--muted)">${ms.title}</div>
    <div class="big-stars stars">${starStr(r.stars)}</div>
    <div class="stat"><span>Спасено</span><b class="num">${fmt(r.saved)} из ${fmt(r.population)} (${pct}%)</b></div>
    <div class="stat"><span>Эвакуировано</span><span class="num">${fmt(w.stats.evacuated)}</span></div>
    <div class="stat"><span>Заражено</span><span class="num">${fmt(w.stats.infected)}</span></div>
    <div class="stat"><span>Погибло от нашего огня</span><span class="num">${fmt(w.stats.friendlyFire)}</span></div>
    <div class="stat"><span>Уничтожено зомби</span><span class="num">${fmt(w.stats.zombiesKilled)}</span></div>
    <div class="stat"><span>Время</span><span class="num">${Math.floor(w.time / 60)}:${Math.floor(w.time % 60).toString().padStart(2, '0')}</span></div>
    <p style="color:var(--muted);font-size:12px">Звёзды: ≥${CFG.stars.map((s) => Math.round(s * 100) + '%').join(' / ')} спасённых и победа.</p>
    <div class="actions">
      <button class="btn ghost" id="r-menu">Миссии</button>
      <button class="btn ghost" id="r-again">Ещё раз</button>
      ${r.won && next < MISSIONS.length ? '<button class="btn" id="r-next">Дальше</button>' : ''}
    </div></div>`;
  modal.classList.remove('hidden');
  $('r-menu').onclick = showMenu;
  $('r-again').onclick = () => play(ms);
  const nb = document.getElementById('r-next');
  if (nb) nb.onclick = () => play(MISSIONS[next]);
}

async function boot(): Promise<void> {
  const res = await fetch(new URL('maps/midtown.json', document.baseURI));
  map = await res.json();
  grid = Grid.fromMap(map, CFG.sim.cell);
  $('loading').classList.add('hidden');
  const q = new URLSearchParams(location.search).get('mission');
  const direct = MISSIONS.find((m) => m.id === q);
  if (direct) play(direct);
  else showMenu();
}

boot().catch((e) => {
  $('loading').textContent = `Ошибка загрузки: ${e instanceof Error ? e.message : e}`;
});
