// Modo demonstração: simula 3 equipas para treinar operadores e testar a app sem rádio.
import type { Dest, Link, LinkEvents } from "./link";
import { decode, encodeRead, encodeSos, PORT_PRIVATE } from "./protocol";
import { dist, type LatLon } from "./geo";

const BASE = 0x0ba5e000;
const CENTRO = { lat: 39.6965, lon: -8.2924 };
const MSGS = ["Chegamos ao posto", "Tudo bem", "Saimos do posto", "Precisamos de agua"];

/** Percurso e zona proibida da demonstração (carregados pela app no modo demo) */
export const DEMO_ROUTE: LatLon[] = [
  [39.6965, -8.2924], [39.6990, -8.2900], [39.7012, -8.2928], [39.7004, -8.2972], [39.6978, -8.2986], [39.6958, -8.2955], [39.6965, -8.2924],
];
export const DEMO_WPTS = [
  { name: "Posto 1", lat: 39.6990, lon: -8.2900 }, { name: "Posto 2", lat: 39.7004, lon: -8.2972 }, { name: "Posto 3", lat: 39.6958, lon: -8.2955 },
];
export const DEMO_ZONE: LatLon[] = [[39.6926, -8.3006], [39.6926, -8.2974], [39.6904, -8.2974], [39.6904, -8.3006]];

/** Ponto a `s` metros do início de um caminho (ou null se já passou o fim) */
function along(path: LatLon[], s: number): LatLon | null {
  for (let i = 1; i < path.length; i++) {
    const d = dist(path[i - 1], path[i]);
    if (s <= d) { const f = s / d; return [path[i - 1][0] + (path[i][0] - path[i - 1][0]) * f, path[i - 1][1] + (path[i][1] - path[i - 1][1]) * f]; }
    s -= d;
  }
  return null;
}

interface SimTeam {
  num: number; short: string; long: string;
  lat: number; lon: number; hdg: number; bat: number;
  sosSeq: number; sosActive: boolean; sosAcked: boolean; nextSos: number;
  /** minutos desde o último contacto, para equipas que deixaram de ser ouvidas */
  silentMin?: number;
  /** caminho fixo (segue o percurso ou vai para a zona proibida), metros feitos e paragem */
  path?: LatLon[]; s?: number; stopAt?: number; wait?: number;
}

