// Modo demonstração: simula 3 equipas para treinar operadores e testar a app sem rádio.
import type { Dest, Link, LinkEvents } from "./link";
import { decode, encodeSos, PORT_PRIVATE } from "./protocol";

const BASE = 0x0ba5e000;
const CENTRO = { lat: 39.6965, lon: -8.2924 };
const MSGS = ["Chegamos ao posto", "Tudo bem", "Saimos do posto", "Precisamos de agua"];

interface SimTeam {
  num: number; short: string; long: string;
  lat: number; lon: number; hdg: number; bat: number;
  sosSeq: number; sosActive: boolean; sosAcked: boolean; nextSos: number;
  /** minutos desde o último contacto, para equipas que deixaram de ser ouvidas */
  silentMin?: number;
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
      for (let k = 12; k >= 1; k--) ev.position(t.num, t.lat - Math.cos((t.hdg * Math.PI) / 180) * k * 0.0003, t.lon - Math.sin((t.hdg * Math.PI) / 180) * k * 0.0004, when - k * 60_000);
      ev.position(t.num, t.lat, t.lon, when);
      ev.battery(t.num, t.bat);
    }
    ev.status("ligado");
  });

  // Movimento: ~1,2 m/s a pé, acelerado 10×
  every(3000, () => {
    for (const t of live) {
      if (t.sosActive) continue; // equipa em SOS parada
      t.hdg += (Math.random() - 0.5) * 40;
      const d = 36 / 111_320; // 36 m por passo
      t.lat += d * Math.cos((t.hdg * Math.PI) / 180);
      t.lon += (d * Math.sin((t.hdg * Math.PI) / 180)) / Math.cos((t.lat * Math.PI) / 180);
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
