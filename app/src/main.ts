import "./shims/process";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { connectRadio, type Dest, type Link, type LinkEvents, type LinkStatus } from "./link";
import { decode, encodePing, encodeSosAck } from "./protocol";
import { startSim } from "./sim";
import { demoTerrain } from "./terrain";

/** Versão de demonstração (página única, dados fictícios, sem rádio) */
const DEMO_BUILD = import.meta.env.MODE === "demo";

// ───────────────────────────── Estado ─────────────────────────────
type Pt = [number, number, number]; // lat, lon, t(ms)
interface Sos { seq: number; lat: number | null; lon: number | null; bat: number; since: number; last: number; acked: boolean; ackAt?: number }
interface Team {
  num: number; short: string; long: string; color: string;
  lat?: number; lon?: number; posAt?: number; heard?: number;
  bat?: number; snr?: number; rssi?: number; hops?: number | null;
  track: Pt[]; sos?: Sos;
}
interface Msg { t: number; from: number; to: Dest; text: string; dir: "in" | "out"; st?: "a enviar" | "entregue" | "enviada" | "falhou" }
interface LogEv { t: number; kind: "sos" | "msg" | "info" | "ligacao"; text: string }
interface Raid { started: number; teams: Record<number, Team>; msgs: Msg[]; log: LogEv[]; base?: [number, number] }

const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#4d7c0f", "#a16207"];
const STALE_MS = 3 * 60_000;
const LOST_MS = 10 * 60_000;
const KEY = "raidtrack.raid.v1";

let raid: Raid = (DEMO_BUILD ? null : load()) ?? { started: Date.now(), teams: {}, msgs: [], log: [] };
let link: Link | null = null;
let myNum = 0;
let status: LinkStatus = "desligado";
let selected: number | null = null;

function load(): Raid | null {
  try { const s = localStorage.getItem(KEY); return s ? (JSON.parse(s) as Raid) : null; } catch { return null; }
}
let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(raid)); } catch { /* armazenamento indisponível */ } }, 1500);
}

const teams = () => Object.values(raid.teams).filter((t) => t.num !== myNum);
function team(num: number): Team {
  let t = raid.teams[num];
  if (!t) {
    const n = Object.keys(raid.teams).length;
    t = raid.teams[num] = { num, short: num.toString(16).slice(-4), long: "", color: COLORS[n % COLORS.length], track: [] };
  }
  return t;
}
const nameOf = (num: number | "all") => num === "all" ? "Todas" : num === myNum ? "Base" : raid.teams[num]?.short ?? num.toString(16).slice(-4);
function log(kind: LogEv["kind"], text: string) { raid.log.push({ t: Date.now(), kind, text }); renderLog(); save(); }

// ───────────────────────────── DOM ─────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const hhmm = (t: number) => new Date(t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" });
function ago(t?: number) {
  if (!t) return "—";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
function toast(text: string, kind: "" | "warn" | "ok" = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

/** Pergunta de confirmação dentro da página (funciona também onde confirm() está bloqueado) */
function ask(text: string, okLabel = "Confirmar"): Promise<boolean> {
  return new Promise((resolve) => {
    const box = $("#ask");
    $("#askText").textContent = text;
    $("#askOk").textContent = okLabel;
    box.hidden = false;
    $<HTMLButtonElement>("#askOk").focus();
    const done = (v: boolean) => { box.hidden = true; resolve(v); };
    $("#askOk").onclick = () => done(true);
    $("#askNo").onclick = () => done(false);
  });
}

// ───────────────────────────── Mapa ─────────────────────────────
const topo = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
  maxZoom: 17, subdomains: "abc", attribution: "© OpenStreetMap, SRTM · OpenTopoMap (CC-BY-SA)",
});
const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "© OpenStreetMap" });
const map = L.map("map", { layers: [DEMO_BUILD ? demoTerrain() : topo], zoomControl: true }).setView([39.6965, -8.2924], 15);
if (!DEMO_BUILD) L.control.layers({ Topográfico: topo, OpenStreetMap: osm }, {}, { position: "topright" }).addTo(map);
L.control.scale({ imperial: false }).addTo(map);

