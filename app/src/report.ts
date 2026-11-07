// Relatório final do raid em PDF: resumo de todas as equipas + uma página por equipa com mapa.
// Carregado só quando se carrega em "Relatório PDF" (import dinâmico), para não pesar no arranque.
import { jsPDF } from "jspdf";
import { fmtDur, fmtKm, lineLength, type LatLon } from "./geo";
import type { LogEv, Raid, Team, TeamStats } from "./main";

type Stats = (t: Team) => TeamStats;

// ───────────── Mapa desenhado num canvas (mosaicos OSM; sem Internet, quadrícula simples) ─────────────
const TILE = 256;
const px = (lat: number, lon: number, z: number): [number, number] => {
  const s = TILE * 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
};

function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    const timer = setTimeout(() => res(null), 5000);
    img.onload = () => { clearTimeout(timer); res(img); };
    img.onerror = () => { clearTimeout(timer); res(null); };
    img.src = `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  });
}

interface MapLayers {
  route?: LatLon[];
  wpts?: { name: string; lat: number; lon: number }[];
  zones?: { name: string; poly: LatLon[] }[];
  tracks: { color: string; pts: LatLon[]; label?: string; main?: boolean }[];
}

let offline = false; // demonstração: não pede mosaicos (não há Internet dentro da página)
async function drawMap(w: number, h: number, L: MapLayers): Promise<string> {
  const all: LatLon[] = [...(L.route ?? []), ...L.tracks.flatMap((t) => t.pts), ...(L.zones ?? []).flatMap((z) => z.poly)];
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d")!;
  g.fillStyle = "#eef1ea"; g.fillRect(0, 0, w, h);
  if (!all.length) {
    g.fillStyle = "#6b7280"; g.font = "28px sans-serif"; g.textAlign = "center";
    g.fillText("Sem posições registadas", w / 2, h / 2);
    return c.toDataURL("image/jpeg", 0.85);
  }
  const lats = all.map((p) => p[0]), lons = all.map((p) => p[1]);
  const n = Math.max(...lats), s = Math.min(...lats), e = Math.max(...lons), wst = Math.min(...lons);
  // maior zoom em que tudo cabe com margem
  let z = 17;
  for (; z > 3; z--) {
    const [x0, y0] = px(n, wst, z), [x1, y1] = px(s, e, z);
    if (x1 - x0 < w * 0.85 && y1 - y0 < h * 0.85) break;
  }
  const [cx, cy] = px((n + s) / 2, (e + wst) / 2, z);
  const ox = cx - w / 2, oy = cy - h / 2;
  const P = (p: LatLon): [number, number] => { const [x, y] = px(p[0], p[1], z); return [x - ox, y - oy]; };

  // fundo: mosaicos
  const tx0 = Math.floor(ox / TILE), ty0 = Math.floor(oy / TILE), tx1 = Math.floor((ox + w) / TILE), ty1 = Math.floor((oy + h) / TILE);
  const jobs: Promise<void>[] = [];
  let ok = 0, total = 0;
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
    total++;
    if (offline) continue;
    jobs.push(loadTile(z, x, y).then((img) => { if (img) { ok++; g.drawImage(img, x * TILE - ox, y * TILE - oy); } }));
  }
  await Promise.all(jobs);
  let tainted = false;
  try { c.toDataURL(); } catch { tainted = true; }
  if (tainted || ok < total / 2) {
    // sem mapa de fundo: quadrícula de 100 m / 1 km
    const c2 = document.createElement("canvas"); c2.width = w; c2.height = h;
    const g2 = c2.getContext("2d")!;
    g2.fillStyle = "#f4f6f1"; g2.fillRect(0, 0, w, h);
    g2.strokeStyle = "#dde3d6"; g2.lineWidth = 1;
    for (let x = (-ox % 64 + 64) % 64; x < w; x += 64) { g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, h); g2.stroke(); }
    for (let y = (-oy % 64 + 64) % 64; y < h; y += 64) { g2.beginPath(); g2.moveTo(0, y); g2.lineTo(w, y); g2.stroke(); }
    return finish(c2, true);
  }
  // véu claro para os traços se destacarem
  g.fillStyle = "rgba(255,255,255,0.25)"; g.fillRect(0, 0, w, h);
  return finish(c, false);

  function finish(cv: HTMLCanvasElement, noTiles: boolean): string {
    const k = cv.getContext("2d")!;
    const line = (pts: LatLon[], color: string, width: number, dash: number[] = []) => {
      if (pts.length < 2) return;
      k.beginPath(); k.setLineDash(dash); k.strokeStyle = color; k.lineWidth = width; k.lineJoin = "round"; k.lineCap = "round";
      pts.forEach((p, i) => { const [x, y] = P(p); if (i) k.lineTo(x, y); else k.moveTo(x, y); });
      k.stroke(); k.setLineDash([]);
    };
    for (const zn of L.zones ?? []) {
      k.beginPath();
      zn.poly.forEach((p, i) => { const [x, y] = P(p); if (i) k.lineTo(x, y); else k.moveTo(x, y); });
      k.closePath(); k.fillStyle = "rgba(239,68,68,0.22)"; k.fill();
      k.setLineDash([10, 6]); k.strokeStyle = "#b91c1c"; k.lineWidth = 3; k.stroke(); k.setLineDash([]);
      const [x, y] = P(zn.poly[0]);
      k.fillStyle = "#991b1b"; k.font = "bold 22px sans-serif"; k.fillText(zn.name, x + 6, y - 6);
    }
    if (L.route) { line(L.route, "rgba(17,24,39,0.18)", 18); line(L.route, "#111827", 4, [16, 10]); }
    for (const t of L.tracks.filter((t) => !t.main)) line(t.pts, t.color + "99", 4);
    for (const t of L.tracks.filter((t) => t.main)) { line(t.pts, "#ffffff", 9); line(t.pts, t.color, 5); }
    for (const t of L.tracks) {
      if (!t.pts.length) continue;
      const dot = (p: LatLon, fill: string, label: string) => {
        const [x, y] = P(p);
        k.beginPath(); k.arc(x, y, 11, 0, Math.PI * 2); k.fillStyle = fill; k.fill(); k.lineWidth = 3; k.strokeStyle = "#fff"; k.stroke();
        k.fillStyle = "#fff"; k.font = "bold 13px sans-serif"; k.textAlign = "center"; k.textBaseline = "middle"; k.fillText(label, x, y + 1);
        k.textAlign = "start"; k.textBaseline = "alphabetic";
      };
      if (t.main || L.tracks.length === 1) { dot(t.pts[0], "#15803d", "P"); dot(t.pts[t.pts.length - 1], "#b91c1c", "C"); }
      else if (t.label) {
        const [x, y] = P(t.pts[t.pts.length - 1]);
        k.font = "bold 20px sans-serif";
        const tw = k.measureText(t.label).width;
        k.fillStyle = t.color; k.fillRect(x - tw / 2 - 6, y - 30, tw + 12, 26);
        k.fillStyle = "#fff"; k.fillText(t.label, x - tw / 2, y - 11);
      }
    }
    for (const wp of L.wpts ?? []) {
      const [x, y] = P([wp.lat, wp.lon]);
      k.save(); k.translate(x, y); k.rotate(Math.PI / 4);
      k.fillStyle = "#facc15"; k.strokeStyle = "#111827"; k.lineWidth = 2.5; k.fillRect(-8, -8, 16, 16); k.strokeRect(-8, -8, 16, 16);
      k.restore();
      k.fillStyle = "#111827"; k.font = "18px sans-serif"; k.fillText(wp.name, x + 13, y + 6);
    }
    // escala
    const mpp = (156543.03392 * Math.cos((((n + s) / 2) * Math.PI) / 180)) / 2 ** z;
    const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].find((m) => m / mpp > w * 0.12) ?? 20000;
    const bw = nice / mpp, bx = 24, by = h - 28;
    k.fillStyle = "rgba(255,255,255,0.85)"; k.fillRect(bx - 10, by - 30, bw + 20, 44);
    k.fillStyle = "#111827"; k.fillRect(bx, by, bw, 6);
    k.font = "18px sans-serif"; k.fillText(nice >= 1000 ? `${nice / 1000} km` : `${nice} m`, bx, by - 8);
    // créditos
    k.font = "15px sans-serif"; k.fillStyle = "rgba(255,255,255,0.85)";
    const attr = noTiles ? "Sem mapa de fundo (sem Internet)" : "© OpenStreetMap contributors";
    const aw = k.measureText(attr).width;
    k.fillRect(w - aw - 16, h - 24, aw + 16, 24); k.fillStyle = "#374151"; k.fillText(attr, w - aw - 8, h - 7);
    return cv.toDataURL("image/jpeg", 0.88);
  }
}

// ───────────── PDF ─────────────
const hhmm = (ms?: number) => (ms ? new Date(ms).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" }) : "—");
const pct = (v?: number) => (v === undefined ? "—" : `${Math.round(v)} %`);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const eventsOf = (t: Team, log: LogEv[]) => {
  const re = new RegExp(`(^|[^\\w])${reEsc(t.short)}([^\\w]|$)`);
  return log.filter((e) => re.test(e.text));
};

export interface Report { pdf: Blob; pages: number; head: string[]; rows: string[][]; maps: { title: string; img: string }[] }
export async function buildReport(raid: Raid, teams: Team[], statsOf: Stats, progress: (m: string) => void, noTiles = false): Promise<Report> {
  offline = noTiles;
  const maps: Report["maps"] = [], rows: string[][] = [];
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  const W = 210, M = 14;
  const title = raid.name || "Raid";
  const day = new Date(raid.started).toLocaleDateString("pt-PT", { day: "numeric", month: "long", year: "numeric" });
  const list = [...teams].sort((a, b) => a.short.localeCompare(b.short));
  const stats = new Map(list.map((t) => [t.num, statsOf(t)]));
  const zones = raid.zones ?? [];
  const route = raid.route;
  const corridor = raid.corridor ?? 50;

  const header = (sub: string) => {
    doc.setFillColor(17, 24, 39); doc.rect(0, 0, W, 22, "F");
    doc.setTextColor(255, 255, 255); doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text(title, M, 10);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
    doc.text(`${sub}  ·  ${day}`, M, 16.5);
    doc.text("RaidTrack", W - M, 10, { align: "right" });
    doc.setTextColor(17, 24, 39);
  };
  const footer = () => {
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFontSize(8); doc.setTextColor(107, 114, 128);
      doc.text(`Gerado em ${new Date().toLocaleString("pt-PT")}`, M, 290);
      doc.text(`Página ${i} de ${n}`, W - M, 290, { align: "right" });
    }
  };
  const kv = (x: number, y: number, k: string, v: string) => {
    doc.setFontSize(7.5); doc.setTextColor(107, 114, 128); doc.text(k.toUpperCase(), x, y);
    doc.setFontSize(12); doc.setTextColor(17, 24, 39); doc.setFont("helvetica", "bold"); doc.text(v, x, y + 5.5);
    doc.setFont("helvetica", "normal");
  };

  // ── Página 1: resumo
  progress("A desenhar o mapa…");
  header("Relatório final");
  let y = 30;
  doc.setFontSize(10);
  const info = [
    route ? `Percurso teórico: ${route.name} (${fmtKm(lineLength(route.pts))}${route.wpts.length ? `, ${route.wpts.length} postos` : ""}) · corredor ${corridor} m` : "Sem percurso teórico importado.",
    zones.length ? `Zonas proibidas: ${zones.map((z) => z.name).join(", ")}` : "Sem zonas proibidas.",
    `${list.length} equipa${list.length === 1 ? "" : "s"}`,
  ];
  for (const l of info) { doc.text(doc.splitTextToSize(l, W - 2 * M), M, y); y += 5.5; }

  const overview = await drawMap(1400, 860, {
    route: route?.pts, wpts: route?.wpts, zones,
    tracks: list.map((t) => ({ color: t.color, pts: stats.get(t.num)!.track.map((p) => [p[0], p[1]] as LatLon), label: t.short })),
  });
  maps.push({ title: "Todas as equipas", img: overview });
  const mh = ((W - 2 * M) * 860) / 1400;
  doc.addImage(overview, "JPEG", M, y, W - 2 * M, mh); y += mh + 4;
  // legenda
  doc.setFontSize(8.5);
  let lx = M;
  for (const t of list) {
    const [r, g, b] = hex(t.color);
    doc.setFillColor(r, g, b); doc.rect(lx, y - 2.6, 6, 2.6, "F");
    doc.setTextColor(55, 65, 81); doc.text(t.short, lx + 7.5, y);
    lx += 9 + doc.getTextWidth(t.short) + 5;
    if (lx > W - M - 20) { lx = M; y += 5; }
  }
  if (route) { doc.setDrawColor(17, 24, 39); doc.setLineDashPattern([1.5, 1], 0); doc.line(lx, y - 1.3, lx + 7, y - 1.3); doc.setLineDashPattern([], 0); doc.text("percurso teórico", lx + 8.5, y); }
  y += 8;

  // tabela resumo
  const cols = route
    ? [["Equipa", 30], ["Partida", 16], ["Chegada", 17], ["Duração", 22], ["Distância", 20], ["No percurso", 21], ["Cobertura", 19], ["Zonas", 13], ["SOS", 24]] as const
    : [["Equipa", 44], ["Partida", 20], ["Chegada", 20], ["Duração", 26], ["Distância", 26], ["Zonas", 18], ["SOS", 28]] as const;
  const row = (cells: string[], bold = false, fill?: [number, number, number]) => {
    if (fill) { doc.setFillColor(...fill); doc.rect(M, y - 4.2, W - 2 * M, 6.4, "F"); }
    doc.setFont("helvetica", bold ? "bold" : "normal"); doc.setFontSize(8.5); doc.setTextColor(17, 24, 39);
    let x = M + 1.5;
    cells.forEach((c, i) => { doc.text(doc.splitTextToSize(c, cols[i][1] - 2)[0] ?? "", x, y); x += cols[i][1]; });
    y += 6.4;
  };
  row(cols.map((c) => c[0]), true, [229, 231, 235]);
  list.forEach((t, i) => {
    const st = stats.get(t.num)!;
    const ev = eventsOf(t, raid.log);
    const zoneIn = ev.filter((e) => e.kind === "zona" && e.text.includes("entrou")).length;
    const sos = ev.filter((e) => e.kind === "sos" && e.text.startsWith("SOS de")).length;
    const cells = [
      `${t.short}${t.long ? ` ${t.long}` : ""}`, hhmm(t.start), hhmm(t.end),
      st.duration !== undefined ? fmtDur(st.duration) : "—", fmtKm(st.distance),
      ...(route ? [pct(st.adh?.onRoutePct), pct(st.adh?.coveragePct)] : []),
      String(zoneIn), sos ? `${sos}` : "0",
    ];
    rows.push(cells);
    if (y > 280) { doc.addPage(); header("Relatório final (cont.)"); y = 32; row(cols.map((c) => c[0]), true, [229, 231, 235]); }
    row(cells, false, i % 2 ? [249, 250, 251] : undefined);
  });
  y += 2;
  doc.setFontSize(7.5); doc.setTextColor(107, 114, 128);
  const notes = [
    "Distância e duração contam entre a hora de partida e de chegada indicadas na base (sem horas: todo o rasto registado). Saltos de GPS impossíveis a pé são ignorados.",
    ...(route ? [`"No percurso": parte da distância percorrida feita a menos de ${corridor} m do percurso teórico. "Cobertura": parte do percurso teórico por onde a equipa passou.`] : []),
  ];
  for (const n of notes) { const l = doc.splitTextToSize(n, W - 2 * M); if (y + l.length * 3.4 > 285) break; doc.text(l, M, y); y += l.length * 3.4 + 1; }

  // ── Uma página por equipa
  for (const [i, t] of list.entries()) {
    progress(`Equipa ${i + 1} de ${list.length}…`);
    const st = stats.get(t.num)!;
    doc.addPage(); header(`Equipa ${t.short}${t.long ? ` — ${t.long}` : ""}`);
    const [r, g, b] = hex(t.color);
    doc.setFillColor(r, g, b); doc.rect(0, 22, W, 1.6, "F");
    y = 32;
    const cells: [string, string][] = [
      ["Partida", hhmm(t.start ?? st.track[0]?.[2])],
      ["Chegada", hhmm(t.end ?? (t.start ? undefined : st.track[st.track.length - 1]?.[2]))],
      ["Duração", st.duration !== undefined ? fmtDur(st.duration) : "—"],
      ["Distância", fmtKm(st.distance)],
    ];
    if (route) cells.push(["No percurso", pct(st.adh?.onRoutePct)], ["Cobertura", pct(st.adh?.coveragePct)]);
    const cw = (W - 2 * M) / cells.length;
    cells.forEach(([k, v], j) => kv(M + j * cw, y, k, v));
    y += 12;
    doc.setFontSize(8.5); doc.setTextColor(75, 85, 99);
    const extra: string[] = [];
    if (!t.start || !t.end) extra.push(!t.start && !t.end ? "Sem horas de partida/chegada: valores calculados com todo o rasto." : !t.end ? "Sem hora de chegada." : "Sem hora de partida.");
    if (route && st.adh) extra.push(`Maior afastamento ao percurso: ${fmtKm(st.adh.maxDev)} · fora do corredor: ${fmtKm(st.adh.offRouteM)}`);
    if (t.bat !== undefined) extra.push(`Bateria no último contacto: ${t.bat} %`);
    for (const l of extra) { doc.text(l, M, y); y += 4.5; }
    y += 1;

    const img = await drawMap(1400, 1000, {
      route: route?.pts, wpts: route?.wpts, zones,
      tracks: [{ color: t.color, pts: st.track.map((p) => [p[0], p[1]] as LatLon), main: true }],
    });
    maps.push({ title: `${t.short}${t.long ? ` — ${t.long}` : ""}`, img });
    const ih = ((W - 2 * M) * 1000) / 1400;
    doc.addImage(img, "JPEG", M, y, W - 2 * M, ih); y += ih + 3;
    doc.setFontSize(7.5); doc.setTextColor(107, 114, 128);
    doc.text(`P = partida · C = chegada${route ? " · tracejado = percurso teórico" : ""}${zones.length ? " · vermelho = zona proibida" : ""}`, M, y); y += 7;

    // eventos
    const ev = eventsOf(t, raid.log).filter((e) => !t.start || e.t >= t.start - 30 * 60_000);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(17, 24, 39);
    doc.text("Eventos", M, y); y += 5.5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    if (!ev.length) { doc.setTextColor(107, 114, 128); doc.text("Sem eventos registados.", M, y); }
    for (const e of ev) {
      const lines = doc.splitTextToSize(e.text, W - 2 * M - 30);
      if (y + lines.length * 4 > 284) { doc.addPage(); header(`Equipa ${t.short} (cont.)`); y = 32; doc.setFontSize(8.5); }
      doc.setTextColor(107, 114, 128); doc.text(hhmm(e.t), M, y);
      const col = e.kind === "sos" || e.kind === "zona" ? [185, 28, 28] : [17, 24, 39];
      doc.setTextColor(col[0], col[1], col[2]); doc.text(lines, M + 14, y);
      y += lines.length * 4 + 0.8;
    }
  }
  footer();
  progress("A terminar…");
  return { pdf: doc.output("blob"), pages: doc.getNumberOfPages(), head: cols.map((c) => c[0]), rows, maps };
}

function hex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(c);
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [37, 99, 235];
}
