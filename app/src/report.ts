// Relatório final do raid em PDF: resumo de todas as equipas + uma página por equipa com mapa.
// Carregado só quando se carrega em "Relatório PDF" (import dinâmico), para não pesar no arranque.
import { jsPDF } from "jspdf";
import { fmtDur, fmtKm, lineLength, type LatLon } from "./geo";
import type { LogEv, Raid, Team, TeamStats } from "./main";
import { postEtas } from "./plan";

type Stats = (t: Team) => TeamStats;

// ───────────── Mapa desenhado num canvas (mosaicos OSM; sem Internet, quadrícula simples) ─────────────
const TILE = 256;
const px = (lat: number, lon: number, z: number): [number, number] => {
  const s = TILE * 2 ** z, r = (lat * Math.PI) / 180;
  return [((lon + 180) / 360) * s, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s];
};

// Fontes de mosaicos, por ordem. O "?pdf" separa estes pedidos (CORS, para desenhar no canvas) dos do mapa
// da app (sem CORS): sem isso o browser pode reutilizar a cópia sem CORS em cache e o desenho falha.
const SOURCES: { url: (z: number, x: number, y: number) => string; attr: string }[] = [
  { url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png?pdf=1`, attr: "© OpenStreetMap contributors" },
  // OpenTopoMap: é o mapa que vai dentro do ficheiro do plano, por isso funciona no relatório sem Internet
  { url: (z, x, y) => `https://${"abc"[Math.abs(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`, attr: "© OpenStreetMap contributors, SRTM · OpenTopoMap (CC-BY-SA)" },
  { url: (z, x, y) => `https://${"abcd"[(x + y) % 4]}.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`, attr: "© OpenStreetMap contributors © CARTO" },
];
let source = 0; // muda para a fonte seguinte se a primeira falhar

function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((res) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.referrerPolicy = "strict-origin-when-cross-origin";
    const timer = setTimeout(() => res(null), 8000);
    img.onload = () => { clearTimeout(timer); res(img); };
    img.onerror = () => { clearTimeout(timer); res(null); };
    img.src = src;
  });
}
async function loadTile(z: number, x: number, y: number): Promise<HTMLImageElement | null> {
  for (let i = source; i < SOURCES.length; i++) {
    const img = await loadImg(SOURCES[i].url(z, x, y));
    if (img) { if (i !== source) { console.warn(`RaidTrack relatório: mosaicos de ${SOURCES[source].attr} falharam, a usar ${SOURCES[i].attr}`); source = i; } return img; }
  }
  console.warn(`RaidTrack relatório: mosaico ${z}/${x}/${y} não carregou em nenhuma fonte`);
  return null;
}

interface MapLayers {
  route?: LatLon[];
  wpts?: { name: string; lat: number; lon: number }[];
  zones?: { name: string; poly: LatLon[]; kind?: string }[];
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
  // o primeiro mosaico sozinho escolhe a fonte que funciona; os restantes vão em paralelo
  const first = offline ? null : await loadTile(z, tx0, ty0);
  for (let x = tx0; x <= tx1; x++) for (let y = ty0; y <= ty1; y++) {
    total++;
    if (offline) continue;
    jobs.push((x === tx0 && y === ty0 ? Promise.resolve(first) : loadTile(z, x, y)).then((img) => { if (img) { ok++; g.drawImage(img, x * TILE - ox, y * TILE - oy); } }));
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
      const danger = zn.kind === "perigo";
      k.closePath(); k.fillStyle = danger ? "rgba(245,158,11,0.22)" : "rgba(239,68,68,0.22)"; k.fill();
      k.setLineDash(danger ? [3, 7] : [10, 6]); k.strokeStyle = danger ? "#b45309" : "#b91c1c"; k.lineWidth = 3; k.stroke(); k.setLineDash([]);
      const [x, y] = P(zn.poly[0]);
      k.fillStyle = danger ? "#92400e" : "#991b1b"; k.font = "bold 22px sans-serif"; k.fillText(zn.name, x + 6, y - 6);
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
    const attr = noTiles ? (offline ? "Sem mapa de fundo (demonstração)" : "Sem mapa de fundo (os mosaicos não carregaram)") : SOURCES[source].attr;
    const aw = k.measureText(attr).width;
    k.fillRect(w - aw - 16, h - 24, aw + 16, 24); k.fillStyle = "#374151"; k.fillText(attr, w - aw - 8, h - 7);
    return cv.toDataURL("image/jpeg", 0.88);
  }
}