export function startSim(ev: LinkEvents): Link {
  void PORT_PRIVATE;
  const t0 = Date.now();
  const teams: SimTeam[] = [
    ["EQ1", "Equipa 1 Lobos", 30], ["EQ2", "Equipa 2 Falcoes", 150], ["EQ3", "Equipa 3 Linces", 260],
    ["EQ4", "Equipa 4 Raposas", 200, 4], ["EQ5", "Equipa 5 Corujas", 330, 12],
  ].map(([s, l, h, silent], i) => ({
    num: 0x1000a0 + i, short: s as string, long: l as string,
    lat: CENTRO.lat + (Math.random() - 0.5) * 0.002, lon: CENTRO.lon + (Math.random() - 0.5) * 0.002,
    hdg: h as number, bat: 95 - i * 7, sosSeq: 100 + i, sosActive: false, sosAcked: false, nextSos: 0,
    silentMin: silent as number | undefined,
  }));
  // Equipas caladas ficam mais longe da base, onde o sinal falhou
  teams.filter((t) => t.silentMin).forEach((t, k) => { t.lat += 0.006 * (k ? -1 : 1); t.lon += 0.009 * (k ? 1 : -1); });
  const live = teams.filter((t) => !t.silentMin);
  // EQ1 segue o percurso mas corta caminho entre o posto 2 e o 3; EQ3 vai parar dentro da zona proibida
  const STEP = 18; // m por passo de 3 s (6 m/s: a demonstração anda acelerada)
  const eq1 = teams[0], eq3 = teams[2];
  eq1.path = DEMO_ROUTE.filter((_, i) => i !== 4); eq1.s = 12 * STEP * 2;
  eq3.path = [[CENTRO.lat, CENTRO.lon], [39.6915, -8.2990], [39.6885, -8.3020]]; eq3.s = 20 * STEP; eq3.stopAt = dist(eq3.path[0], eq3.path[1]); eq3.wait = 14;
  for (const t of [eq1, eq3]) { const p = along(t.path!, t.s!)!; t.lat = p[0]; t.lon = p[1]; }

  ev.status("a ligar");
  const timers: number[] = [];
  const later = (ms: number, f: () => void) => timers.push(window.setTimeout(f, ms));
  const every = (ms: number, f: () => void) => timers.push(window.setInterval(f, ms));

  later(400, () => {
    ev.myNode(BASE);
    ev.node(BASE, "BASE", "RaidTrack Base");
    for (const t of teams) {
      ev.node(t.num, t.short, t.long);
      const when = Date.now() - (t.silentMin ?? 0) * 60_000;
      // trilho já percorrido antes do arranque da demonstração
      if (t.path) {
        const n = Math.round(t.s! / (STEP * 2));
        for (let k = n; k >= 1; k--) { const p = along(t.path, t.s! - k * STEP * 2)!; ev.position(t.num, p[0], p[1], when - k * 60_000); }
      } else for (let k = 12; k >= 1; k--) ev.position(t.num, t.lat - Math.cos((t.hdg * Math.PI) / 180) * k * 0.0003, t.lon - Math.sin((t.hdg * Math.PI) / 180) * k * 0.0004, when - k * 60_000);
      ev.position(t.num, t.lat, t.lon, when);
      ev.battery(t.num, t.bat);
    }
    ev.status("ligado");
  });

  // Movimento: ~1,2 m/s a pé, acelerado 10×
  every(3000, () => {
    for (const t of live) {
      if (t.sosActive) continue; // equipa em SOS parada
      const p = t.path && (t.stopAt !== undefined && t.s! >= t.stopAt && t.wait! > 0 ? (t.wait!--, [t.lat, t.lon] as LatLon) : along(t.path, (t.s! += STEP)));
      if (p) { t.lat = p[0]; t.lon = p[1]; }
      else {
        if (t.path) { t.path = undefined; t.hdg = 200; }
        t.hdg += (Math.random() - 0.5) * 40;
        const d = STEP / 111_320;
        t.lat += d * Math.cos((t.hdg * Math.PI) / 180);
        t.lon += (d * Math.sin((t.hdg * Math.PI) / 180)) / Math.cos((t.lat * Math.PI) / 180);
      }
      t.bat = Math.max(5, t.bat - 0.05);
      ev.position(t.num, t.lat, t.lon, Date.now());
      ev.radio(t.num, 4 + Math.random() * 6, -95 - Math.random() * 20, Math.random() < 0.3 ? 1 : 0);
    }
  });
  every(20000, () => live.forEach((t) => ev.battery(t.num, Math.round(t.bat))));

  // Mensagens pré-definidas ocasionais
  every(17000, () => {
    const t = live[Math.floor(Math.random() * live.length)];
    if (!t.sosActive) ev.text(t.num, BASE, MSGS[Math.floor(Math.random() * MSGS.length)], Date.now());
  });

  // EQ2 entra em SOS ao fim de 25 s e repete a cada 30 s até confirmação
  const sosTeam = teams[1];
  const sendSos = (repeat: boolean) => {
    ev.priv(sosTeam.num, encodeSos(sosTeam.sosSeq, sosTeam.lat, sosTeam.lon, Math.round(sosTeam.bat), repeat), Date.now());
    sosTeam.nextSos = Date.now() + 30_000;
  };
  later(25_000, () => {
    sosTeam.sosActive = true;
    sosTeam.sosSeq++;
    sendSos(false);
  });
  every(1000, () => {
    if (sosTeam.sosActive && !sosTeam.sosAcked && Date.now() > sosTeam.nextSos) sendSos(true);
  });

  const reply = (t: SimTeam) => later(300 + Math.random() * 1500, () => ev.position(t.num, t.lat, t.lon, Date.now()));

  return {
    kind: "Simulação",
    async sendText(text, dest: Dest) {
      await new Promise((r) => setTimeout(r, 600));
      const t = teams.find((x) => x.num === dest);
      if (t && /posi|onde/i.test(text)) later(4000, () => ev.text(t.num, BASE, "Tudo bem", Date.now()));
    },
    async sendPrivate(data, dest) {
      await new Promise((r) => setTimeout(r, 300));
      const m = decode(data);
      if (!m) return;
      // a equipa lê a mensagem e carrega OK uns segundos depois
      if (m.type === "text" || m.type === "zone") {
        (dest === "all" ? live : teams.filter((t) => t.num === dest && !t.silentMin)).forEach((t) =>
          later((m.type === "zone" ? 6000 : 4000) + Math.random() * 6000, () => ev.priv(t.num, encodeRead(m.id), Date.now())));
      }
      if (m.type === "ping") (dest === "all" ? live : live.filter((t) => t.num === dest)).forEach(reply);
      if (m.type === "sosAck") {
        const t = teams.find((x) => x.num === m.node);
        if (t && t.sosSeq === m.seq) {
          t.sosAcked = true;
          later(60_000, () => {
            t.sosActive = false;
            t.sosAcked = false;
            ev.text(t.num, BASE, "Tudo bem", Date.now());
          });
        }
      }
    },
    async disconnect() {
      timers.forEach((id) => { clearTimeout(id); clearInterval(id); });
      ev.status("desligado");
    },
  };
  void t0;
}