const markers = new Map<number, L.Marker>();
const tracks = new Map<number, L.Polyline>();
let baseMarker: L.Marker | null = null;
let fitted = false;

function icon(t: Team) {
  const cls = t.sos && !t.sos.acked ? "sos" : t.sos ? "sos acked" : stateOf(t);
  return L.divIcon({
    className: "", iconSize: [44, 44], iconAnchor: [22, 22],
    html: `<div class="pin ${cls}" style="--c:${t.color}"><span>${esc(t.short)}</span></div>`,
  });
}
function drawTeam(t: Team) {
  const lat = t.sos?.lat ?? t.lat, lon = t.sos?.lon ?? t.lon;
  if (lat === undefined || lon === undefined || lat === null || lon === null) return;
  let m = markers.get(t.num);
  if (!m) {
    m = L.marker([lat, lon], { icon: icon(t), zIndexOffset: 100 }).addTo(map);
    m.on("click", () => select(t.num));
    markers.set(t.num, m);
  } else {
    m.setLatLng([lat, lon]).setIcon(icon(t));
  }
  m.setZIndexOffset(t.sos ? 1000 : 100);
  let pl = tracks.get(t.num);
  const ll = t.track.map((p) => [p[0], p[1]] as L.LatLngTuple);
  if (!pl) tracks.set(t.num, L.polyline(ll, { color: t.color, weight: 3, opacity: 0.7 }).addTo(map));
  else pl.setLatLngs(ll);
  if (!fitted) fitAll();
}
function fitAll() {
  const pts = teams().filter((t) => t.lat !== undefined).map((t) => [t.lat!, t.lon!] as L.LatLngTuple);
  if (raid.base) pts.push(raid.base);
  if (pts.length) { map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 16 }); fitted = true; }
}
function drawBase() {
  if (!raid.base) return;
  const ic = L.divIcon({ className: "", iconSize: [36, 36], iconAnchor: [18, 18], html: `<div class="pin base"><span>B</span></div>` });
  if (!baseMarker) baseMarker = L.marker(raid.base, { icon: ic, zIndexOffset: 50 }).addTo(map);
  else baseMarker.setLatLng(raid.base);
}

// Distância e rumo a partir da base
function distBrg(lat: number, lon: number): string {
  if (!raid.base) return "";
  const R = 6371e3, r = Math.PI / 180;
  const [la1, lo1] = raid.base;
  const dLa = (lat - la1) * r, dLo = (lon - lo1) * r;
  const a = Math.sin(dLa / 2) ** 2 + Math.cos(la1 * r) * Math.cos(lat * r) * Math.sin(dLo / 2) ** 2;
  const d = 2 * R * Math.asin(Math.sqrt(a));
  const y = Math.sin(dLo) * Math.cos(lat * r), x = Math.cos(la1 * r) * Math.sin(lat * r) - Math.sin(la1 * r) * Math.cos(lat * r) * Math.cos(dLo);
  const brg = (Math.atan2(y, x) / r + 360) % 360;
  const pts = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"][Math.round(brg / 45) % 8];
  return `${d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(1) + " km"} ${pts} (${Math.round(brg)}°)`;
}

// ───────────────────────────── Render ─────────────────────────────
function stateOf(t: Team): "ok" | "stale" | "lost" {
  const age = Date.now() - (t.heard ?? 0);
  return age > LOST_MS ? "lost" : age > STALE_MS ? "stale" : "ok";
}
const STATE_TXT = { ok: "Em contacto", stale: "Sinal atrasado", lost: "Sem sinal" };

