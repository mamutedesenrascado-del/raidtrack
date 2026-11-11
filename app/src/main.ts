import "./shims/process";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./style.css";
import { connectRadio, type Dest, type Link, type LinkEvents, type LinkStatus } from "./link";
import { decode, encodePing, encodeSosAck, encodeText, encodeZone } from "./protocol";
import { adherence, clip, dist, distToRoute, fmtDur, fmtKm, inPolygon, oledText, walked, type LatLon } from "./geo";
import { DEMO_PLAN, startSim } from "./sim";
import { migrate, passedPost, distToPolygon, planBounds, planOf, postEtas } from "./plan";
import { initPlanner } from "./planner";
import type { AlertKind, CovPt, LogEv, Msg, Raid, Team, Zone } from "./types";
import { demoTerrain } from "./terrain";

/** Versão de demonstração (página única, dados fictícios, sem rádio) */
const DEMO_BUILD = import.meta.env.MODE === "demo";

// ───────────────────────────── Estado ─────────────────────────────
export type { Raid, Team, Zone, Route, LogEv } from "./types";
const COLORS = ["#2563eb", "#16a34a", "#9333ea", "#ea580c", "#0891b2", "#be185d", "#4d7c0f", "#a16207"];
const STALE_MS = 3 * 60_000;
const LOST_MS = 10 * 60_000;
const KEY = "raidtrack.raid.v1";

let raid: Raid = (DEMO_BUILD ? null : load()) ?? migrate({ started: Date.now(), teams: {}, msgs: [], log: [] });
let link: Link | null = null;
let linkKind = ""; // conhecido antes de a ligação terminar (o estado "ligado" chega antes de connectRadio devolver)
let myNum = 0;
let status: LinkStatus = "desligado";
let selected: number | null = null;

