// Converts raw OpenStreetMap API tiles (map.json) into the compact game map.
// Usage: node tools/build-map.mjs <dir-with-osm-tiles> [out.json]
// Data © OpenStreetMap contributors, ODbL.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const out = process.argv[3] ?? 'public/maps/midtown.json';
if (!dir) throw new Error('usage: build-map.mjs <tiles-dir> [out.json]');

// Midtown Manhattan, rotated so avenues run vertically (uptown = up).
const CENTER = { lat: 40.755, lon: -73.984 };
const ROT_DEG = 29; // Manhattan street grid is ~29° east of true north
const W = 2000; // crosstown, m
const H = 2600; // along avenues, m
const Q = 2; // coordinates are stored as ints in 1/Q m

const nodes = new Map();
const ways = new Map();
const rels = new Map();
for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
  const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const e of data.elements) {
    if (e.type === 'node') nodes.set(e.id, e);
    else if (e.type === 'way') ways.set(e.id, e);
    else if (e.type === 'relation') rels.set(e.id, e);
  }
}

const kx = 111320 * Math.cos((CENTER.lat * Math.PI) / 180);
const ky = 110540;
const rc = Math.cos((ROT_DEG * Math.PI) / 180);
const rs = Math.sin((ROT_DEG * Math.PI) / 180);
function project(n) {
  const x = (n.lon - CENTER.lon) * kx;
  const y = (n.lat - CENTER.lat) * ky;
  const u = x * rc - y * rs;
  const v = x * rs + y * rc;
  return [u + W / 2, H / 2 - v];
}
const wayPts = (w) => w.nodes.map((id) => nodes.get(id)).filter(Boolean).map(project);

function bboxHits(pts, margin = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
  }
  return x1 >= -margin && y1 >= -margin && x0 <= W + margin && y0 <= H + margin;
}

function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  const [ax, ay] = pts[0];
  const [bx, by] = pts[pts.length - 1];
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy);
  let best = -1, bi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    // closed rings start and end on the same point: fall back to point distance
    const d = len > 0
      ? Math.abs((pts[i][0] - ax) * dy - (pts[i][1] - ay) * dx) / len
      : Math.hypot(pts[i][0] - ax, pts[i][1] - ay);
    if (d > best) { best = d; bi = i; }
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, bi + 1), eps).slice(0, -1), ...simplify(pts.slice(bi), eps)];
}

const flat = (pts) => pts.flatMap(([x, y]) => [Math.round(x * Q), Math.round(y * Q)]);

// Joins outer member ways of a multipolygon into closed rings.
function joinRings(memberWays) {
  const segs = memberWays.map((w) => w.nodes.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let grown = true;
    while (ring[0] !== ring[ring.length - 1] && grown) {
      grown = false;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i];
        const end = ring[ring.length - 1];
        if (s[0] === end) ring = ring.concat(s.slice(1));
        else if (s[s.length - 1] === end) ring = ring.concat(s.slice(0, -1).reverse());
        else continue;
        segs.splice(i, 1);
        grown = true;
        break;
      }
    }
    if (ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

function heightOf(tags) {
  const h = parseFloat(tags.height);
  if (h > 0) return h;
  const lv = parseFloat(tags['building:levels']);
  if (lv > 0) return lv * 3.5;
  return 15;
}

const buildings = [];
const parks = [];
const water = [];
const roads = [];
const labels = [];

const isBuilding = (t) => t.building && t.building !== 'no';
const isPark = (t) =>
  ['park', 'garden', 'pitch', 'playground'].includes(t.leisure) ||
  ['grass', 'village_green'].includes(t.landuse);
const isWater = (t) => t.natural === 'water';
const ROAD_CLASS = { motorway: 4, trunk: 4, primary: 3, secondary: 3, tertiary: 2, residential: 1, unclassified: 1, pedestrian: 0, living_street: 0 };

function addArea(tags, pts) {
  if (pts.length < 4 || !bboxHits(pts, 20)) return;
  const s = simplify(pts, 0.4);
  if (isBuilding(tags)) buildings.push([Math.round(heightOf(tags)), ...flat(s)]);
  else if (isPark(tags)) parks.push(flat(s));
  else if (isWater(tags)) water.push(flat(s));
}

const usedInRel = new Set();
for (const r of rels.values()) {
  const t = r.tags ?? {};
  if (t.type !== 'multipolygon' || !(isBuilding(t) || isPark(t) || isWater(t))) continue;
  const outers = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref));
  if (outers.some((w) => !w)) continue;
  for (const w of outers) usedInRel.add(w.id);
  for (const ring of joinRings(outers)) {
    const pts = ring.map((id) => nodes.get(id)).filter(Boolean).map(project);
    addArea(t, pts);
  }
}

