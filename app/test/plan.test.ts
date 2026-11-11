// Testes do plano (npx tsx test/plan.test.ts)
import { alongRoute, applyPlan, distToPolygon, migrate, normTime, parsePlanFile, passedPost, planFile, postEtas, routeMinutes, tilesFor } from "../src/plan";
import type { Raid } from "../src/types";
import type { LatLon } from "../src/geo";

let fail = 0;
const ok = (name: string, cond: boolean, extra = "") => { console.log(`${cond ? "✓" : "✗"} ${name} ${extra}`); if (!cond) fail++; };

// percurso reto para norte, 1 km, a subir 100 m
const route: LatLon[] = [[39, -8], [39.0045, -8], [39.009, -8]];
const r: Raid = migrate({
  started: 0, teams: {}, msgs: [], log: [],
  route: { name: "T", pts: route, ele: [100, 150, 200], wpts: [{ name: "Fim", lat: 39.009, lon: -8 }] }, speed: 4,
});
ok("migração: wpts → postos", r.posts?.length === 1 && r.posts[0].name === "Fim");
ok("alertas por omissão", r.alerts?.silentMin === 15);
const a = alongRoute([39.0045, -8.0005], route);
ok("ponto a meio: ~500 m ao longo, ~43 m ao lado", Math.abs(a.s - 500) < 5 && Math.abs(a.d - 43) < 3, `${a.s.toFixed(0)} / ${a.d.toFixed(0)}`);
r.posts!.push({ id: "m", name: "Meio", lat: 39.0045, lon: -8 });
const e = postEtas(r);
ok("postos ordenados ao longo do percurso", e[0].post.name === "Meio" && e[1].post.name === "Fim");
// 1 km a 4 km/h = 15 min + 100 m de subida = 12 min
ok("tempo previsto ao fim: ~27 min", Math.abs(e[1].min - 27) < 0.5, e[1].min.toFixed(1));
ok("tempo previsto a meio: ~13,5 min", Math.abs(e[0].min - 13.5) < 0.5, e[0].min.toFixed(1));
ok("tempo total do percurso", Math.abs(routeMinutes(r)! - 27) < 0.5);

// passagem no posto: ponto dentro do raio, ou segmento que passa perto entre duas posições
const post = { id: "x", name: "P", lat: 39.0045, lon: -8, radius: 40 };
ok("dentro do raio", passedPost(undefined, [39.0047, -8], post));
ok("fora do raio sem ponto anterior", !passedPost(undefined, [39.0055, -8], post));
ok("passou entre duas posições", passedPost([39.0040, -8.0001], [39.0052, -8.0001], post));
ok("salto grande não conta", !passedPost([39.0, -8], [39.02, -8], post));

const sq: LatLon[] = [[39, -8], [39, -7.999], [39.001, -7.999], [39.001, -8]];
ok("distância a uma zona ~ 111 m", Math.abs(distToPolygon([39.002, -7.9995], sq) - 111) < 2);

// ficheiro: ida e volta, sem estado do raid
r.teams[1] = { num: 1, short: "EQ1", long: "", color: "#000", track: [] };
r.sched = [{ id: "s", at: "18:00", text: "Regressem", dest: "all", sent: 123 }];
const txt = planFile(r, { template: "t", items: { "1/2/3": "AA==" } });
const f = parsePlanFile(txt);
ok("ficheiro tem o plano e não tem equipas", !!f.plan.route && !("teams" in f.plan) && f.tiles?.items["1/2/3"] === "AA==");
ok("mensagens programadas voltam a por enviar", f.plan.sched?.[0].sent === undefined);
const other: Raid = { started: 5, teams: { 9: { num: 9, short: "X", long: "", color: "#000", track: [] } }, msgs: [], log: [], name: "antigo", zones: [{ id: "z", name: "Z", poly: sq }] };
applyPlan(other, f.plan);
ok("aplicar plano mantém equipas e troca o plano", !!other.teams[9] && other.zones === undefined && other.route?.name === "T");
let bad = false; try { parsePlanFile('{"format":"outro"}'); } catch { bad = true; }
ok("ficheiro errado dá erro", bad);

const tiles = tilesFor([39, -8.01, 39.01, -8], 12, 17, 500);
ok("mosaicos: até 500, começa no nível 12", tiles.length <= 500 && tiles[0][0] === 12, String(tiles.length));
ok("horas: 9h30 → 09:30, 1830 → 18:30, 25:00 inválida", normTime("9h30") === "09:30" && normTime("1830") === "18:30" && normTime("25:00") === undefined);

console.log(fail ? `${fail} FALHARAM` : "OK: todos os testes passaram");
process.exit(fail ? 1 : 0);
