// All gameplay numbers live here. Distances in metres, time in seconds.
export const CFG = {
  sim: {
    hz: 10,
    cell: 4, // walk-grid cell size
    fieldEvery: 0.7, // prey + zombie fields, recomputed on alternating ticks
    evacFieldEvery: 1.5,
    hashCell: 8,
  },
  civilian: {
    walk: 1.2,
    run: 2.3,
    panicRadius: 24, // sees a zombie within this distance -> runs
    speedSpread: [0.7, 1.2], // per-person speed factor
    turnChance: 0.04, // per tick, while wandering
  },
  zombie: {
    speedMin: 1.6,
    speedMax: 3.4,
    runnerShare: 0.12, // fast zombies
    runnerSpeed: 4.6,
    senseRadius: 140, // zombies only track prey this close; further away they wander
    biteRange: 1.8,
    biteCooldown: 1.2,
    incubationMin: 3,
    incubationMax: 9,
    unitDps: 5, // damage to a unit per zombie in contact
    barricadeDps: 3,
    crowdWeight: 1, // flow-field penalty per zombie already in a cell
    barricadeCost: 60, // flow-field cost of pushing through a barricade cell
  },
  outbreak: {
    exclusion: 160, // no deployments this close to an outbreak during planning
    incubationMax: 35, // hidden carriers turn within this many seconds of the start
  },
  bounty: 2, // $ per zombie killed, paid during the battle
  lostBelow: 0.1, // the city is lost once fewer than this share can still be saved
  // Friendly fire: mortar refuses a target if civilians in the blast exceed
  // zombies * this ratio.
  mortarCivilianRatio: 0.34,
  units: {
    // magazine: shots carried; refilled only inside an intact safe zone
    sniper: { cost: 200, hp: 30, range: 190, reload: 1.8, accuracy: 0.88, magazine: 30 },
    turret: { cost: 300, hp: 240, range: 75, reload: 0.2, accuracy: 0.45, magazine: 300 },
    mortar: { cost: 450, hp: 50, rangeMin: 50, range: 340, reload: 3.2, blast: 12, flight: 1.8, magazine: 14 },
    garrison: { cost: 400, hp: 600, range: 95, reload: 0.3, accuracy: 0.65, magazine: 300 }, // assault squad in a building
    mines: { cost: 200, hp: 1, radius: 10, blast: 4, charges: 12, reload: 0.4 },
    evac: { cost: 250, hp: 120, radius: 300, rate: 10, pickup: 12 }, // pickup: m around the point
    heli: { cost: 650, hp: 1, range: 80, reload: 0.08, accuracy: 0.45, speed: 28, duration: 70 },
    // building specialisations, only inside a safe zone
    medic: { cost: 300, hp: 300, radius: 30, cureRate: 1, healRadius: 90, healRate: 4 },
    repair: { cost: 250, hp: 300, radius: 110, rate: 12 },
    barracks: { cost: 350, hp: 400, radius: 30, rate: 1, max: 40 },
  },
  recruit: { range: 40, reload: 1.3, accuracy: 0.35, speed: 1.9, guard: 80, seek: 160 }, // seek: free squads hunt this far
  // safe zones: a circle around every evac point, plus rectangles the player draws
  safeZone: { radius: 170, costPerM2: 0.01, minSide: 24, maxArea: 160000, attract: 260 },
  sight: {
    eye: 2, // m above ground/roof
    sniperRoofBonus: 0.4, // extra range per metre of roof height
    sniperRoofBonusMax: 90,
  },
  barricade: { costPerCell: 12, hp: 260, maxCells: 24 },
  spikes: { costPerCell: 3, maxCells: 30, slow: 0.4, killRate: 0.25 }, // killRate: chance per second
  levels: { max: 3, costShare: 0.6, rate: 0.5, range: 0.1, hp: 0.4 }, // per level above 1
  // movable units walk the streets at these speeds (m/s); they can't shoot on the march
  move: { sniper: 3, garrison: 2.6, turret: 1.3, mortar: 1.3, maxPath: 1500 },
  supply: { breachRadius: 25 }, // a zombie this close to the evac point cuts the supply
  abilities: {
    gas: { cost: 200, cooldown: 25, radius: 30, duration: 10 },
    fire: { cost: 250, cooldown: 25, length: 120, width: 14, duration: 12, killRate: 0.9 },
    para: { cost: 400, cooldown: 40, squad: 10, delay: 3 },
    arms: { cost: 300, cooldown: 40, radius: 40, max: 30 },
  },
  airstrike: { cost: 500, length: 240, width: 20, delay: 3, bombs: 16, interval: 0.11 },
  stars: [0.5, 0.7, 0.85], // share of population saved for 1/2/3 stars
  upgrades: {
    budget: { title: 'Бюджет +12%', max: 3, step: 0.12 },
    sniperRange: { title: 'Снайперы: дальность +15%', max: 3, step: 0.15 },
    turretRate: { title: 'Турели: скорострельность +15%', max: 3, step: 0.15 },
    mortarBlast: { title: 'Миномёты: радиус +12%', max: 3, step: 0.12 },
    evacRate: { title: 'Эвакуация: пропускная способность +25%', max: 3, step: 0.25 },
    airstrikeWidth: { title: 'Авиаудар: ширина +20%', max: 2, step: 0.2 },
  },
} as const;

export type UnitType = keyof typeof CFG.units;
export type AbilityId = keyof typeof CFG.abilities;
export type UpgradeId = keyof typeof CFG.upgrades;
export type Upgrades = Partial<Record<UpgradeId, number>>;