for (const w of ways.values()) {
  const t = w.tags ?? {};
  const closed = w.nodes[0] === w.nodes[w.nodes.length - 1];
  if (closed && !usedInRel.has(w.id) && (isBuilding(t) || isPark(t) || isWater(t))) {
    addArea(t, wayPts(w));
    continue;
  }
  const cls = ROAD_CLASS[t.highway];
  if (cls !== undefined && !t.tunnel && t.layer === undefined) {
    const pts = wayPts(w);
    if (pts.length >= 2 && bboxHits(pts, 20)) roads.push({ c: cls, n: t.name ?? '', p: flat(simplify(pts, 0.5)) });
  }
}

// Landmarks: label position = centroid of the first matching feature.
const LANDMARKS = {
  'Empire State Building': 'Эмпайр-стейт-билдинг',
  'Grand Central Terminal': 'Grand Central',
  'Bryant Park': 'Брайант-парк',
  'Madison Square Garden': 'Мэдисон-сквер-гарден',
  'Chrysler Building': 'Крайслер-билдинг',
  'Rockefeller Center': 'Рокфеллер-центр',
  'Radio City Music Hall': 'Радио-сити',
  'New York Public Library': 'Публичная библиотека',
  'Stephen A. Schwarzman Building': 'Публичная библиотека',
  'Port Authority Bus Terminal': 'Автовокзал Порт-Аторити',
  'Herald Square': 'Хералд-сквер',
  'Times Square': 'Таймс-сквер',
  'Madison Square Park': 'Мэдисон-сквер-парк',
  'Macy\'s': 'Macy\'s',
  'Moynihan Train Hall': 'Пенн-стейшн',
  'Pennsylvania Station': 'Пенн-стейшн',
};
function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p[0]; y += p[1]; }
  return [x / pts.length, y / pts.length];
}
// The same name is carried by stations, plaques and land-use areas: prefer the
// element that is the place itself.
function labelScore(t) {
  if (t.place === 'square' || t.highway === 'pedestrian') return 5;
  if (t.building || t.leisure === 'park') return 4;
  if (t.railway === 'station' || t.amenity) return 3;
  if (t.landuse) return 0;
  return 1;
}
const best = new Map();
const consider = (tags, pts) => {
  const ru = LANDMARKS[tags.name];
  if (!ru || !pts.length) return;
  const [x, y] = centroid(pts);
  if (x < 0 || y < 0 || x > W || y > H) return;
  const score = labelScore(tags);
  const prev = best.get(ru);
  if (!prev || score > prev.score) best.set(ru, { score, x, y });
};
for (const w of ways.values()) if (w.tags?.name) consider(w.tags, wayPts(w));
for (const r of rels.values()) {
  if (!r.tags?.name) continue;
  const pts = r.members.filter((m) => m.type === 'way' && m.role !== 'inner').flatMap((m) => (ways.get(m.ref) ? wayPts(ways.get(m.ref)) : []));
  consider(r.tags, pts);
}
for (const n of nodes.values()) if (n.tags?.name) consider(n.tags, [project(n)]);
for (const [t, v] of best) labels.push({ t, x: Math.round(v.x), y: Math.round(v.y) });

const map = {
  name: 'Мидтаун, Манхэттен',
  attribution: '© OpenStreetMap contributors (ODbL)',
  center: CENTER,
  rotation: ROT_DEG,
  width: W,
  height: H,
  q: Q,
  buildings,
  parks,
  water,
  roads,
  labels,
};
fs.writeFileSync(out, JSON.stringify(map));
console.log(
  `${out}: ${buildings.length} buildings, ${parks.length} parks, ${water.length} water, ${roads.length} roads, labels: ${labels.map((l) => l.t).join(', ')}; ${(fs.statSync(out).size / 1024).toFixed(0)} KiB`,
);