// ───────────── PDF ─────────────
// As letras base do PDF (Helvetica) só têm os caracteres do Windows-1252: o resto (→, emojis…) saía como lixo.
const CP1252 = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
function pdfSafe(s: string): string {
  return s.normalize("NFC").replace(/→/g, "->").replace(/←/g, "<-").replace(/[≤]/g, "<=").replace(/[≥]/g, ">=")
    .replace(/[^\n\x20-\x7e\xa0-\xff]/gu, (c) => (CP1252.includes(c) ? c : ""));
}
/** Hora; com data se o raid passar a meia-noite */
let multiDay = false;
const hhmm = (ms?: number) => (ms ? new Date(ms).toLocaleString("pt-PT", multiDay ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" }) : "—");
const pct = (v?: number) => (v === undefined ? "—" : `${Math.round(v)} %`);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const eventsOf = (t: Team, log: LogEv[]) => {
  const re = new RegExp(`(^|[^\\w])${reEsc(t.short)}([^\\w]|$)`);
  return log.filter((e) => re.test(e.text));
};

export interface Report { pdf: Blob; pages: number; head: string[]; rows: string[][]; maps: { title: string; img: string }[] }
export async function buildReport(raid: Raid, teams: Team[], statsOf: Stats, progress: (m: string) => void, noTiles = false, startOf: (t: Team) => number | undefined = (t) => t.start): Promise<Report> {
  const etas = postEtas(raid);
  const wpts = (raid.posts ?? []).map((p, i) => ({ name: `${i + 1}. ${p.name}`, lat: p.lat, lon: p.lon }));
  offline = noTiles;
  source = 0;
  const maps: Report["maps"] = [], rows: string[][] = [];
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  type Txt = string | string[];
  const clean = (t: Txt): Txt => (Array.isArray(t) ? t.map(pdfSafe) : pdfSafe(t));
  const rawText = doc.text.bind(doc), rawSplit = doc.splitTextToSize.bind(doc);
  (doc as unknown as { text: (t: Txt, ...a: unknown[]) => unknown }).text = (t, ...a) => (rawText as (t: Txt, ...a: unknown[]) => unknown)(clean(t), ...a);
  (doc as unknown as { splitTextToSize: (t: string, w: number) => string[] }).splitTextToSize = (t, w) => rawSplit(pdfSafe(t), w);
  const W = 210, M = 14;
  const title = raid.name || "Raid";
  const day = new Date(raid.started).toLocaleDateString("pt-PT", { day: "numeric", month: "long", year: "numeric" });
  const list = [...teams].sort((a, b) => a.short.localeCompare(b.short));
  const stats = new Map(list.map((t) => [t.num, statsOf(t)]));
  {
    const times = [raid.started, ...raid.log.map((e) => e.t), ...[...stats.values()].flatMap((s) => s.track.map((p) => p[2])), ...list.flatMap((t) => [t.start ?? 0, t.end ?? 0]).filter(Boolean)];
    const d = (ms: number) => new Date(ms).toDateString();
    multiDay = new Set(times.map(d)).size > 1;
  }
  // hora mostrada: a indicada na base ou, sem ela, a do primeiro/último ponto do rasto
  const t0 = (t: Team) => t.start ?? stats.get(t.num)!.track[0]?.[2];
  const t1 = (t: Team) => t.end ?? (t.start ? undefined : stats.get(t.num)!.track.at(-1)?.[2]);
  const early = (t: Team) => raid.log.filter((e) => e.t >= raid.started && eventsOf(t, [e]).length);
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
    route ? `Percurso teórico: ${route.name} (${fmtKm(lineLength(route.pts))}) · corredor ${corridor} m` : "Sem percurso teórico importado.",
    ...(etas.length ? [`Postos: ${etas.map((e, i) => `${i + 1}. ${e.post.name}`).join(" · ")}`] : []),
    zones.filter((z) => z.kind !== "perigo").length ? `Zonas proibidas: ${zones.filter((z) => z.kind !== "perigo").map((z) => z.name).join(", ")}` : "Sem zonas proibidas.",
    ...(zones.some((z) => z.kind === "perigo") ? [`Zonas de perigo: ${zones.filter((z) => z.kind === "perigo").map((z) => z.name).join(", ")}`] : []),
    ...(raid.safety?.meet ? [`Ponto de encontro: ${raid.safety.meet}`] : []),
    ...(raid.safety?.hospital ? [`Hospital / centro de saúde: ${raid.safety.hospital}`] : []),
    `${list.length} equipa${list.length === 1 ? "" : "s"}`,
  ];
  for (const l of info) { doc.text(doc.splitTextToSize(l, W - 2 * M), M, y); y += 5.5; }

  const overview = await drawMap(1400, 860, {
    route: route?.pts, wpts, zones,
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
  const tw = multiDay ? 21 : 15;
  const cols: [string, number][] = [["Equipa", 0], ["Partida", tw], ["Chegada", tw], ["Duração", 19], ["Distância", 18],
    ...(route ? [["No percurso", 20], ["Cobertura", 18]] as [string, number][] : []),
    ...(etas.length ? [["Postos", 14]] as [string, number][] : []), ["Zonas", 12], ["SOS", 10]];
  cols[0][1] = W - 2 * M - cols.slice(1).reduce((a, c) => a + c[1], 0);
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
    const sosRe = new RegExp(`^SOS de ${reEsc(t.short)}( \\(sem GPS\\))?$`);
    const sos = ev.filter((e) => e.kind === "sos" && sosRe.test(e.text)).length;
    const cells = [
      `${t.short}${t.long ? ` ${t.long}` : ""}`, hhmm(t0(t)) + (t.start || !t0(t) ? "" : "*"), hhmm(t1(t)) + (t.end || !t1(t) ? "" : "*"),
      st.duration !== undefined ? fmtDur(st.duration) : "—", fmtKm(st.distance),
      ...(route ? [pct(st.adh?.onRoutePct), pct(st.adh?.coveragePct)] : []),
      ...(etas.length ? [`${etas.filter((e) => t.posts?.[e.post.id]).length}/${etas.length}`] : []),
      String(zoneIn), sos ? `${sos}` : "0",
    ];
    rows.push(cells);
    if (y > 280) { doc.addPage(); header("Relatório final (cont.)"); y = 32; row(cols.map((c) => c[0]), true, [229, 231, 235]); }
    row(cells, false, i % 2 ? [249, 250, 251] : undefined);
  });
  y += 2;
  doc.setFontSize(7.5); doc.setTextColor(107, 114, 128);
  const notes = [
    "Distância e duração contam entre a hora de partida e de chegada indicadas na base. * = hora não indicada na base: usa o primeiro/último ponto do rasto desde o início do raid. Saltos de GPS impossíveis a pé são ignorados.",
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
      ["Partida", hhmm(t0(t))],
      ["Chegada", hhmm(t1(t))],
      ["Duração", st.duration !== undefined ? fmtDur(st.duration) : "—"],
      ["Distância", fmtKm(st.distance)],
    ];
    if (route) cells.push(["No percurso", pct(st.adh?.onRoutePct)], ["Cobertura", pct(st.adh?.coveragePct)]);
    const cw = (W - 2 * M) / cells.length;
    cells.forEach(([k, v], j) => kv(M + j * cw, y, k, v));
    y += 12;
    doc.setFontSize(8.5); doc.setTextColor(75, 85, 99);
    const extra: string[] = [];
    if (!t.start || !t.end) extra.push(!t.start && !t.end ? "Sem horas de partida/chegada indicadas na base: valores calculados com o rasto desde o início do raid." : !t.end ? "Sem hora de chegada." : "Sem hora de partida.");
    if (route && st.adh) extra.push(`Maior afastamento ao percurso: ${fmtKm(st.adh.maxDev)} · fora do corredor: ${fmtKm(st.adh.offRouteM)}`);
    if (t.bat !== undefined) extra.push(`Bateria no último contacto: ${t.bat} %`);
    const pteam = raid.planTeams?.find((p) => p.code && p.code.toUpperCase() === t.short.toUpperCase());
    if (pteam?.members) extra.unshift(`Elementos: ${pteam.members}`);
    for (const l of extra) { doc.text(l, M, y); y += 4.5; }
    y += 1;

    const img = await drawMap(1400, 1000, {
      route: route?.pts, wpts, zones,
      tracks: [{ color: t.color, pts: st.track.map((p) => [p[0], p[1]] as LatLon), main: true }],
    });
    maps.push({ title: `${t.short}${t.long ? ` — ${t.long}` : ""}`, img });
    const ih = ((W - 2 * M) * 1000) / 1400;
    doc.addImage(img, "JPEG", M, y, W - 2 * M, ih); y += ih + 3;
    doc.setFontSize(7.5); doc.setTextColor(107, 114, 128);
    doc.text(`P = partida · C = chegada${route ? " · tracejado = percurso teórico" : ""}${etas.length ? " · losango = posto" : ""}${zones.length ? " · vermelho = zona proibida · laranja = perigo" : ""}`, M, y); y += 7;

    // passagem nos postos
    if (etas.length) {
      const s0 = startOf(t);
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(17, 24, 39);
      doc.text("Postos", M, y); y += 5;
      doc.setFontSize(8.5);
      const pc = [70, 30, 30, 52];
      const prow = (cells: string[], bold = false) => {
        doc.setFont("helvetica", bold ? "bold" : "normal");
        let x = M; cells.forEach((c, j) => { doc.text(c, x, y); x += pc[j]; }); y += 4.6;
      };
      prow(["Posto", "Previsto", "Passagem", "Diferença"], true);
      doc.setTextColor(17, 24, 39);
      etas.forEach((e, j) => {
        if (y > 284) { doc.addPage(); header(`Equipa ${t.short} (cont.)`); y = 32; doc.setFontSize(8.5); }
        const real = t.posts?.[e.post.id];
        const prev = s0 !== undefined && Number.isFinite(e.min) ? s0 + e.min * 60_000 : undefined;
        const d = real && prev ? Math.round((real - prev) / 60_000) : undefined;
        prow([`${j + 1}. ${e.post.name}`, hhmm(prev), real ? hhmm(real) : "não registada", d === undefined ? "—" : Math.abs(d) <= 2 ? "a horas" : `${d > 0 ? "+" : "−"}${fmtDur(Math.abs(d) * 60_000)}`]);
      });
      if (s0 !== undefined && !t.start) { doc.setFontSize(7.5); doc.setTextColor(107, 114, 128); doc.text("Previsto calculado a partir da partida prevista no plano.", M, y); y += 4; }
      y += 3;
    }

    // eventos
    const ev = early(t).filter((e) => !t.start || e.t >= t.start - 30 * 60_000);
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(17, 24, 39);
    doc.text("Eventos", M, y); y += 5.5;
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5);
    if (!ev.length) { doc.setTextColor(107, 114, 128); doc.text("Sem eventos registados.", M, y); }
    for (const e of ev) {
      const lines = doc.splitTextToSize(e.text, W - 2 * M - (multiDay ? 26 : 16));
      if (y + lines.length * 4 > 284) { doc.addPage(); header(`Equipa ${t.short} (cont.)`); y = 32; doc.setFontSize(8.5); }
      doc.setTextColor(107, 114, 128); doc.text(hhmm(e.t), M, y);
      const col = e.kind === "sos" || e.kind === "zona" ? [185, 28, 28] : e.kind === "alerta" ? [180, 83, 9] : e.kind === "posto" ? [21, 128, 61] : [17, 24, 39];
      doc.setTextColor(col[0], col[1], col[2]); doc.text(lines, M + (multiDay ? 24 : 14), y);
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