function renderTeams() {
  const list = teams().sort((a, b) => Number(!!b.sos) - Number(!!a.sos) || a.short.localeCompare(b.short));
  $("#teamCount").textContent = String(list.length);
  $("#teams").innerHTML = list.length ? list.map((t) => {
    const st = t.sos ? (t.sos.acked ? "sos acked" : "sos") : stateOf(t);
    const where = t.lat !== undefined ? `${t.lat.toFixed(5)}, ${t.lon!.toFixed(5)}` : "sem posição";
    return `<article class="team ${st} ${selected === t.num ? "sel" : ""}" data-num="${t.num}" style="--c:${t.color}">
      <header><b>${esc(t.short)}</b><span class="lname">${esc(t.long)}</span>
        <span class="state">${t.sos ? (t.sos.acked ? "SOS confirmado" : "SOS!") : STATE_TXT[stateOf(t)]}</span></header>
      <dl>
        <div><dt>Última posição</dt><dd>${ago(t.posAt)}</dd></div>
        <div><dt>Bateria</dt><dd class="${(t.bat ?? 100) < 20 ? "low" : ""}">${t.bat !== undefined ? (t.bat > 100 ? "USB" : Math.round(t.bat) + "%") : "—"}</dd></div>
        <div><dt>Sinal</dt><dd>${t.snr !== undefined ? `${t.snr.toFixed(1)} dB${t.hops ? ` · ${t.hops} salto${t.hops > 1 ? "s" : ""}` : ""}` : "—"}</dd></div>
        <div><dt>Da base</dt><dd>${t.lat !== undefined ? distBrg(t.lat, t.lon!) || "base não definida" : "—"}</dd></div>
      </dl>
      <div class="coords">${where}</div>
      <footer>
        <button data-act="locate">Localizar</button>
        <button data-act="msg">Mensagem</button>
        <button data-act="center">Ver no mapa</button>
      </footer>
    </article>`;
  }).join("") : `<p class="empty">Ainda nenhuma equipa. Ligue o rádio da base ou experimente o modo demonstração.</p>`;
}

