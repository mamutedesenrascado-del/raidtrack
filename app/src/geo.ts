// Cálculos de percurso: leitura de GPX, distância ao percurso teórico, aderência, zonas proibidas.
// Funções puras (sem DOM nem mapa), testadas em test/geo.test.ts.

export type LatLon = [number, number];
export type TrackPt = [number, number, number]; // lat, lon, t (ms)

const R = 6371_000;
const rad = (d: number) => (d * Math.PI) / 180;

/** Distância em metros entre dois pontos (haversine) */
export function dist(a: LatLon, b: LatLon): number {
  const dLa = rad(b[0] - a[0]), dLo = rad(b[1] - a[1]);
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Comprimento de uma linha em metros */
export function lineLength(pts: LatLon[]): number {
  let d = 0;
  for (let i = 1; i < pts.length; i++) d += dist(pts[i - 1], pts[i]);
  return d;
}

/** Distância (m) de um ponto ao segmento a–b, em projeção local (válida para distâncias de raid) */
function distToSegment(p: LatLon, a: LatLon, b: LatLon): number {
  const k = Math.cos(rad(p[0]));
  const ax = (a[1] - p[1]) * k, ay = a[0] - p[0];
  const bx = (b[1] - p[1]) * k, by = b[0] - p[0];
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = ax + t * dx, y = ay + t * dy;
  return Math.sqrt(x * x + y * y) * (Math.PI / 180) * R;
}

/** Distância (m) de um ponto à linha mais próxima de um percurso */
export function distToRoute(p: LatLon, route: LatLon[]): number {
  if (route.length === 0) return Infinity;
  if (route.length === 1) return dist(p, route[0]);
  let best = Infinity;
  for (let i = 1; i < route.length; i++) best = Math.min(best, distToSegment(p, route[i - 1], route[i]));
  return best;
}

/** Ponto dentro de polígono (raio), em lat/lon — suficiente para zonas pequenas */
export function inPolygon(p: LatLon, poly: LatLon[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if (yi > p[0] !== yj > p[0] && p[1] < ((xj - xi) * (p[0] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Pontos do rasto entre a hora de partida e de chegada (se definidas) */
export function clip(track: TrackPt[], start?: number, end?: number): TrackPt[] {
  return track.filter((p) => (start === undefined || p[2] >= start) && (end === undefined || p[2] <= end));
}

/** Remove pontos de GPS impossíveis a pé (> 25 km/h desde o último ponto bom) */
export function dropJumps(track: TrackPt[]): TrackPt[] {
  const out: TrackPt[] = [];
  for (const p of track) {
    const q = out[out.length - 1];
    if (q) {
      const dt = (p[2] - q[2]) / 1000;
      if (dt > 0 && dist([q[0], q[1]], [p[0], p[1]]) / dt > 7) continue;
    }
    out.push(p);
  }
  return out;
}

/** Distância percorrida (m), sem saltos de GPS */
export function walked(track: TrackPt[]): number {
  const t = dropJumps(track);
  let d = 0;
  for (let i = 1; i < t.length; i++) d += dist([t[i - 1][0], t[i - 1][1]], [t[i][0], t[i][1]]);
  return d;
}

export interface Adherence {
  /** % da distância percorrida feita dentro do corredor do percurso */
  onRoutePct: number;
  /** % do percurso teórico coberto pela equipa */
  coveragePct: number;
  /** maior afastamento ao percurso (m) */
  maxDev: number;
  /** distância percorrida fora do corredor (m) */
  offRouteM: number;
}

/** Aderência de um rasto a um percurso teórico, com corredor de `corridor` metros */
export function adherence(raw: TrackPt[], route: LatLon[], corridor: number): Adherence | null {
  const track = dropJumps(raw);
  if (route.length < 2 || track.length < 2) return null;
  let inside = 0, total = 0, maxDev = 0;
  for (let i = 1; i < track.length; i++) {
    const a: LatLon = [track[i - 1][0], track[i - 1][1]], b: LatLon = [track[i][0], track[i][1]];
    const seg = dist(a, b);
    // amostra o segmento de 10 em 10 m para não dar crédito a um segmento que corta a direito
    const n = Math.max(1, Math.ceil(seg / 10));
    for (let k = 0; k < n; k++) {
      const f = (k + 0.5) / n;
      const p: LatLon = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
      const d = distToRoute(p, route);
      maxDev = Math.max(maxDev, d);
      total += seg / n;
      if (d <= corridor) inside += seg / n;
    }
  }
  // cobertura: amostras do percurso a cada 20 m, contam se algum ponto do rasto estiver no corredor
  const samples: LatLon[] = [];
  for (let i = 1; i < route.length; i++) {
    const n = Math.max(1, Math.ceil(dist(route[i - 1], route[i]) / 20));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      samples.push([route[i - 1][0] + (route[i][0] - route[i - 1][0]) * f, route[i - 1][1] + (route[i][1] - route[i - 1][1]) * f]);
    }
  }
  samples.push(route[route.length - 1]);
  const trackLine: LatLon[] = track.map((p) => [p[0], p[1]]);
  const covered = samples.filter((s) => distToRoute(s, trackLine) <= corridor).length;
  return {
    onRoutePct: total > 0 ? (inside / total) * 100 : 0,
    coveragePct: (covered / samples.length) * 100,
    maxDev,
    offRouteM: total - inside,
  };
}

export interface Gpx { name: string; route: LatLon[]; waypoints: { name: string; lat: number; lon: number }[] }

/** Lê um GPX (trk/trkseg/trkpt ou rte/rtept) e os pontos de passagem (wpt) */
export function parseGpx(xml: string): Gpx {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("O ficheiro não é um GPX válido.");
  const pt = (el: Element): LatLon => [Number(el.getAttribute("lat")), Number(el.getAttribute("lon"))];
  let route = [...doc.getElementsByTagName("trkpt")].map(pt);
  if (route.length < 2) route = [...doc.getElementsByTagName("rtept")].map(pt);
  route = route.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b));
  const waypoints = [...doc.getElementsByTagName("wpt")].map((w) => {
    const [lat, lon] = pt(w);
    return { name: w.getElementsByTagName("name")[0]?.textContent?.trim() || "Ponto", lat, lon };
  });
  if (route.length < 2 && waypoints.length < 2) throw new Error("O GPX não tem nenhum percurso (trk ou rte).");
  if (route.length < 2) route = waypoints.map((w) => [w.lat, w.lon] as LatLon); // só pontos: liga-os por ordem
  const name = doc.querySelector("trk > name, rte > name, metadata > name")?.textContent?.trim() || "Percurso";
  return { name, route, waypoints };
}

/** Texto para o ecrã OLED: sem acentos nem caracteres fora do ASCII */
export function oledText(s: string, max = 160): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

export const fmtKm = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`);
export function fmtDur(ms: number): string {
  const min = Math.round(ms / 60_000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")} min`;
}