function load(): Raid | null {
  try { const s = localStorage.getItem(KEY); return s ? migrate(JSON.parse(s) as Raid) : null; } catch { return null; }
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

const planner = initPlanner({
  raid: () => raid, teams: () => teams(), map, demo: DEMO_BUILD,
  save: () => save(), log: (k, t) => log(k, t), toast: (t, k) => toast(t, k), ask: (t, o) => ask(t, o), esc: (x) => esc(x),
  download: (n, d, t) => download(n, d, t), fileBase: () => fileBase(),
  changed(what) {
    if (what === "zones") teams().forEach(checkZones);
    renderTeams(); fitted = fitted && what !== "route";
  },
});

const markers = new Map<number, L.Marker>();
const tracks = new Map<number, L.Polyline>();
let baseMarker: L.Marker | null = null;
let fitted = false;

function icon(t: Team) {
  const cls = t.sos && !t.sos.acked ? "sos" : t.sos ? "sos acked" : zoneOf(t) ? "zone" : Object.keys(t.alerts ?? {}).length ? `alert ${stateOf(t)}` : stateOf(t);
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
  const b = planBounds(raid, 50);
  if (b) pts.push([b[0], b[1]], [b[2], b[3]]);
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

/** Zona proibida onde a equipa está (nome), se alguma */
function zoneOf(t: Team): string | null {
  const ids = Object.keys(t.inZones ?? {});
  return ids.length ? (raid.zones ?? []).find((z) => z.id === ids[0])?.name ?? "zona" : null;
}
const toTime = (ms?: number) => (ms ? new Date(ms).toTimeString().slice(0, 5) : "");
/** "HH:MM" → ms no dia do raid (se for antes da partida, conta como dia seguinte) */
function fromTime(v: string, after?: number): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return undefined;
  const d = new Date(raid.started);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  let ms = d.getTime();
  if (after !== undefined && ms < after) ms += 86_400_000;
  return ms;
}
/** Estatísticas de uma equipa entre a partida e a chegada (ou todo o rasto) */
function teamStats(t: Team) {
  // sem hora de partida, conta desde o início do raid (pontos antigos guardados antes desta correção ficam de fora)
  const tr = clip(t.track, t.start ?? raid.started, t.end);
  const first = tr[0]?.[2], last = tr[tr.length - 1]?.[2];
  const t0 = t.start ?? first, t1 = t.end ?? (t.start ? Date.now() : last);
  return {
    track: tr,
    distance: walked(tr),
    duration: t0 !== undefined && t1 !== undefined ? Math.max(0, t1 - t0) : undefined,
    adh: raid.route ? adherence(tr, raid.route.pts, raid.corridor ?? 50) : null,
  };
}
export type TeamStats = ReturnType<typeof teamStats>;

const ALERT_TXT: Record<AlertKind, (t: Team, since: number) => string> = {
  parada: (t) => `Parada há ${ago(t.movedAt)}`,
  silencio: (t) => `Sem contacto há ${ago(t.heard)}`,
  desvio: (t) => `Fora do percurso há ${ago(t.offSince)}`,
  bateria: (t) => `Bateria ${t.bat ?? "?"}%`,
};
const planTeamOf = (t: Team) => raid.planTeams?.find((p) => p.code && p.code.toUpperCase() === t.short.toUpperCase());
/** partida real ou, sem ela, a prevista no plano */
function teamStart(t: Team): number | undefined {
  if (t.start) return t.start;
  const p = planTeamOf(t)?.start;
  return p ? fromTime(p, raid.started - 6 * 3_600_000) : undefined;
}
const diffTxt = (ms: number) => { const m = Math.round(ms / 60_000); return Math.abs(m) <= 2 ? "a horas" : m > 0 ? `+${fmtDur(m * 60_000)}` : `−${fmtDur(-m * 60_000)}`; };
const diffCls = (ms: number) => (ms > 15 * 60_000 ? "bad" : ms < -15 * 60_000 ? "early" : "");

function renderTeams() {
  // Não refazer os cartões enquanto se escreve uma hora (perdia-se o que se está a escrever)
  const ae = document.activeElement as HTMLElement | null;
  if (ae && ae.tagName === "INPUT" && ae.closest("#teams")) return;
  const etas = planner.etas();
  const nAlerts = (t: Team) => Object.keys(t.alerts ?? {}).length + Object.keys(t.nearDanger ?? {}).length;
  const list = teams().sort((a, b) => Number(!!b.sos) - Number(!!a.sos) || Number(!!zoneOf(b)) - Number(!!zoneOf(a)) || nAlerts(b) - nAlerts(a) || a.short.localeCompare(b.short));
  $("#teamCount").textContent = String(list.length);
  $("#teams").innerHTML = list.length ? list.map((t) => {
    const zone = zoneOf(t);
    const st = t.sos ? (t.sos.acked ? "sos acked" : "sos") : zone ? "zone" : nAlerts(t) ? "alert" : stateOf(t);
    const pt = planTeamOf(t);
    const badges = [
      ...Object.entries(t.alerts ?? {}).map(([k, since]) => ALERT_TXT[k as AlertKind](t, since!)),
      ...Object.keys(t.nearDanger ?? {}).map((id) => `Perto de: ${raid.zones?.find((z) => z.id === id)?.name ?? "perigo"}`),
    ];
    // postos: passados, último e próximo
    let postsHtml = "";
    if (etas.length) {
      const t0 = teamStart(t);
      const passed = etas.filter((e) => t.posts?.[e.post.id]);
      const lastE = passed.sort((a, b) => t.posts![a.post.id] - t.posts![b.post.id]).at(-1);
      const next = etas.find((e) => !t.posts?.[e.post.id]);
      const lastTxt = lastE ? `${esc(lastE.post.name)} ${hhmm(t.posts![lastE.post.id])}${t0 !== undefined && Number.isFinite(lastE.min) ? ` <small class="${diffCls(t.posts![lastE.post.id] - (t0 + lastE.min * 60_000))}">${diffTxt(t.posts![lastE.post.id] - (t0 + lastE.min * 60_000))}</small>` : ""}` : "—";
      const nextTxt = next ? `${esc(next.post.name)}${t0 !== undefined && Number.isFinite(next.min) ? ` <small>prev. ${hhmm(t0 + next.min * 60_000)}</small>` : ""}` : "<small>todos feitos</small>";
      postsHtml = `<dl class="plan"><div><dt>Postos ${passed.length}/${etas.length} · último</dt><dd>${lastTxt}</dd></div><div><dt>Próximo</dt><dd>${nextTxt}</dd></div></dl>`;
    }
    const stats = teamStats(t);
    const dev = raid.route && t.lat !== undefined ? distToRoute([t.lat, t.lon!], raid.route.pts) : null;
    const corr = raid.corridor ?? 50;
    const where = t.lat !== undefined ? `${t.lat.toFixed(5)}, ${t.lon!.toFixed(5)}` : "sem posição";
    return `<article class="team ${st} ${selected === t.num ? "sel" : ""}" data-num="${t.num}" style="--c:${t.color}">
      <header><b>${esc(t.short)}</b><span class="lname">${esc(t.long)}</span>
        <span class="state">${t.sos ? (t.sos.acked ? "SOS confirmado" : "SOS!") : zone ? "Zona proibida" : badges.length ? "Atenção" : STATE_TXT[stateOf(t)]}</span></header>
      ${pt?.members ? `<div class="members">${esc(pt.members)}</div>` : ""}
      ${badges.length ? `<div class="badges">${badges.map((b) => `<span>${esc(b)}</span>`).join("")}</div>` : ""}
      ${zone ? `<div class="zoneWarn">Dentro de: <b>${esc(zone)}</b> — aviso enviado ao tracker</div>` : ""}
      <dl>
        <div><dt>Última posição</dt><dd>${ago(t.posAt)}</dd></div>
        <div><dt>Bateria</dt><dd class="${(t.bat ?? 100) < 20 ? "low" : ""}">${t.bat !== undefined ? (t.bat > 100 ? "USB" : Math.round(t.bat) + "%") : "—"}</dd></div>
        <div><dt>Sinal</dt><dd>${t.snr !== undefined ? `${t.snr.toFixed(1)} dB${t.hops ? ` · ${t.hops} salto${t.hops > 1 ? "s" : ""}` : ""}` : "—"}</dd></div>
        <div><dt>Da base</dt><dd>${t.lat !== undefined ? distBrg(t.lat, t.lon!) || "base não definida" : "—"}</dd></div>
      </dl>
      ${raid.route || t.start || stats.track.length > 1 ? `<dl class="plan">
        ${raid.route ? `<div><dt>No percurso</dt><dd class="${stats.adh && stats.adh.onRoutePct < 70 ? "low" : ""}">${stats.adh ? Math.round(stats.adh.onRoutePct) + " %" : "—"}${dev !== null ? ` <small class="${dev > corr ? "bad" : ""}">· a ${fmtKm(dev)}</small>` : ""}</dd></div>` : ""}
        <div><dt>Distância${t.start ? "" : " (rasto)"}</dt><dd>${fmtKm(stats.distance)}${stats.duration !== undefined ? ` <small>· ${fmtDur(stats.duration)}</small>` : ""}</dd></div>
      </dl>` : ""}
      ${postsHtml}
      <div class="times">
        <label>Partida <input type="text" inputmode="numeric" maxlength="5" placeholder="hh:mm" data-time="start" value="${toTime(t.start)}" aria-label="Hora de partida de ${esc(t.short)}" /></label>
        <button data-act="startNow" title="Partiu agora">Agora</button>
        <label>Chegada <input type="text" inputmode="numeric" maxlength="5" placeholder="hh:mm" data-time="end" value="${toTime(t.end)}" aria-label="Hora de chegada de ${esc(t.short)}" /></label>
        <button data-act="endNow" title="Chegou agora">Agora</button>
      </div>
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
    const reads = Object.entries(m.reads ?? {});
    const readTxt = reads.length ? (m.to === "all" ? `lida: ${reads.map(([n]) => nameOf(Number(n))).join(", ")}` : `lida ${hhmm(reads[0][1])}`) : "";
    return `<div class="msg ${m.dir}" style="--c:${c}"><div class="mh"><b>${esc(who)}</b><time>${hhmm(m.t)}</time>${m.st ? `<em class="st ${m.st.replace(" ", "-")}">${m.st}</em>` : ""}${readTxt ? `<em class="st lida">${esc(readTxt)}</em>` : ""}</div><p>${esc(m.text)}</p></div>`;
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
  el.textContent = status === "ligado" ? `Ligado · ${link?.kind ?? linkKind}` : status === "a ligar" ? detail ?? "A ligar…" : "Desligado";
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

function renderAll() { renderTeams(); renderMsgs(); renderLog(); renderSos(); planner.render(); teams().forEach(drawTeam); drawBase(); }

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
    if (s !== was && s !== "a ligar") log("ligacao", s === "ligado" ? `Rádio ligado (${link?.kind ?? linkKind})` : "Rádio desligado");
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
    // Ao ligar, o rádio da base devolve a última posição que conhece de cada nó, que pode ser de dias antes:
    // serve para pôr a equipa no mapa, mas não entra no rasto nem nos alertas de zona.
    const stale = when < raid.started || (t.posAt !== undefined && when < t.posAt);
    if (stale && t.posAt !== undefined) return;
    t.lat = lat; t.lon = lon; t.posAt = when; t.heard = Math.max(t.heard ?? 0, when);
    if (stale) { drawTeam(t); renderTeams(); save(); return; }
    const last = t.track[t.track.length - 1];
    if (!last || last[0] !== lat || last[1] !== lon) t.track.push([lat, lon, when]);
    const cur: LatLon = [lat, lon];
    checkZones(t);
    checkPosts(t, last && last[2] >= (t.start ?? raid.started) ? [last[0], last[1]] : undefined, cur, when);
    // movimento (equipa parada) e afastamento do percurso
    if (!t.anchor || dist(t.anchor, cur) > 30) { t.anchor = cur; t.movedAt = when; clearAlert(t, "parada"); }
    if (raid.route) {
      if (distToRoute(cur, raid.route.pts) > (raid.corridor ?? 50)) t.offSince ??= when;
      else if (t.offSince) { t.offSince = undefined; clearAlert(t, "desvio", `${t.short} voltou ao percurso`); }
    }
    t.posRx = Date.now(); addCov(t);
    drawTeam(t); renderTeams(); save();
  },
  battery(n, pct) {
    if (n === myNum) return;
    const t = team(n); t.bat = pct;
    const lim = raid.alerts?.bat ?? 20;
    if (lim > 0 && pct <= lim) raiseAlert(t, "bateria", `${t.short}: bateria baixa (${pct}%)`);
    else if (pct > lim + 5) clearAlert(t, "bateria");
    renderTeams(); save();
  },
  radio(n, snr, rssi, hops) {
    if (n === myNum) return;
    const t = team(n); t.snr = snr; t.rssi = rssi; t.hops = hops; t.heard = Date.now();
    if (t.alerts?.silencio) { clearAlert(t, "silencio", `${t.short} voltou a dar sinal`); renderTeams(); }
    t.radioRx = Date.now(); addCov(t);
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
    } else if (m.type === "read") {
      const msg = [...raid.msgs].reverse().find((x) => x.dir === "out" && x.id === m.id);
      if (msg) {
        msg.reads ??= {};
        if (!msg.reads[from]) { msg.reads[from] = when; log("msg", `${t.short} leu: ${msg.text}`); }
        renderMsgs();
      } else if (Object.values(t.inZones ?? {}).some((v) => v.id === m.id)) {
        log("zona", `${t.short} confirmou o aviso de zona proibida`);
      }
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
    linkKind = how === "usb" ? "USB" : how === "ble" ? "Bluetooth" : "Simulação";
    link = how === "demo" ? startSim(events) : await connectRadio(how, events);
    if (how === "demo") toast("Demonstração: 5 equipas fictícias. A EQ2 envia um SOS ao fim de 25 s.");
  } catch (e) {
    link = null; status = "desligado"; renderStatus();
    const msg = (e as Error).message;
    if (!/cancel|No port selected|User cancelled/i.test(msg)) toast(msg, "warn");
  }
}

const newId = () => ((Math.random() * 0xfffe) | 0) + 1;
async function sendMsg(text: string, dest: Dest) {
  if (!link) return toast("Ligue o rádio primeiro", "warn");
  // Vai como mensagem RaidTrack: fica no ecrã do tracker até a equipa carregar OK, e volta a confirmação de leitura
  const m: Msg = { t: Date.now(), from: myNum, to: dest, text, dir: "out", st: "a enviar", id: newId(), reads: {} };
  raid.msgs.push(m); renderMsgs();
  log("msg", `Base → ${nameOf(dest)}: ${text}`);
  try { await link.sendPrivate(encodeText(m.id!, oledText(text)), dest); m.st = dest === "all" ? "enviada" : "entregue"; }
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

function download(name: string, data: string | Blob, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(typeof data === "string" ? new Blob([data], { type }) : data);
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportRaid() {
  if (DEMO_BUILD) return toast("Na app real, Exportar descarrega os percursos (GPX) e o registo do raid (CSV).");
  download(`${fileBase()}-percursos.gpx`, gpxText(), "application/gpx+xml");
  const csv = "hora;tipo;evento\n" + raid.log.map((e) => `${new Date(e.t).toLocaleString("pt-PT")};${e.kind};"${e.text.replace(/"/g, '""')}"`).join("\n");
  download(`${fileBase()}-registo.csv`, "\ufeff" + csv, "text/csv");
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
  // mantém o planeamento (nome, percurso, zonas): pode ser removido no separador Raid
  // mantém o plano (percurso, postos, zonas, equipas, mensagens programadas…), que se muda no separador Plano
  raid = migrate({ started: Date.now(), teams: {}, msgs: [], log: [], base: raid.base, ...planOf(raid) });
  markers.forEach((m) => m.remove()); markers.clear();
  tracks.forEach((p) => p.remove()); tracks.clear();
  fitted = false; save(); renderAll(); log("info", "Novo raid iniciado");
}

// ───────────────────────────── Zonas proibidas ─────────────────────────────
const ZONE_REPEAT_MS = 5 * 60_000;
function checkZones(t: Team) {
  if (t.lat === undefined || !raid.zones?.length) return;
  const p: LatLon = [t.lat, t.lon!];
  t.inZones ??= {};
  t.nearDanger ??= {};
  for (const z of raid.zones.filter((x) => x.kind === "perigo")) {
    const d = inPolygon(p, z.poly) ? 0 : distToPolygon(p, z.poly);
    const lim = z.warn ?? 50, near = t.nearDanger[z.id];
    if (d <= lim && !near) {
      t.nearDanger[z.id] = Date.now();
      log("zona", `${t.short} ${d === 0 ? "entrou na" : `está a ${Math.round(d)} m da`} zona de perigo "${z.name}"`);
      toast(`${t.short} perto da zona de perigo "${z.name}"`, "warn");
      beep(600, 200); setTimeout(() => beep(600, 200), 300);
      if (z.notifyTracker) void sendMsg(`ATENCAO: ${z.name}${z.notes ? `. ${z.notes}` : ""}`, t.num);
    } else if (d > lim + 20 && near) {
      delete t.nearDanger[z.id];
      log("zona", `${t.short} afastou-se da zona de perigo "${z.name}"`);
    }
  }
  for (const z of raid.zones.filter((x) => x.kind !== "perigo")) {
    const inside = inPolygon(p, z.poly);
    const was = t.inZones[z.id];
    if (inside && !was) {
      t.inZones[z.id] = { id: newId(), since: Date.now(), sentAt: 0 };
      log("zona", `${t.short} entrou na zona proibida "${z.name}"`);
      toast(`${t.short} entrou na zona proibida "${z.name}"`, "warn");
      beep(520, 300); setTimeout(() => beep(520, 300), 400); setTimeout(() => beep(520, 300), 800);
      void sendZoneAlert(t, z);
    } else if (!inside && was) {
      delete t.inZones[z.id];
      log("zona", `${t.short} saiu da zona proibida "${z.name}" (${fmtDur(Date.now() - was.since)} lá dentro)`);
      toast(`${t.short} saiu da zona proibida "${z.name}"`, "ok");
    }
  }
}
async function sendZoneAlert(t: Team, z: Zone) {
  const st = t.inZones?.[z.id];
  if (!st || !link) return;
  st.sentAt = Date.now();
  try { await link.sendPrivate(encodeZone(st.id, oledText(`${z.name}. Saiam ja desta zona!`)), t.num); }
  catch { toast(`O aviso de zona para ${t.short} não foi confirmado — volta a tentar`, "warn"); st.sentAt = Date.now() - ZONE_REPEAT_MS + 60_000; }
}
// ───────────────────────────── Postos, alertas e mensagens programadas ─────────────────────────────
function checkPosts(t: Team, prev: LatLon | undefined, cur: LatLon, when: number) {
  if (when < (t.start ?? raid.started) || (t.end && when > t.end)) return;
  for (const e of postEtas(raid)) {
    if (t.posts?.[e.post.id] || !passedPost(prev, cur, e.post)) continue;
    (t.posts ??= {})[e.post.id] = when;
    const t0 = teamStart(t);
    const diff = t0 !== undefined && Number.isFinite(e.min) ? ` (${diffTxt(when - (t0 + e.min * 60_000))} face ao previsto)` : "";
    log("posto", `${t.short} passou no ${e.post.name} às ${hhmm(when)}${diff}`);
    toast(`${t.short} passou no ${e.post.name}${diff}`, "ok");
  }
}
function raiseAlert(t: Team, k: AlertKind, text: string) {
  t.alerts ??= {};
  if (t.alerts[k]) return;
  t.alerts[k] = Date.now();
  log("alerta", text); toast(text, "warn");
  beep(700, 180); setTimeout(() => beep(700, 180), 260);
  markers.get(t.num)?.setIcon(icon(t));
}
function clearAlert(t: Team, k: AlertKind, text?: string) {
  if (!t.alerts?.[k]) return;
  delete t.alerts[k];
  if (text) log("alerta", text);
}
const MIN = 60_000;
function watchTick() {
  const now = Date.now(), a = raid.alerts ?? { stillMin: 20, silentMin: 15, offMin: 10, bat: 20 };
  for (const t of teams()) {
    const t0 = teamStart(t);
    const onWay = t0 !== undefined && t0 <= now && !t.end;
    if (!onWay) { (["parada", "silencio", "desvio"] as AlertKind[]).forEach((k) => clearAlert(t, k)); continue; }
    if (a.silentMin > 0 && now - (t.heard ?? t0) > a.silentMin * MIN) raiseAlert(t, "silencio", `${t.short}: sem contacto há ${ago(t.heard ?? t0)}`);
    const atPost = t.lat !== undefined && (raid.posts ?? []).some((p) => dist([t.lat!, t.lon!], [p.lat, p.lon]) <= Math.max(100, (p.radius ?? 40) * 2));
    const atBase = t.lat !== undefined && raid.base && dist([t.lat, t.lon!], raid.base) < 150;
    if (a.stillMin > 0 && t.movedAt && now - Math.max(t.movedAt, t0) > a.stillMin * MIN && !atPost && !atBase && !t.alerts?.silencio)
      raiseAlert(t, "parada", `${t.short}: parada há ${ago(Math.max(t.movedAt, t0))} fora dos postos`);
    else if (atPost || atBase) clearAlert(t, "parada");
    if (a.offMin > 0 && raid.route && t.offSince && now - Math.max(t.offSince, t0) > a.offMin * MIN) raiseAlert(t, "desvio", `${t.short}: fora do percurso há ${ago(t.offSince)}`);
  }
  // mensagens programadas
  for (const m of raid.sched ?? []) {
    if (m.sent) continue;
    let at = fromTime(m.at)!;
    if (at < raid.started - 60_000) at += 86_400_000; // raid que passa a meia-noite
    if (now < at) continue;
    if (now - at > 30 * MIN) { m.sent = -1; log("msg", `Mensagem programada das ${m.at} não enviada (a hora passou): ${m.text}`); continue; }
    if (!link) continue; // fica à espera do rádio, até 30 min
    const dest = m.dest === "all" ? "all" : teams().find((t) => t.short.toUpperCase() === m.dest.toUpperCase())?.num;
    if (dest === undefined) { m.sent = -1; log("msg", `Mensagem programada das ${m.at}: equipa ${m.dest} não encontrada`); continue; }
    m.sent = now;
    void sendMsg(m.text, dest);
  }
  save();
}

// ───────────────────────────── Mapa de cobertura rádio ─────────────────────────────
const covLayer = L.layerGroup();
const covColor = (c: CovPt) => (c[4] ? "#6b7280" : c[2] >= 0 ? "#16a34a" : c[2] >= -7 ? "#84cc16" : c[2] >= -12 ? "#f59e0b" : "#dc2626");
function covDot(c: CovPt) {
  return L.circleMarker([c[0], c[1]], { radius: 6, color: "#fff", weight: 1, fillColor: covColor(c), fillOpacity: c[4] ? 0.45 : 0.85 })
    .bindTooltip(`SNR ${c[2].toFixed(1)} dB · RSSI ${c[3]} dBm${c[4] ? ` · via ${c[4]} repetidor${c[4] > 1 ? "es" : ""}` : " · direto"}<br>${hhmm(c[5])}`);
}
function addCov(t: Team) {
  if (!t.posRx || !t.radioRx || Math.abs(t.posRx - t.radioRx) > 4000 || (t.covAt ?? 0) >= Math.max(t.posRx, t.radioRx) || t.lat === undefined || t.snr === undefined) return;
  t.covAt = Date.now();
  const c: CovPt = [t.lat, t.lon!, t.snr, t.rssi ?? 0, t.hops ?? null, t.covAt];
  (raid.cov ??= []).push(c);
  if (raid.cov.length > 5000) raid.cov.splice(0, raid.cov.length - 5000);
  if (map.hasLayer(covLayer)) covDot(c).addTo(covLayer);
}
function toggleCov() {
  const on = !map.hasLayer(covLayer);
  covLayer.clearLayers();
  if (on) { (raid.cov ?? []).forEach((c) => covDot(c).addTo(covLayer)); covLayer.addTo(map); if (!raid.cov?.length) toast("Ainda sem pontos de cobertura: aparecem à medida que chegam posições pelo rádio"); }
  else covLayer.remove();
  $("#btnCov").setAttribute("aria-pressed", String(on));
  $("#covLegend").hidden = !on;
}

// ───────────────────────────── Rever o raid ─────────────────────────────
let replay: { layer: L.LayerGroup; t0: number; t1: number; T: number; timer: number } | null = null;
function startReplay() {
  const all = teams().flatMap((t) => t.track.filter((p) => p[2] >= raid.started).map((p) => p[2]));
  if (!all.length) return toast("Ainda não há percursos para rever", "warn");
  const t0 = Math.min(...all), t1 = Math.max(...all);
  markers.forEach((m) => m.remove()); tracks.forEach((p) => p.remove());
  replay = { layer: L.layerGroup().addTo(map), t0, t1, T: t0, timer: 0 };
  $("#replay").hidden = false;
  setReplay(t0);
}
function setReplay(T: number) {
  if (!replay) return;
  replay.T = Math.min(Math.max(T, replay.t0), replay.t1);
  replay.layer.clearLayers();
  for (const t of teams()) {
    const pts = t.track.filter((p) => p[2] >= raid.started && p[2] <= replay!.T);
    if (!pts.length) continue;
    L.polyline(pts.map((p) => [p[0], p[1]] as L.LatLngTuple), { color: t.color, weight: 4, opacity: 0.85 }).addTo(replay.layer);
    const last = pts[pts.length - 1];
    L.marker([last[0], last[1]], { icon: L.divIcon({ className: "", iconSize: [36, 36], iconAnchor: [18, 18], html: `<div class="pin small" style="--c:${t.color}"><span>${esc(t.short)}</span></div>` }) }).addTo(replay.layer);
  }
  const multi = new Date(replay.t0).toDateString() !== new Date(replay.t1).toDateString();
  $("#rpTime").textContent = new Date(replay.T).toLocaleString("pt-PT", multi ? { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" } : { hour: "2-digit", minute: "2-digit" });
  $<HTMLInputElement>("#rpSlider").value = String(Math.round(((replay.T - replay.t0) / Math.max(1, replay.t1 - replay.t0)) * 1000));
}
function playReplay() {
  if (!replay) return;
  if (replay.timer) { clearInterval(replay.timer); replay.timer = 0; $("#rpPlay").textContent = "▶"; return; }
  if (replay.T >= replay.t1) replay.T = replay.t0;
  $("#rpPlay").textContent = "❚❚";
  replay.timer = window.setInterval(() => {
    const speed = Number($<HTMLSelectElement>("#rpSpeed").value);
    setReplay(replay!.T + speed * 200);
    if (replay!.T >= replay!.t1) playReplay();
  }, 200);
}
function closeReplay() {
  if (!replay) return;
  clearInterval(replay.timer); replay.layer.remove(); replay = null;
  $("#replay").hidden = true; $("#rpPlay").textContent = "▶";
  markers.forEach((m) => m.addTo(map)); tracks.forEach((p) => p.addTo(map));
}

function zoneReminders() {
  for (const t of teams()) for (const [zid, st] of Object.entries(t.inZones ?? {})) {
    const z = raid.zones?.find((x) => x.id === zid && x.kind !== "perigo");
    if (!z) { delete t.inZones![zid]; continue; }
    if (Date.now() - st.sentAt > ZONE_REPEAT_MS) void sendZoneAlert(t, z);
  }
}

// ───────────────────────────── Ficheiros do fim do raid ─────────────────────────────
function gpxText(): string {
  const parts = [`<?xml version="1.0" encoding="UTF-8"?>`,
    `<gpx version="1.1" creator="RaidTrack" xmlns="http://www.topografix.com/GPX/1/1">`,
    `<metadata><name>${esc(raid.name || "Raid")}</name><time>${new Date(raid.started).toISOString()}</time></metadata>`];
  for (const w of raid.posts ?? []) parts.push(`<wpt lat="${w.lat}" lon="${w.lon}"><name>${esc(w.name)}</name>${w.notes ? `<desc>${esc(w.notes)}</desc>` : ""}</wpt>`);
  for (const r of raid.recon ?? []) parts.push(`<trk><name>Reconhecimento: ${esc(r.name)}</name><trkseg>`, ...r.pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`), `</trkseg></trk>`);
  if (raid.route) parts.push(`<trk><name>Percurso teórico: ${esc(raid.route.name)}</name><trkseg>`, ...raid.route.pts.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`), `</trkseg></trk>`);
  for (const t of teams()) {
    parts.push(`<trk><name>${esc(t.short)} ${esc(t.long)}</name><trkseg>`);
    parts.push(...t.track.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"><time>${new Date(p[2]).toISOString()}</time></trkpt>`));
    parts.push(`</trkseg></trk>`);
  }
  parts.push(`</gpx>`, "");
  return parts.join("\n");
}
const fileBase = () => `${(raid.name || "raid").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "raid"}-${new Date(raid.started).toISOString().slice(0, 10)}`;
function saveGpx() {
  if (DEMO_BUILD) return toast("Na app real, descarrega um GPX com o percurso teórico e os percursos de todas as equipas.");
  download(`${fileBase()}-percursos.gpx`, gpxText(), "application/gpx+xml");
}
async function makeReport() {
  if (!teams().length) return toast("Ainda não há equipas para o relatório", "warn");
  const btn = $<HTMLButtonElement>("#btnReport");
  btn.disabled = true; btn.textContent = "A gerar…";
  try {
    const { buildReport } = await import("./report");
    const rep = await buildReport(raid, teams(), teamStats, (m) => (btn.textContent = m), DEMO_BUILD, teamStart);
    if (DEMO_BUILD) {
      // a página de demonstração não descarrega nem mostra PDF: pré-visualização do conteúdo
      $("#pdfBody").innerHTML = `<p class="muted">Na app real, isto é descarregado como PDF (${rep.pages} páginas). Mapas sem fundo nesta demonstração: com Internet levam o mapa OpenStreetMap.</p>
        <div class="tblWrap"><table><thead><tr>${rep.head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rep.rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
        ${rep.maps.map((m) => `<figure><img src="${m.img}" alt="Mapa: ${esc(m.title)}" /><figcaption>${esc(m.title)}</figcaption></figure>`).join("")}`;
      $("#pdfView").hidden = false;
    } else {
      const url = URL.createObjectURL(rep.pdf);
      const a = document.createElement("a");
      a.href = url; a.download = `${fileBase()}-relatorio.pdf`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast("Relatório PDF descarregado", "ok");
    }
  } catch (e) { toast(`Não foi possível gerar o relatório: ${(e as Error).message}`, "warn"); }
  finally { btn.disabled = false; btn.textContent = "Relatório PDF"; }
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
  if ((e.target as HTMLElement).closest(".times label")) return; // a escrever uma hora
  const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
  if (act === "locate") void ping(num);
  else if (act === "startNow" || act === "endNow") {
    const t = raid.teams[num];
    if (act === "startNow") { t.start = Date.now(); log("info", `${t.short} partiu às ${hhmm(t.start)}`); }
    else { t.end = Date.now(); log("info", `${t.short} chegou às ${hhmm(t.end)}`); }
    renderTeams(); save();
  }
  else if (act === "center") center(num);
  else if (act === "msg") { showTab("msgs"); $<HTMLSelectElement>("#msgTo").value = String(num); $<HTMLInputElement>("#msgText").focus(); }
  else { select(num); center(num); }
});
$("#teams").addEventListener("change", (e) => {
  const inp = e.target as HTMLInputElement;
  const which = inp.dataset.time as "start" | "end" | undefined;
  const card = inp.closest<HTMLElement>(".team");
  if (!which || !card) return;
  const t = raid.teams[Number(card.dataset.num)];
  const raw = inp.value.trim().replace(/[h.]/, ":").replace(/^(\d{1,2})(\d{2})$/, "$1:$2");
  const v = raw ? fromTime(raw, which === "end" ? t.start : undefined) : undefined;
  if (raw && v === undefined) { toast("Hora inválida: use hh:mm (ex. 09:30)", "warn"); inp.value = toTime(t[which]); return; }
  t[which] = v;
  if (v) log("info", `${t.short}: ${which === "start" ? "partida" : "chegada"} às ${hhmm(v)}`);
  save();
});
$("#teams").addEventListener("focusout", () => setTimeout(() => { if (!document.activeElement?.closest("#teams")) renderTeams(); }, 0));
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

$("#btnGpx").onclick = saveGpx;
$("#btnCov").onclick = toggleCov;
$("#btnReplay").onclick = startReplay;
$("#rpPlay").onclick = playReplay;
$("#rpClose").onclick = closeReplay;
$<HTMLInputElement>("#rpSlider").oninput = (e) => { if (!replay) return; setReplay(replay.t0 + (Number((e.target as HTMLInputElement).value) / 1000) * (replay.t1 - replay.t0)); };
$("#btnReport").onclick = () => void makeReport();
$("#pdfClose").onclick = () => { $("#pdfView").hidden = true; $("#pdfBody").innerHTML = ""; };

// Relógio do raid e envelhecimento dos estados
setInterval(() => {
  const s = Math.floor((Date.now() - raid.started) / 1000);
  $("#clock").textContent = `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  renderTeams();
  teams().forEach((t) => markers.get(t.num)?.setIcon(icon(t)));
  zoneReminders();
  watchTick();
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
  raid.started = Date.now() - 20 * 60_000; // o simulador traz rasto dos últimos minutos
  Object.assign(raid, DEMO_PLAN(raid.started));
  migrate(raid);
  void connect("demo").then(() => setTimeout(() => {
    // equipas a andar partiram no início do rasto
    teams().forEach((t) => { if (t.track.length && Date.now() - (t.heard ?? 0) < 120_000) t.start = t.track[0][2]; });
    fitted = false; fitAll(); renderAll();
  }, 900));
}
(window as unknown as { raidtrack: unknown }).raidtrack = { get raid() { return raid; } }; // diagnóstico na consola