function renderMsgs() {
  const box = $("#msgs");
  box.innerHTML = raid.msgs.slice(-200).map((m) => {
    const who = m.dir === "in" ? nameOf(m.from) : `Base → ${nameOf(m.to)}`;
    const c = m.dir === "in" ? raid.teams[m.from]?.color ?? "#64748b" : "#475569";
    return `<div class="msg ${m.dir}" style="--c:${c}"><div class="mh"><b>${esc(who)}</b><time>${hhmm(m.t)}</time>${m.st ? `<em class="st ${m.st.replace(" ", "-")}">${m.st}</em>` : ""}</div><p>${esc(m.text)}</p></div>`;
  }).join("") || `<p class="empty">Sem mensagens.</p>`;
  box.scrollTop = box.scrollHeight;
  const sel = $<HTMLSelectElement>("#msgTo");
  const cur = sel.value;
  sel.innerHTML = `<option value="all">Todas as equipas</option>` + teams().map((t) => `<option value="${t.num}">${esc(t.short)} ${esc(t.long)}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === cur) ? cur : "all";
}

function renderLog() {
  $("#log").innerHTML = raid.log.slice(-300).reverse().map((e) => `<li class="${e.kind}"><time>${hhmm(e.t)}</time>${esc(e.text)}</li>`).join("") || `<li class="empty">Sem eventos.</li>`;
}

function renderStatus(detail?: string) {
  const el = $("#status");
  el.className = `pill ${status === "ligado" ? "on" : status === "a ligar" ? "wait" : "off"}`;
  el.textContent = status === "ligado" ? `Ligado · ${link?.kind}` : status === "a ligar" ? detail ?? "A ligar…" : "Desligado";
  document.body.classList.toggle("connected", status === "ligado");
}

function renderSos() {
  const active = teams().filter((t) => t.sos);
  const box = $("#sos");
  box.hidden = active.length === 0;
  box.innerHTML = active.map((t) => {
    const s = t.sos!;
    return `<div class="sosCard ${s.acked ? "acked" : ""}" data-num="${t.num}">
      <div class="sosHead"><span class="sosIcon">SOS</span><div><b>${esc(t.short)}</b> ${esc(t.long)}<br>
        <small>desde ${hhmm(s.since)} · bateria ${s.bat > 100 ? "USB" : s.bat + "%"} · ${s.lat !== null ? `${s.lat.toFixed(5)}, ${s.lon!.toFixed(5)}${raid.base ? " · " + distBrg(s.lat, s.lon!) : ""}` : "SEM POSIÇÃO GPS — usar última conhecida"}</small></div></div>
      <div class="sosBtns">
        ${s.acked ? `<span class="ackd">Confirmação enviada ${hhmm(s.ackAt!)}</span><button data-act="resolve">Resolvido</button>` : `<button class="primary" data-act="ack">Recebido — avisar equipa</button>`}
        <button data-act="center">Ver no mapa</button>
        ${s.lat !== null ? `<button data-act="copy">Copiar coordenadas</button>` : ""}
      </div></div>`;
  }).join("");
  alarm(active.some((t) => !t.sos!.acked));
}

function renderAll() { renderTeams(); renderMsgs(); renderLog(); renderSos(); teams().forEach(drawTeam); drawBase(); }

// ───────────────────────────── Alarme sonoro ─────────────────────────────
let audio: AudioContext | null = null;
let alarmTimer = 0;
let muted = false;
function beep(freq: number, ms: number) {
  audio ??= new AudioContext();
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = "square"; o.frequency.value = freq; g.gain.value = 0.15;
  o.connect(g).connect(audio.destination);
  o.start(); o.stop(audio.currentTime + ms / 1000);
}
function alarm(on: boolean) {
  if (on && !alarmTimer && !muted) {
    const play = () => { beep(880, 250); setTimeout(() => beep(660, 250), 300); };
    play(); alarmTimer = window.setInterval(play, 1200);
    if ("vibrate" in navigator) navigator.vibrate?.([400, 200, 400, 200, 400]);
  } else if (!on && alarmTimer) { clearInterval(alarmTimer); alarmTimer = 0; }
  if (!on) muted = false;
}

// ───────────────────────────── Eventos do rádio ─────────────────────────────
const events: LinkEvents = {
  status(s, d) {
    const was = status; status = s; renderStatus(d);
    if (s !== was && s !== "a ligar") log("ligacao", s === "ligado" ? `Rádio ligado (${link?.kind ?? ""})` : "Rádio desligado");
  },
  myNode(n) { myNum = n; renderTeams(); },
  node(n, short, long) {
    if (n === myNum) return;
    const t = team(n); t.short = short || t.short; t.long = long || t.long;
    renderTeams(); renderMsgs(); drawTeam(t); save();
  },
  position(n, lat, lon, when) {
    if (n === myNum) return;
    const t = team(n);
    t.lat = lat; t.lon = lon; t.posAt = when; t.heard = Math.max(t.heard ?? 0, when);
    const last = t.track[t.track.length - 1];
    if (!last || last[0] !== lat || last[1] !== lon) t.track.push([lat, lon, when]);
    drawTeam(t); renderTeams(); save();
  },
  battery(n, pct) {
    if (n === myNum) return;
    const t = team(n); const prev = t.bat; t.bat = pct;
    if (pct <= 20 && (prev === undefined || prev > 20)) { log("info", `${t.short}: bateria baixa (${pct}%)`); toast(`${t.short}: bateria baixa (${pct}%)`, "warn"); }
    renderTeams(); save();
  },
  radio(n, snr, rssi, hops) {
    if (n === myNum) return;
    const t = team(n); t.snr = snr; t.rssi = rssi; t.hops = hops; t.heard = Date.now();
  },
  text(from, to, text, when) {
    if (from === myNum) return;
    team(from).heard = when;
    raid.msgs.push({ t: when, from, to: to === 0xffffffff ? "all" : to, text, dir: "in" });
    log("msg", `${nameOf(from)}: ${text}`);
    toast(`${nameOf(from)}: ${text}`);
    beep(1200, 120);
    renderMsgs(); save();
  },
  priv(from, data, when) {
    const m = decode(data);
    if (!m || from === myNum) return;
    const t = team(from); t.heard = when;
    if (m.type === "sos") {
      const isNew = !t.sos || t.sos.seq !== m.seq;
      if (isNew) {
        t.sos = { seq: m.seq, lat: m.lat, lon: m.lon, bat: m.battery, since: when, last: when, acked: false };
        log("sos", `SOS de ${t.short}${m.lat === null ? " (sem GPS)" : ""}`);
        if (m.lat !== null) map.setView([m.lat, m.lon!], Math.max(map.getZoom(), 15));
      } else {
        Object.assign(t.sos!, { last: when, bat: m.battery, ...(m.lat !== null ? { lat: m.lat, lon: m.lon } : {}) });
        // A equipa repete enquanto não recebe a confirmação: reenviar se já confirmámos
        if (t.sos!.acked) void sendAck(t, true);
      }
      if (m.lat !== null) { t.lat = m.lat; t.lon = m.lon!; t.posAt = when; t.track.push([m.lat, m.lon!, when]); }
    } else if (m.type === "sosCancel") {
      if (t.sos && t.sos.seq === m.seq) { t.sos = undefined; log("sos", `${t.short} cancelou o SOS`); toast(`${t.short} cancelou o SOS`, "ok"); }
    }
    renderSos(); renderTeams(); drawTeam(t); save();
  },
};

async function sendAck(t: Team, resend = false) {
  if (!link || !t.sos) return toast("Rádio desligado — não é possível confirmar", "warn");
  try {
    await link.sendPrivate(encodeSosAck(t.num, t.sos.seq), t.num);
    if (!resend) { t.sos.acked = true; t.sos.ackAt = Date.now(); log("sos", `Confirmação de SOS enviada a ${t.short}`); }
  } catch {
    toast(`Confirmação para ${t.short} não chegou — tente de novo`, "warn");
    if (!resend) log("sos", `Falhou a confirmação de SOS para ${t.short}`);
  }
  renderSos(); renderTeams(); drawTeam(t); save();
}

// ───────────────────────────── Ações ─────────────────────────────
async function connect(how: "usb" | "ble" | "demo") {
  if (link) await link.disconnect();
  try {
    link = how === "demo" ? startSim(events) : await connectRadio(how, events);
    if (how === "demo") toast("Demonstração: 5 equipas fictícias. A EQ2 envia um SOS ao fim de 25 s.");
  } catch (e) {
    link = null; status = "desligado"; renderStatus();
    const msg = (e as Error).message;
    if (!/cancel|No port selected|User cancelled/i.test(msg)) toast(msg, "warn");
  }
}

async function sendMsg(text: string, dest: Dest) {
  if (!link) return toast("Ligue o rádio primeiro", "warn");
  const m: Msg = { t: Date.now(), from: myNum, to: dest, text, dir: "out", st: "a enviar" };
  raid.msgs.push(m); renderMsgs();
  log("msg", `Base → ${nameOf(dest)}: ${text}`);
  try { await link.sendText(text, dest); m.st = dest === "all" ? "enviada" : "entregue"; }
  catch { m.st = "falhou"; toast(`Mensagem para ${nameOf(dest)} não foi confirmada`, "warn"); }
  renderMsgs(); save();
}

async function ping(dest: Dest) {
  if (!link) return toast("Ligue o rádio primeiro", "warn");
  try { await link.sendPrivate(encodePing(), dest); toast(dest === "all" ? "Pedido de posição enviado a todas as equipas" : `Pedido de posição enviado a ${nameOf(dest)}`); }
  catch { toast(`${nameOf(dest)} não respondeu ao pedido`, "warn"); }
}

function select(num: number | null) {
  selected = num;
  renderTeams();
  if (num !== null) {
    showTab("teams");
    document.querySelector(`.team[data-num="${num}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
}
function center(num: number) {
  const t = raid.teams[num];
  const lat = t?.sos?.lat ?? t?.lat, lon = t?.sos?.lon ?? t?.lon;
  if (lat !== undefined && lat !== null) map.setView([lat, lon!], Math.max(map.getZoom(), 16));
  else toast(`${t?.short ?? "Equipa"} ainda sem posição`, "warn");
}
function showTab(id: string) {
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
  document.querySelectorAll<HTMLElement>(".pane").forEach((p) => (p.hidden = p.id !== `pane-${id}`));
}

function download(name: string, text: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportRaid() {
  if (DEMO_BUILD) return toast("Na app real, Exportar descarrega os percursos (GPX) e o registo do raid (CSV).");
  const day = new Date(raid.started).toISOString().slice(0, 10);
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="RaidTrack" xmlns="http://www.topografix.com/GPX/1/1">\n` +
    teams().map((t) => `<trk><name>${esc(t.short)} ${esc(t.long)}</name><trkseg>\n` +
      t.track.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`).join("\n") +
      `\n</trkseg></trk>`).join("\n") + `\n</gpx>\n`;
  download(`raid-${day}-percursos.gpx`, gpx, "application/gpx+xml");
  const csv = "hora;tipo;evento\n" + raid.log.map((e) => `${new Date(e.t).toLocaleString("pt-PT")};${e.kind};"${e.text.replace(/"/g, '""')}"`).join("\n");
  download(`raid-${day}-registo.csv`, "﻿" + csv, "text/csv");
}

// Descarregar mosaicos do mapa para usar sem Internet (guardados pelo service worker)
function lon2x(lon: number, z: number) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function lat2y(lat: number, z: number) { const r = (lat * Math.PI) / 180; return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z); }
async function cacheArea() {
  if (DEMO_BUILD) return toast("Na app real, guarda o mapa topográfico desta zona para usar sem Internet.");
  if (!navigator.serviceWorker?.controller) return toast("Recarregue a página uma vez (com Internet) para ativar o modo offline", "warn");
  const b = map.getBounds(), z0 = Math.max(10, map.getZoom() - 1), z1 = Math.min(16, map.getZoom() + 3);
  const urls: string[] = [];
  for (let z = z0; z <= z1; z++)
    for (let x = lon2x(b.getWest(), z); x <= lon2x(b.getEast(), z); x++)
      for (let y = lat2y(b.getNorth(), z); y <= lat2y(b.getSouth(), z); y++)
        urls.push(`https://${"abc"[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`);
  if (urls.length > 4000) return toast(`Área demasiado grande (${urls.length} mosaicos). Aproxime o mapa.`, "warn");
  if (!(await ask(`Descarregar ${urls.length} mosaicos (~${Math.round(urls.length * 0.025)} MB) desta zona, níveis ${z0}–${z1}?`, "Descarregar"))) return;
  let done = 0, fail = 0;
  const btn = $("#btnCache");
  const worker = async () => {
    while (urls.length) {
      const u = urls.pop()!;
      try { await fetch(u, { mode: "no-cors" }); } catch { fail++; }
      btn.textContent = `Mapa… ${++done}`;
    }
  };
  await Promise.all([worker(), worker(), worker()]); // poucos pedidos em paralelo: respeitar o servidor OpenTopoMap
  btn.textContent = "Mapa offline";
  toast(`Mapa guardado: ${done - fail} mosaicos${fail ? `, ${fail} falharam` : ""}`, fail ? "warn" : "ok");
}

