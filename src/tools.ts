import { CFG, type AbilityId, type UnitType } from './config';
import { UNIT_COLOR } from './render/overlay';

export type Tool = UnitType | 'barricade' | 'spikes' | 'zone' | 'airstrike' | AbilityId;

export interface ToolDef {
  id: Tool;
  key: string; // hotkey, shown as [key]
  name: string;
  hint: string;
  battleOnly?: boolean;
}

export interface ToolGroup {
  id: 'deploy' | 'rear' | 'support';
  title: string;
  tools: ToolDef[];
}

export const GROUPS: ToolGroup[] = [
  {
    id: 'deploy',
    title: 'Оборона',
    tools: [
      { id: 'sniper', key: '1', name: 'Снайпер', hint: 'Дальний точный огонь, нужна прямая видимость. На крыше высотки видит поверх домов и бьёт дальше.' },
      { id: 'garrison', key: '2', name: 'Штурмовики', hint: 'Отряд в здании у улицы: очень прочный, стреляет из окон.' },
      { id: 'turret', key: '3', name: 'Турель', hint: 'Шквальный огонь на 75 м, держит удар. Хороша на перекрытой улице.' },
      { id: 'mortar', key: '4', name: 'Миномёт', hint: 'Бьёт по скоплениям на 50–340 м. Не стреляет, если рядом много мирных.' },
      { id: 'mines', key: '5', name: 'Минное поле', hint: 'Взрывается под зомби, 12 зарядов. Мирных не трогает, если они не рядом с зомби.' },
      { id: 'barricade', key: '6', name: 'Баррикада', hint: 'Проведите линию поперёк улицы. Зомби ломают её, мирные проходят.' },
      { id: 'spikes', key: '7', name: 'Шипы', hint: 'Полоса шипов: зомби вязнут (−60% скорости) и гибнут. Мирные проходят.' },
    ],
  },
  {
    id: 'rear',
    title: 'Тыл',
    tools: [
      { id: 'zone', key: 'B', name: 'Safe zone', hint: 'Растяните прямоугольник. Мирные стягиваются внутрь, бойцы пополняют патроны, можно ставить спецздания.' },
      { id: 'evac', key: 'R', name: 'Эвакуация', hint: 'Мирные в радиусе 300 м бегут к пункту и вывозятся. Вокруг пункта — safe zone.' },
      { id: 'medic', key: 'H', name: 'Медпункт', hint: 'Здание в safe zone: лечит заражённых рядом (до превращения) и чинит бойцов.' },
      { id: 'repair', key: 'J', name: 'Мастерская', hint: 'Здание в safe zone: восстанавливает баррикады и технику в радиусе 110 м.' },
      { id: 'barracks', key: 'K', name: 'Казарма', hint: 'Здание в safe zone: вооружает проходящих мирных — рекруты сами отстреливаются.' },
    ],
  },
  {
    id: 'support',
    title: 'Поддержка',
    tools: [
      { id: 'heli', key: 'Z', name: 'Вертолёт', hint: 'Пулемёт с воздуха на 70 с. Выберите вертолёт и коснитесь карты, чтобы перенаправить.' },
      { id: 'airstrike', key: 'C', name: 'Авиаудар', hint: 'Проведите линию захода. Бомбят всё на полосе — и мирных тоже.', battleOnly: true },
      { id: 'gas', key: 'V', name: 'Газ', hint: 'Облако на 10 с замораживает зомби. Мирным не вредит.', battleOnly: true },
      { id: 'fire', key: 'N', name: 'Напалм', hint: 'Проведите линию: полоса огня 12 с. Горят все, кто её пересекает.', battleOnly: true },
      { id: 'para', key: 'P', name: 'Десант', hint: '10 бойцов высаживаются и сами охотятся на зомби. Укушенные обращаются.', battleOnly: true },
      { id: 'arms', key: 'T', name: 'К оружию!', hint: 'Вооружить до 30 мирных вокруг точки — они начнут охоту на зомби.', battleOnly: true },
    ],
  },
];

export const ALL_TOOLS: ToolDef[] = GROUPS.flatMap((g) => g.tools);

export const LINE_TOOLS: ReadonlySet<Tool> = new Set(['barricade', 'spikes', 'zone', 'airstrike', 'fire']);

export function isAbility(t: Tool): t is AbilityId {
  return t in CFG.abilities;
}

export function isUnit(t: Tool): t is UnitType {
  return t in CFG.units;
}

export function toolCost(t: Tool): number {
  if (t === 'barricade') return CFG.barricade.costPerCell;
  if (t === 'spikes') return CFG.spikes.costPerCell;
  if (t === 'zone') return Math.ceil(CFG.safeZone.minSide ** 2 * CFG.safeZone.costPerM2);
  if (t === 'airstrike') return CFG.airstrike.cost;
  if (isAbility(t)) return CFG.abilities[t].cost;
  return CFG.units[t].cost;
}

export function costLabel(t: Tool): string {
  if (t === 'barricade' || t === 'spikes') return `$${toolCost(t)}/кл`;
  if (t === 'zone') return `$${CFG.safeZone.costPerM2 * 100}/100м²`;
  return `$${toolCost(t)}`;
}

export function toolColor(t: Tool): string {
  if (isUnit(t)) return UNIT_COLOR[t];
  return { barricade: '#ffb347', spikes: '#b9bcc6', zone: '#8f6cff', airstrike: '#f2a33a', gas: '#c8e65a', fire: '#ff7a2f', para: '#d8e4ff', arms: '#5ad1ff' }[t];
}
