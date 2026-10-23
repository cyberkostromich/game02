import type { MapData } from './sim/grid';

export interface Mission {
  id: string;
  title: string;
  brief: string;
  population: number;
  budget: number;
  seed: number;
  /** outbreak origins by landmark name: visible zombies + hidden carriers within r */
  outbreak: { at: string; n: number; infected: number; r: number }[];
  /** extra crowds around landmarks */
  crowds?: { at: string; n: number; r: number }[];
}

export const MISSIONS: Mission[] = [
  {
    id: 'times-square',
    title: 'Ночь на Таймс-сквер',
    brief: 'Первый очаг — в толпе туристов на Таймс-сквер. Перекройте улицы, расставьте снайперов на длинных авеню и откройте эвакуацию.',
    population: 14000,
    budget: 2400,
    seed: 11,
    outbreak: [{ at: 'Таймс-сквер', n: 6, infected: 40, r: 90 }],
    crowds: [{ at: 'Таймс-сквер', n: 1500, r: 120 }],
  },
  {
    id: 'penn',
    title: 'Час пик: Пенн-стейшн',
    brief: 'Заражённый вышел из поезда на Пенн-стейшн. Вокруг вокзала и Мэдисон-сквер-гарден — плотная толпа пассажиров.',
    population: 18000,
    budget: 2800,
    seed: 23,
    outbreak: [{ at: 'Пенн-стейшн', n: 8, infected: 70, r: 110 }],
    crowds: [{ at: 'Пенн-стейшн', n: 2500, r: 160 }],
  },
  {
    id: 'grand-central',
    title: 'Grand Central',
    brief: 'Вспышка в главном зале Grand Central. Восток Мидтауна — узкие улицы и высотки: снайперам нужен обзор, миномётам — цели без мирных.',
    population: 22000,
    budget: 3200,
    seed: 37,
    outbreak: [{ at: 'Grand Central', n: 10, infected: 90, r: 120 }],
    crowds: [{ at: 'Grand Central', n: 2500, r: 150 }],
  },
  {
    id: 'two-fronts',
    title: 'Два фронта',
    brief: 'Почти одновременно — Брайант-парк и Эмпайр-стейт-билдинг. Ресурсов на две полноценные линии обороны не хватит.',
    population: 26000,
    budget: 4000,
    seed: 41,
    outbreak: [
      { at: 'Брайант-парк', n: 8, infected: 60, r: 100 },
      { at: 'Эмпайр-стейт-билдинг', n: 8, infected: 60, r: 100 },
    ],
  },
  {
    id: 'midtown-falls',
    title: 'Мидтаун пал',
    brief: 'Три очага: автовокзал Порт-Аторити, Рокфеллер-центр и Macy\'s. Спасите кого сможете.',
    population: 30000,
    budget: 5000,
    seed: 53,
    outbreak: [
      { at: 'Автовокзал Порт-Аторити', n: 8, infected: 60, r: 100 },
      { at: 'Рокфеллер-центр', n: 8, infected: 60, r: 100 },
      { at: "Macy's", n: 8, infected: 60, r: 100 },
    ],
    crowds: [{ at: 'Рокфеллер-центр', n: 2000, r: 140 }],
  },
];

export function landmark(map: MapData, name: string): { x: number; y: number } {
  const l = map.labels.find((q) => q.t === name);
  if (!l) throw new Error(`нет ориентира «${name}» на карте`);
  return { x: l.x, y: l.y };
}