function setBase() {
  if (!navigator.geolocation) return toast("Sem GPS neste dispositivo — clique no mapa para marcar a base", "warn");
  navigator.geolocation.getCurrentPosition(
    (p) => { raid.base = [p.coords.latitude, p.coords.longitude]; drawBase(); renderAll(); save(); toast("Posição da base definida", "ok"); },
    () => { toast("Clique no mapa para marcar a base"); map.once("click", (e) => { raid.base = [e.latlng.lat, e.latlng.lng]; drawBase(); renderAll(); save(); }); },
    { enableHighAccuracy: true, timeout: 10_000 },
  );
}

async function newRaid() {
  if (!(await ask("Começar um novo raid? Exporte primeiro os dados deste raid se os quiser guardar.", "Novo raid"))) return;
  raid = { started: Date.now(), teams: {}, msgs: [], log: [], base: raid.base };
  markers.forEach((m) => m.remove()); markers.clear();
  tracks.forEach((p) => p.remove()); tracks.clear();
  fitted = false; save(); renderAll(); log("info", "Novo raid iniciado");
}

// ───────────────────────────── Ligações da interface ─────────────────────────────
const noRadio = () => toast("Demonstração sem rádio. Na app real, este botão liga ao T3-S3 da base.");
$("#btnUsb").onclick = () => (DEMO_BUILD ? noRadio() : connect("usb"));
$("#btnBle").onclick = () => (DEMO_BUILD ? noRadio() : connect("ble"));
$("#btnDemo").onclick = () => connect("demo");
$("#btnOff").onclick = () => link?.disconnect().then(() => (link = null));
$("#btnPingAll").onclick = () => ping("all");
$("#btnFit").onclick = fitAll;
$("#btnBase").onclick = setBase;
$("#btnCache").onclick = cacheArea;
$("#btnExport").onclick = exportRaid;
$("#btnNew").onclick = newRaid;
$("#btnMute").onclick = () => { muted = true; alarm(false); muted = true; };
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab!)));

