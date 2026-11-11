// Plano do raid: tempos previstos nos postos, ficheiro .raidtrack e mosaicos para o mapa offline.
// Funções puras, testadas em test/plan.test.ts.
import { dist, distToRoute, type LatLon } from "./geo";
import { DEFAULT_ALERTS, PLAN_KEYS, type Plan, type Post, type Raid, type Route } from "./types";

/** Versões antigas: postos dentro do percurso; zonas sem tipo */
export function migrate(r: Raid): Raid {
  if (!r.posts && r.route?.wpts?.length) r.posts = r.route.wpts.map((w, i) => ({ id: `p${i + 1}`, name: w.name, lat: w.lat, lon: w.lon }));
  for (const z of r.zones ?? []) z.kind ??= "proibida";
  r.alerts = { ...DEFAULT_ALERTS, ...(r.alerts ?? {}) };
  return r;
}

/** Posição de um ponto ao longo do percurso: metros desde o início e afastamento */
export function alongRoute(p: LatLon, route: LatLon[]): { s: number; d: number; seg: number; f: number } {
  let best = { s: 0, d: Infinity, seg: 0, f: 0 }, acc = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1], b = route[i];
    const len = dist(a, b);
    // fração ao longo do segmento em projeção local
    const k = Math.cos((p[0] * Math.PI) / 180);
    const ax = (b[1] - a[1]) * k, ay = b[0] - a[0], px = (p[1] - a[1]) * k, py = p[0] - a[0];
    const l2 = ax * ax + ay * ay;
    const f = l2 > 0 ? Math.max(0, Math.min(1, (px * ax + py * ay) / l2)) : 0;
    const q: LatLon = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const d = dist(p, q);
    if (d < best.d) best = { s: acc + len * f, d, seg: i - 1, f };
    acc += len;
  }
  return best;
}

/** Subida acumulada (m) desde o início do percurso até `s` metros */
function climbTo(route: Route, s: number): number {
  const e = route.ele;
  if (!e || e.length !== route.pts.length) return 0;
  let acc = 0, up = 0;
  for (let i = 1; i < route.pts.length; i++) {
    const len = dist(route.pts[i - 1], route.pts[i]);
    const f = acc + len <= s ? 1 : Math.max(0, (s - acc) / len);
    const de = (e[i] - e[i - 1]) * f;
    if (de > 0) up += de;
    acc += len;
    if (acc >= s) break;
  }
  return up;
}

export interface PostEta { post: Post; s: number; climb: number; /** minutos desde a partida */ min: number; off: number }

/** Tempo previsto até cada posto: distância ao longo do percurso à velocidade média + 1 h por cada 500 m de subida */
export function postEtas(plan: Plan): PostEta[] {
  const posts = plan.posts ?? [];
  const route = plan.route;
  const speed = plan.speed && plan.speed > 0 ? plan.speed : 3.5;
  if (!route || route.pts.length < 2) return posts.map((post) => ({ post, s: NaN, climb: 0, min: NaN, off: NaN }));
  return posts
    .map((post) => {
      const a = alongRoute([post.lat, post.lon], route.pts);
      const climb = climbTo(route, a.s);
      return { post, s: a.s, climb, min: (a.s / 1000 / speed) * 60 + (climb / 500) * 60, off: a.d };
    })
    .sort((x, y) => x.s - y.s);
}
/** Tempo total previsto do percurso (min) */
export function routeMinutes(plan: Plan): number | null {
  const r = plan.route;
  if (!r || r.pts.length < 2) return null;
  const len = r.pts.reduce((a, p, i) => (i ? a + dist(r.pts[i - 1], p) : 0), 0);
  return (len / 1000 / (plan.speed || 3.5)) * 60 + (climbTo(r, len) / 500) * 60;
}

/** A equipa passou no posto entre a posição anterior e a atual? (o GPS só envia de minuto a minuto) */
export function passedPost(prev: LatLon | undefined, cur: LatLon, post: Post): boolean {
  const r = post.radius ?? 40;
  const p: LatLon = [post.lat, post.lon];
  if (dist(cur, p) <= r) return true;
  return !!prev && dist(prev, cur) < 800 && distToRoute(p, [prev, cur]) <= r;
}

