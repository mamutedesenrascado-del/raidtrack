// Testes dos cálculos de percurso (npx tsx test/geo.test.ts)
import { JSDOM } from "jsdom";
import { adherence, clip, dist, distToRoute, inPolygon, oledText, parseGpx, walked, type LatLon, type TrackPt } from "../src/geo";

(globalThis as unknown as { DOMParser: unknown }).DOMParser = new JSDOM().window.DOMParser;
let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${name} ${extra}`); if (!cond) fail++; };

// 1 grau de latitude ≈ 111,2 km
ok("dist 0,01° lat ≈ 1112 m", Math.abs(dist([39, -8], [39.01, -8]) - 1112) < 3, dist([39, -8], [39.01, -8]).toFixed(1));

// Percurso: linha reta para norte, 1 km
const route: LatLon[] = [[39, -8], [39.009, -8]];
const east = (m: number) => m / (111_320 * Math.cos((39 * Math.PI) / 180)); // graus de longitude para m metros
ok("ponto 30 m a leste está a ~30 m", Math.abs(distToRoute([39.004, -8 + east(30)], route) - 30) < 1, distToRoute([39.004, -8 + east(30)], route).toFixed(1));
ok("ponto depois do fim mede ao extremo", Math.abs(distToRoute([39.0099, -8], route) - 100) < 2);

// Equipa que segue o percurso a 10 m: 100 % no percurso, ~100 % coberto
const t0 = Date.parse("2026-11-07T09:00:00Z");
const follow: TrackPt[] = Array.from({ length: 11 }, (_, i) => [39 + i * 0.0009, -8 + east(10), t0 + i * 60_000]);
const a1 = adherence(follow, route, 50)!;
ok("segue a 10 m → 100 % no percurso", a1.onRoutePct > 99.9, a1.onRoutePct.toFixed(1));
ok("segue a 10 m → cobre > 95 %", a1.coveragePct > 95, a1.coveragePct.toFixed(1));

// Equipa que faz metade do percurso e depois se desvia 200 m para leste
const half: TrackPt[] = [
  ...Array.from({ length: 6 }, (_, i) => [39 + i * 0.0009, -8, t0 + i * 60_000] as TrackPt),
  ...Array.from({ length: 5 }, (_, i) => [39.0045 + (i + 1) * 0.0009, -8 + east(200), t0 + (6 + i) * 60_000] as TrackPt),
];
const a2 = adherence(half, route, 50)!;
ok("meio percurso + desvio → ~50 % no percurso", a2.onRoutePct > 40 && a2.onRoutePct < 65, a2.onRoutePct.toFixed(1));
ok("meio percurso + desvio → cobre ~50 %", a2.coveragePct > 40 && a2.coveragePct < 62, a2.coveragePct.toFixed(1));
ok("desvio máximo ~200 m", Math.abs(a2.maxDev - 200) < 10, a2.maxDev.toFixed(0));

// Distância percorrida e salto de GPS ignorado
ok("distância ~1 km", Math.abs(walked(follow) - 1000) < 10, walked(follow).toFixed(0));
const jump: TrackPt[] = [[39, -8, t0], [39.05, -8, t0 + 10_000], [39.0009, -8, t0 + 60_000]];
ok("salto de GPS (5 km em 10 s) ignorado → ~100 m", Math.abs(walked(jump) - 100) < 3, walked(jump).toFixed(0));
ok("clip pela hora", clip(follow, t0 + 120_000, t0 + 300_000).length === 4);

// Zona proibida
const zone: LatLon[] = [[39.002, -8.001], [39.002, -7.999], [39.003, -7.999], [39.003, -8.001]];
ok("ponto dentro da zona", inPolygon([39.0025, -8], zone));
ok("ponto fora da zona", !inPolygon([39.004, -8], zone));

// GPX
const gpx = `<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
<wpt lat="39.0" lon="-8.0"><name>Posto 1</name></wpt>
<trk><name>Raid Pioneiros</name><trkseg><trkpt lat="39.0" lon="-8.0"/><trkpt lat="39.001" lon="-8.0"/><trkpt lat="39.002" lon="-8.001"/></trkseg></trk></gpx>`;
const g = parseGpx(gpx);
ok("GPX: nome, 3 pontos, 1 posto", g.name === "Raid Pioneiros" && g.route.length === 3 && g.waypoints[0].name === "Posto 1");
let bad = false;
try { parseGpx("<gpx></gpx>"); } catch { bad = true; }
ok("GPX vazio dá erro claro", bad);

ok("texto OLED sem acentos", oledText("Atenção: regressem à base já!") === "Atencao: regressem a base ja!", oledText("Atenção: regressem à base já!"));

console.log(fail ? `${fail} FALHARAM` : "OK: todos os testes passaram");
process.exit(fail ? 1 : 0);