$("#teams").addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".team");
  if (!card) return;
  const num = Number(card.dataset.num);
  const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
  if (act === "locate") void ping(num);
  else if (act === "center") center(num);
  else if (act === "msg") { showTab("msgs"); $<HTMLSelectElement>("#msgTo").value = String(num); $<HTMLInputElement>("#msgText").focus(); }
  else { select(num); center(num); }
});
$("#sos").addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".sosCard");
  const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
  if (!card || !act) return;
  const t = raid.teams[Number(card.dataset.num)];
  if (act === "ack") void sendAck(t);
  if (act === "center") center(t.num);
  if (act === "copy" && t.sos?.lat != null) navigator.clipboard?.writeText(`${t.sos.lat.toFixed(6)}, ${t.sos.lon!.toFixed(6)}`).then(() => toast("Coordenadas copiadas", "ok"));
  if (act === "resolve") void ask(`Marcar o SOS de ${t.short} como resolvido?`, "Resolvido").then((ok) => { if (!ok || !t.sos) return; t.sos = undefined; log("sos", `SOS de ${t.short} resolvido`); renderSos(); renderTeams(); drawTeam(t); save(); });
});
$<HTMLFormElement>("#msgForm").onsubmit = (e) => {
  e.preventDefault();
  const inp = $<HTMLInputElement>("#msgText");
  const text = inp.value.trim();
  if (!text) return;
  const v = $<HTMLSelectElement>("#msgTo").value;
  void sendMsg(text.slice(0, 200), v === "all" ? "all" : Number(v));
  inp.value = "";
};
document.querySelectorAll<HTMLButtonElement>(".quick button").forEach((b) => (b.onclick = () => {
  const v = $<HTMLSelectElement>("#msgTo").value;
  void sendMsg(b.textContent!, v === "all" ? "all" : Number(v));
}));

