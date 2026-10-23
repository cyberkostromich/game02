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
  /** hits a zombie takes (grows in later scenarios, as in the original) */
  zombieHp?: number;
  /** extra crowds around landmarks */
  crowds?: { at: string; n: number; r: number }[];
}

export const MISSIONS: Mission[] = [
  {
    id: 'times-square',
    title: 'Ночь на Таймс-сквер',
    brief: 'Первый очаг — в толпе туристов на Таймс-сквер. Перекройте улицы, расставьте снайперов на длинных авеню и откройте эвакуацию.',
    population: 20000,
    budget: 4500,
    seed: 11,
    outbreak: [{ at: 'Таймс-сквер', n: 4, infected: 15, r: 70 }],
    crowds: [{ at: 'Таймс-сквер', n: 800, r: 120 }],
  },
  {
    id: 'penn',
    title: 'Час пик: Пенн-стейшн',
    brief: 'Заражённый вышел из поезда на Пенн-стейшн. Вокруг вокзала и Мэдисон-сквер-гарден — плотная толпа пассажиров.',
    population: 24000,
    budget: 4200,
    seed: 23,
    outbreak: [{ at: 'Пенн-стейшн', n: 8, infected: 70, r: 110 }],
    crowds: [{ at: 'Пенн-стейшн', n: 2500, r: 160 }],
  },
  {
    id: 'grand-central',
    title: 'Grand Central',
    brief: 'Вспышка в главном зале Grand Central. Восток Мидтауна — узкие улицы и высотки: снайперам нужен обзор, миномётам — цели без мирных.',
    population: 28000,
    budget: 4800,
    seed: 37,
    outbreak: [{ at: 'Grand Central', n: 10, infected: 70, r: 120 }],
    crowds: [{ at: 'Grand Central', n: 2500, r: 150 }],
  },
  {
    id: 'two-fronts',
    title: 'Два фронта',
    brief: 'Почти одновременно — Брайант-парк и Эмпайр-стейт-билдинг. Ресурсов на две полноценные линии обороны не хватит.',
    population: 32000,
    budget: 5700,
    seed: 41,
    zombieHp: 2,
    outbreak: [
      { at: 'Брайант-парк', n: 10, infected: 90, r: 110 },
      { at: 'Эмпайр-стейт-билдинг', n: 10, infected: 90, r: 110 },
    ],
  },
  {
    id: 'midtown-falls',
    title: 'Мидтаун пал',
    brief: 'Три очага: автовокзал Порт-Аторити, Рокфеллер-центр и Macy\'s. Спасите кого сможете.',
    population: 38000,
    budget: 7500,
    seed: 53,
    zombieHp: 2,
    outbreak: [
      { at: 'Автовокзал Порт-Аторити', n: 8, infected: 60, r: 100 },
      { at: 'Рокфеллер-центр', n: 8, infected: 60, r: 100 },
      { at: "Macy's", n: 8, infected: 60, r: 100 },
    ],
    crowds: [{ at: 'Рокфеллер-центр', n: 2000, r: 140 }],
  },
  {
    id: 'columbus',
    title: 'Колумбус-серкл',
    brief: 'Очаг у Колумбус-серкл, рядом Центральный парк и Карнеги-холл. Парк — открытое поле: орда разбежится во все стороны.',
    population: 30000,
    budget: 6900,
    seed: 61,
    zombieHp: 2,
    outbreak: [{ at: 'Колумбус-серкл', n: 12, infected: 90, r: 120 }],
    crowds: [{ at: 'Центральный парк', n: 3000, r: 250 }],
  },
  {
    id: 'east-side',
    title: 'Ист-Сайд',
    brief: 'Вспышка у штаб-квартиры ООН и Grand Central. Спину прикрывает Ист-Ривер — эвакуируйте людей к набережной.',
    population: 34000,
    budget: 7800,
    seed: 71,
    zombieHp: 2,
    outbreak: [
      { at: 'Штаб-квартира ООН', n: 10, infected: 70, r: 110 },
      { at: 'Grand Central', n: 10, infected: 70, r: 110 },
    ],
  },
];

export function landmark(map: MapData, name: string): { x: number; y: number } {
  const l = map.labels.find((q) => q.t === name);
  if (!l) throw new Error(`нет ориентира «${name}» на карте`);
  return { x: l.x, y: l.y };
}