/** Distância (m) de um ponto ao contorno de um polígono (0 se estiver dentro é tratado por quem chama) */
export function distToPolygon(p: LatLon, poly: LatLon[]): number {
  return distToRoute(p, [...poly, poly[0]]);
}

// ───────────── Ficheiro .raidtrack ─────────────
export const PLAN_FORMAT = "raidtrack-plano";
export interface PlanFile { format: string; version: number; saved: string; plan: Plan; tiles?: { template: string; items: Record<string, string> } }

export function planOf(r: Raid): Plan {
  const p: Plan = {};
  for (const k of PLAN_KEYS) if (r[k] !== undefined) (p as Record<string, unknown>)[k] = structuredClone(r[k]);
  // as mensagens programadas voltam a "por enviar" no ficheiro
  p.sched = p.sched?.map(({ sent: _sent, ...s }) => s);
  return p;
}
export function planFile(r: Raid, tiles?: PlanFile["tiles"]): string {
  const f: PlanFile = { format: PLAN_FORMAT, version: 1, saved: new Date().toISOString(), plan: planOf(r), ...(tiles ? { tiles } : {}) };
  return JSON.stringify(f);
}
export function parsePlanFile(text: string): PlanFile {
  let f: PlanFile;
  try { f = JSON.parse(text) as PlanFile; } catch { throw new Error("O ficheiro não é um plano RaidTrack válido."); }
  if (f?.format !== PLAN_FORMAT || typeof f.plan !== "object") throw new Error("O ficheiro não é um plano RaidTrack (.raidtrack).");
  if (f.version > 1) throw new Error("Este plano foi feito numa versão mais recente da app. Atualize a app (recarregue com Internet).");
  return f;
}
/** Aplica o plano ao raid (mantém equipas, posições, mensagens e registo) */
export function applyPlan(r: Raid, p: Plan): Raid {
  for (const k of PLAN_KEYS) delete (r as Partial<Raid>)[k];
  Object.assign(r, structuredClone(p));
  return migrate(r);
}

// ───────────── Mosaicos ─────────────
export const TOPO = (z: number, x: number, y: number) => `https://${"abc"[Math.abs(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`;
export const TOPO_TEMPLATE = "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png";
export const lon2x = (lon: number, z: number) => Math.floor(((lon + 180) / 360) * 2 ** z);
export function lat2y(lat: number, z: number) { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); }

/** Limites de tudo o que está no plano, com margem (s, o, n, e) */
export function planBounds(p: Plan, marginM = 400): [number, number, number, number] | null {
  const pts: LatLon[] = [...(p.route?.pts ?? []), ...(p.recon ?? []).flatMap((r) => r.pts), ...(p.posts ?? []).map((x) => [x.lat, x.lon] as LatLon), ...(p.zones ?? []).flatMap((z) => z.poly)];
  if (!pts.length) return null;
  const lats = pts.map((q) => q[0]), lons = pts.map((q) => q[1]);
  const dLat = marginM / 111_320, mid = (Math.max(...lats) + Math.min(...lats)) / 2;
  const dLon = marginM / (111_320 * Math.cos((mid * Math.PI) / 180));
  return [Math.min(...lats) - dLat, Math.min(...lons) - dLon, Math.max(...lats) + dLat, Math.max(...lons) + dLon];
}
/** Mosaicos que cobrem os limites, do nível z0 até ao maior nível que não passe de `max` mosaicos */
export function tilesFor(b: [number, number, number, number], z0 = 12, z1 = 17, max = 500): [number, number, number][] {
  let out: [number, number, number][] = [];
  for (let z = z0; z <= z1; z++) {
    const level: [number, number, number][] = [];
    for (let x = lon2x(b[1], z); x <= lon2x(b[3], z); x++) for (let y = lat2y(b[2], z); y <= lat2y(b[0], z); y++) level.push([z, x, y]);
    if (out.length + level.length > max) break;
    out = out.concat(level);
  }
  return out;
}

/** "9h30", "930", "9.30" → "09:30" */
export function normTime(v: string): string | undefined {
  const m = /^(\d{1,2})\s*[:h.]?\s*(\d{2})$/.exec(v.trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return undefined;
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}