// Relógio do raid e envelhecimento dos estados
setInterval(() => {
  const s = Math.floor((Date.now() - raid.started) / 1000);
  $("#clock").textContent = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  renderTeams();
  teams().forEach((t) => markers.get(t.num)?.setIcon(icon(t)));
}, 10_000);

// Funcionalidades disponíveis neste browser
if (!("serial" in navigator)) $("#btnUsb").title = "USB indisponível neste browser (use Chrome ou Edge no PC)";
if (!("bluetooth" in navigator)) $("#btnBle").title = "Bluetooth indisponível neste browser";
document.body.classList.toggle("noUsb", !("serial" in navigator));
document.body.classList.toggle("noBle", !("bluetooth" in navigator));

if (!DEMO_BUILD && "serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("./sw.js").catch(() => {});

renderStatus(); renderAll(); showTab("teams"); fitAll();
if (DEMO_BUILD) {
  $("#demoTag").hidden = false;
  $("#lnkSetup").hidden = true; // a preparação de rádios não funciona dentro da demonstração
  raid.base = [39.6965, -8.2924]; // base fictícia no centro da zona
  void connect("demo").then(() => setTimeout(() => { fitted = false; fitAll(); renderAll(); }, 900));
}
(window as unknown as { raidtrack: unknown }).raidtrack = { get raid() { return raid; } }; // diagnóstico na consola
