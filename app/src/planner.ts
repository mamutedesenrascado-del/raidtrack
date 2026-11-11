// Separador "Plano": preparação do raid (percurso, reconhecimento, postos, zonas, equipas, segurança,
// mensagens programadas, alertas), desenho no mapa e ficheiro .raidtrack.
import L from "leaflet";
import { fmtDur, fmtKm, lineLength, adherence, parseGpx, type LatLon } from "./geo";
import { applyPlan, normTime, parsePlanFile, planBounds, planFile, postEtas, routeMinutes, tilesFor, TOPO, TOPO_TEMPLATE, type PlanFile, type PostEta } from "./plan";
import { DEFAULT_ALERTS, type LogEv, type Raid, type Team, type Zone } from "./types";

export interface PlannerCtx {
  raid(): Raid;
  teams(): Team[];
  map: L.Map;
  demo: boolean;
  save(): void;
  log(kind: LogEv["kind"], text: string): void;
  toast(text: string, kind?: "" | "warn" | "ok"): void;
  ask(text: string, ok?: string): Promise<boolean>;
  esc(s: string): string;
  download(name: string, data: string | Blob, type: string): void;
  /** o plano mudou: atualizar cartões, alertas de zona, etc. */
  changed(what: "zones" | "route" | "posts" | "other"): void;
  fileBase(): string;
}

const TILE_CACHE = "raidtrack-tiles-v1";
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;

export function initPlanner(c: PlannerCtx) {
  const { map, esc } = c;
  const R = () => c.raid();
  const layer = L.layerGroup().addTo(map);
  let drawing: { name: string; kind: "proibida" | "perigo"; pts: LatLon[]; line: L.Polyline } | null = null;
  let addingPost = false;
  let etas: PostEta[] = [];

  // ───── desenho no mapa ─────
  function draw() {
    layer.clearLayers();
    const r = R();
    for (const z of r.zones ?? []) {
      const danger = z.kind === "perigo";
      L.polygon(z.poly, danger
        ? { color: "#b45309", weight: 2, fillColor: "#f59e0b", fillOpacity: 0.16, dashArray: "2 5" }
        : { color: "#b91c1c", weight: 2, fillColor: "#ef4444", fillOpacity: 0.18, dashArray: "6 4" })
        .bindTooltip(`${danger ? "Perigo" : "Zona proibida"}: ${esc(z.name)}${z.notes ? `<br><small>${esc(z.notes)}</small>` : ""}`, { sticky: true }).addTo(layer);
    }
    for (const rc of r.recon ?? []) L.polyline(rc.pts, { color: "#0284c7", weight: 3, opacity: 0.8, dashArray: "1 6", lineCap: "round" }).bindTooltip(`Reconhecimento: ${esc(rc.name)}`, { sticky: true }).addTo(layer);
    const rt = r.route;
    if (rt) {
      L.polyline(rt.pts, { color: "#111827", weight: 9, opacity: 0.12 }).addTo(layer);
      L.polyline(rt.pts, { color: "#111827", weight: 3, opacity: 0.85, dashArray: "10 6" }).bindTooltip(`Percurso: ${esc(rt.name)}`, { sticky: true }).addTo(layer);
    }
    etas.forEach((e, i) => {
      const p = e.post;
      L.circle([p.lat, p.lon], { radius: p.radius ?? 40, color: "#a16207", weight: 1, fillOpacity: 0.08 }).addTo(layer);
      L.marker([p.lat, p.lon], { icon: L.divIcon({ className: "", iconSize: [24, 24], iconAnchor: [12, 12], html: `<div class="postPin">${i + 1}</div>` }), zIndexOffset: 40 })
        .bindTooltip(`<b>${esc(p.name)}</b>${Number.isFinite(e.min) ? `<br>previsto: +${fmtDur(e.min * 60_000)}` : ""}${p.notes ? `<br><small>${esc(p.notes)}</small>` : ""}`).addTo(layer);
    });
  }

  // ───── formulário ─────
  const get = (path: string): unknown => path.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], R());
  function set(path: string, v: unknown) {
    const ks = path.split("."), r = R() as unknown as Record<string, unknown>;
    let o = r;
    for (const k of ks.slice(0, -1)) o = (o[k] ??= k === "alerts" ? { ...DEFAULT_ALERTS } : {}) as Record<string, unknown>;
    o[ks[ks.length - 1]] = v;
  }
  const typing = (el: Element) => document.activeElement === el;

  function render() {
    const r = R();
    etas = postEtas(r);
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("#pane-raid [data-bind]").forEach((el) => {
      if (typing(el)) return;
      const v = get(el.dataset.bind!);
      el.value = v === undefined || v === null ? (el.dataset.bind === "corridor" ? "50" : el.dataset.bind === "speed" ? "3.5" : "") : String(v);
    });
    const rt = r.route;
    const tot = routeMinutes(r);
    $("#routeInfo").innerHTML = rt
      ? `<b>${esc(rt.name)}</b> · ${fmtKm(lineLength(rt.pts))}${tot ? ` · cerca de ${fmtDur(tot * 60_000)} a andar` : ""}${rt.ele ? " · com altitude" : ""}`
      : "Sem percurso teórico. Importe um ficheiro GPX.";
    $("#routeClear").hidden = !rt;

    const rec = r.recon ?? [];
    $("#reconCount").textContent = rec.length ? String(rec.length) : "";
    $("#reconList").innerHTML = rec.map((x) => {
      const a = rt ? adherence(x.pts.map((p, i) => [p[0], p[1], i * 60_000]), rt.pts, r.corridor ?? 50) : null;
      return `<li data-id="${x.id}"><span><b>${esc(x.name)}</b> · ${fmtKm(lineLength(x.pts))}${a ? ` · ${Math.round(a.onRoutePct)} % no percurso` : ""}</span>
        <button data-act="view">Ver</button><button data-act="del">Apagar</button></li>`;
    }).join("");

    const posts = r.posts ?? [];
    $("#postCount").textContent = posts.length ? String(posts.length) : "";
    $("#postList").innerHTML = etas.length ? etas.map((e) => {
      const p = e.post;
      return `<li data-id="${p.id}">
        <div class="row"><input data-f="name" value="${esc(p.name)}" aria-label="Nome do posto" />
          <span class="eta" title="Tempo previsto desde a partida">${Number.isFinite(e.min) ? `+${fmtDur(e.min * 60_000)}` : "—"}</span></div>
        <div class="row small"><label>Raio <input data-f="radius" type="number" min="10" max="500" step="5" value="${p.radius ?? 40}" /> m</label>
          ${Number.isFinite(e.s) ? `<span class="muted">${fmtKm(e.s)} do início${e.off > 100 ? ` · <b class="bad">a ${fmtKm(e.off)} do percurso</b>` : ""}</span>` : ""}
          <button data-act="view">Ver</button><button data-act="del">Apagar</button></div>
        <input data-f="notes" value="${esc(p.notes ?? "")}" placeholder="Notas (atividade, chefe de posto, contacto)" aria-label="Notas do posto" />
      </li>`;
    }).join("") : `<li class="empty">Sem postos. Importe um GPX com pontos (wpt) ou adicione no mapa.</li>`;
    $("#postAdd").textContent = addingPost ? "Clique no mapa onde fica o posto…" : "Adicionar posto no mapa";

    const zs = r.zones ?? [];
    $("#zoneCount").textContent = zs.length ? String(zs.length) : "";
    $("#zoneList").innerHTML = zs.length ? zs.map((z) => `<li data-id="${z.id}" class="${z.kind === "perigo" ? "danger" : ""}">
        <div class="row"><span class="tag">${z.kind === "perigo" ? "Perigo" : "Proibida"}</span><input data-f="name" value="${esc(z.name)}" aria-label="Nome da zona" />
          <button data-act="view">Ver</button><button data-act="del">Apagar</button></div>
        ${z.kind === "perigo" ? `<div class="row small"><label>Avisar a <input data-f="warn" type="number" min="0" max="1000" step="10" value="${z.warn ?? 50}" /> m</label>
          <label class="chk"><input data-f="notifyTracker" type="checkbox" ${z.notifyTracker ? "checked" : ""} /> avisar tracker</label></div>` : ""}
        <input data-f="notes" value="${esc(z.notes ?? "")}" placeholder="Nota (ex. atravessar só na passadeira)" aria-label="Nota da zona" />
      </li>`).join("") : `<li class="empty">Sem zonas.</li>`;
    $("#zoneDraw").hidden = !!drawing;
    $("#zoneDrawing").hidden = !drawing;
    if (drawing) $("#zoneDrawHint").textContent = `A desenhar "${drawing.name}" (${drawing.kind}): ${drawing.pts.length} ponto${drawing.pts.length === 1 ? "" : "s"}. Clique no mapa para marcar os cantos.`;

    const pts = r.planTeams ?? [];
    $("#ptCount").textContent = pts.length ? String(pts.length) : "";
    $("#ptList").innerHTML = pts.map((t) => `<li data-id="${t.id}">
        <div class="row"><input data-f="code" value="${esc(t.code)}" maxlength="4" placeholder="EQ1" class="code" aria-label="Código" />
          <input data-f="name" value="${esc(t.name)}" placeholder="Nome da equipa" aria-label="Nome" />
          <input data-f="start" value="${esc(t.start)}" placeholder="hh:mm" maxlength="5" class="hh" aria-label="Partida prevista" title="Partida prevista" />
          <button data-act="del" aria-label="Apagar">✕</button></div>
        <input data-f="members" value="${esc(t.members)}" placeholder="Elementos (nomes, guia, sub-guia)" aria-label="Elementos" />
      </li>`).join("");

    const sc = r.sched ?? [];
    $("#schedCount").textContent = sc.length ? String(sc.length) : "";
    $("#schedList").innerHTML = [...sc].sort((a, b) => a.at.localeCompare(b.at)).map((s) => `<li data-id="${s.id}">
        <span><b>${esc(s.at)}</b> → ${s.dest === "all" ? "todas" : esc(s.dest)}: ${esc(s.text)}${s.sent ? ` <em class="st lida">enviada</em>` : ""}</span>
        <button data-act="del" aria-label="Apagar">✕</button></li>`).join("");
    const dsel = $<HTMLSelectElement>("#schedDest"), cur = dsel.value;
    const codes = [...new Set([...pts.map((t) => t.code), ...c.teams().map((t) => t.short)].filter(Boolean))].sort();
    dsel.innerHTML = `<option value="all">Todas as equipas</option>` + codes.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("");
    dsel.value = [...dsel.options].some((o) => o.value === cur) ? cur : "all";
    draw();
  }

  function changed(what: Parameters<PlannerCtx["changed"]>[0]) { c.save(); render(); c.changed(what); }

  // ligação genérica dos campos simples
  $("#pane-raid").addEventListener("change", (e) => {
    const el = e.target as HTMLInputElement;
    const path = el.dataset.bind;
    if (!path) return;
    let v: unknown = el.value.trim();
    if (el.dataset.num) {
      const [lo, hi] = el.dataset.num.split("-").map(Number);
      const n = Number(String(v).replace(",", "."));
      v = Number.isFinite(n) && n >= lo && n <= hi ? n : get(path);
      el.value = v === undefined ? "" : String(v);
    }
    set(path, v === "" ? undefined : v);
    changed(path === "corridor" || path === "speed" ? "route" : "other");
  });

  // listas: edição no próprio item
  const lists: Record<string, keyof Raid> = { "#reconList": "recon", "#postList": "posts", "#zoneList": "zones", "#ptList": "planTeams", "#schedList": "sched" };
  for (const [sel, key] of Object.entries(lists)) {
    const item = (e: Event) => {
      const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-id]");
      const arr = (R()[key] as { id: string }[] | undefined) ?? [];
      return { li, arr, obj: arr.find((x) => x.id === li?.dataset.id) as Record<string, unknown> | undefined };
    };
    $(sel).addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      const { obj } = item(e);
      if (!obj || !el.dataset.f) return;
      const f = el.dataset.f;
      if (el.type === "checkbox") obj[f] = el.checked;
      else if (el.type === "number") { const n = Number(el.value); if (Number.isFinite(n) && n >= 0) obj[f] = n; }
      else if (f === "start") { const v = normTime(el.value); if (el.value && !v) { c.toast("Hora inválida: use hh:mm", "warn"); el.value = String(obj[f] ?? ""); return; } obj[f] = v; }
      else obj[f] = f === "code" ? el.value.trim().toUpperCase().slice(0, 4) : el.value.trim();
      changed(key === "zones" ? "zones" : key === "posts" ? "posts" : "other");
    });
    $(sel).addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.act;
      const { arr, obj } = item(e);
      if (!obj || !act) return;
      const label = String(obj.name ?? obj.code ?? obj.text ?? "");
      if (act === "view") {
        const pts = (obj.pts ?? obj.poly ?? [[obj.lat, obj.lon]]) as LatLon[];
        if (pts.length === 1) map.setView(pts[0], Math.max(map.getZoom(), 17)); else map.fitBounds(L.latLngBounds(pts).pad(0.3));
      }
      if (act === "del") void c.ask(`Apagar "${label}"?`, "Apagar").then((ok) => {
        if (!ok) return;
        (R() as unknown as Record<string, unknown>)[key] = arr.filter((x) => x !== (obj as unknown));
        changed(key === "zones" ? "zones" : key === "posts" ? "posts" : "other");
      });
    });
  }

  // ───── percurso e reconhecimento ─────
  async function importRoute(f: File) {
    try {
      const g = parseGpx(await f.text());
      const r = R();
      r.route = { name: g.name, pts: g.route, ele: g.ele, wpts: [] };
      if (!r.name) r.name = g.name;
      // pontos (wpt) do GPX passam a postos, sem repetir os que já existem com o mesmo nome
      r.posts ??= [];
      const names = new Set(r.posts.map((p) => p.name));
      for (const w of g.waypoints) if (!names.has(w.name)) r.posts.push({ id: uid("p"), name: w.name, lat: w.lat, lon: w.lon });
      c.log("info", `Percurso importado: ${g.name} (${fmtKm(lineLength(g.route))}${g.waypoints.length ? `, ${g.waypoints.length} postos` : ""})`);
      changed("route");
      map.fitBounds(L.latLngBounds(g.route).pad(0.2));
      c.toast(`Percurso "${g.name}" importado`, "ok");
    } catch (e) { c.toast((e as Error).message, "warn"); }
  }
  async function importRecon(files: FileList) {
    for (const f of files) {
      try {
        const g = parseGpx(await f.text());
        (R().recon ??= []).push({ id: uid("r"), name: g.name === "Percurso" ? f.name.replace(/\.gpx$/i, "") : g.name, pts: g.route });
        c.toast(`Reconhecimento "${g.name}" importado`, "ok");
      } catch (e) { c.toast(`${f.name}: ${(e as Error).message}`, "warn"); }
    }
    changed("other");
  }
  $<HTMLInputElement>("#routeFile").onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importRoute(f); (e.target as HTMLInputElement).value = ""; };
  $<HTMLInputElement>("#reconFile").onchange = (e) => { const fs = (e.target as HTMLInputElement).files; if (fs?.length) void importRecon(fs); (e.target as HTMLInputElement).value = ""; };
  $("#routeClear").onclick = () => void c.ask("Remover o percurso teórico? Os postos ficam.", "Remover").then((ok) => { if (ok) { R().route = undefined; changed("route"); } });

  // ───── postos e zonas no mapa ─────
  $("#postAdd").onclick = () => { addingPost = !addingPost; document.body.classList.toggle("drawing", addingPost); render(); };
  function startZone() {
    const name = $<HTMLInputElement>("#zoneName").value.trim() || `Zona ${(R().zones?.length ?? 0) + 1}`;
    const kind = $<HTMLSelectElement>("#zoneKind").value as "proibida" | "perigo";
    drawing = { name, kind, pts: [], line: L.polyline([], { color: kind === "perigo" ? "#b45309" : "#b91c1c", weight: 2, dashArray: "4 4" }).addTo(map) };
    document.body.classList.add("drawing");
    render();
    c.toast("Clique no mapa para marcar os cantos da zona; no fim carregue em Concluir.");
  }
  function finishZone(keep: boolean) {
    if (!drawing) return;
    if (keep && drawing.pts.length < 3) { c.toast("Uma zona precisa de pelo menos 3 pontos", "warn"); return; }
    drawing.line.remove();
    if (keep) {
      const z: Zone = { id: uid("z"), name: drawing.name, poly: drawing.pts, kind: drawing.kind, ...(drawing.kind === "perigo" ? { warn: 50 } : {}) };
      (R().zones ??= []).push(z);
      c.log("info", `Zona ${drawing.kind === "perigo" ? "de perigo" : "proibida"} criada: ${drawing.name}`);
      $<HTMLInputElement>("#zoneName").value = "";
    }
    drawing = null;
    document.body.classList.remove("drawing");
    changed("zones");
  }
  map.on("click", (e) => {
    if (addingPost) {
      const r = R();
      (r.posts ??= []).push({ id: uid("p"), name: `Posto ${(r.posts.length ?? 0) + 1}`, lat: e.latlng.lat, lon: e.latlng.lng });
      addingPost = false; document.body.classList.remove("drawing");
      changed("posts");
      return;
    }
    if (!drawing) return;
    drawing.pts.push([e.latlng.lat, e.latlng.lng]);
    drawing.line.setLatLngs([...drawing.pts, drawing.pts[0]]);
    render();
  });
  $("#zoneDrawBtn").onclick = startZone;
  $("#zoneDone").onclick = () => finishZone(true);
  $("#zoneCancel").onclick = () => finishZone(false);
  $("#zoneUndo").onclick = () => { if (drawing?.pts.length) { drawing.pts.pop(); drawing.line.setLatLngs(drawing.pts.length ? [...drawing.pts, drawing.pts[0]] : []); render(); } };

  // ───── equipas previstas e mensagens programadas ─────
  $("#ptAdd").onclick = () => {
    const r = R(), n = (r.planTeams?.length ?? 0) + 1;
    (r.planTeams ??= []).push({ id: uid("t"), code: `EQ${n}`, name: "", members: "", start: "" });
    changed("other");
  };
  $("#schedAddBtn").onclick = () => {
    const at = normTime($<HTMLInputElement>("#schedAt").value);
    const text = $<HTMLInputElement>("#schedText").value.trim();
    if (!at) return c.toast("Indique a hora (hh:mm)", "warn");
    if (!text) return c.toast("Escreva o texto da mensagem", "warn");
    (R().sched ??= []).push({ id: uid("s"), at, text, dest: $<HTMLSelectElement>("#schedDest").value });
    $<HTMLInputElement>("#schedAt").value = ""; $<HTMLInputElement>("#schedText").value = "";
    changed("other");
  };

  // ───── ficheiro .raidtrack ─────
  async function savePlan() {
    const r = R();
    let tiles: PlanFile["tiles"];
    const btn = $<HTMLButtonElement>("#planSave");
    if ($<HTMLInputElement>("#planTiles").checked && !c.demo) {
      const b = planBounds(r);
      if (!b) c.toast("Sem percurso, postos nem zonas: o ficheiro vai sem mapa", "warn");
      else {
        const list = tilesFor(b);
        btn.disabled = true;
        const items: Record<string, string> = {};
        let fail = 0, done = 0;
        const queue = [...list];
        const worker = async () => {
          while (queue.length) {
            const [z, x, y] = queue.pop()!;
            try {
              const res = await fetch(TOPO(z, x, y), { mode: "cors" });
              if (!res.ok) throw new Error();
              items[`${z}/${x}/${y}`] = await toB64(await res.blob());
            } catch { fail++; }
            btn.textContent = `Mapa ${++done}/${list.length}…`;
          }
        };
        await Promise.all([worker(), worker(), worker()]); // poucos pedidos em paralelo: respeitar o servidor OpenTopoMap
        btn.disabled = false; btn.textContent = "Guardar plano";
        if (fail === list.length) c.toast("Não foi possível descarregar o mapa (sem Internet?): o ficheiro vai sem mapa", "warn");
        else tiles = { template: TOPO_TEMPLATE, items };
        if (fail && fail < list.length) c.toast(`${fail} mosaicos do mapa falharam`, "warn");
      }
    }
    const text = planFile(r, tiles);
    if (c.demo) return c.toast(`Na app real, descarrega o plano "${c.fileBase()}.raidtrack" (${Math.max(1, Math.round(text.length / 1024))} KB${$<HTMLInputElement>("#planTiles").checked ? ", mais o mapa da zona" : ""}).`);
    c.download(`${c.fileBase()}.raidtrack`, new Blob([text], { type: "application/json" }), "application/json");
    c.toast(`Plano guardado${tiles ? ` com ${Object.keys(tiles.items).length} mosaicos do mapa` : ""}`, "ok");
  }
  async function openPlan(f: File) {
    try {
      const pf = parsePlanFile(await f.text());
      const r = R();
      if ((r.route || r.posts?.length || r.zones?.length) && !(await c.ask(`Abrir o plano "${pf.plan.name ?? f.name}"? Substitui o plano atual (as equipas, posições e mensagens deste raid mantêm-se).`, "Abrir"))) return;
      applyPlan(r, pf.plan);
      let n = 0;
      if (pf.tiles && "caches" in window) {
        const cache = await caches.open(TILE_CACHE);
        for (const [k, b64] of Object.entries(pf.tiles.items)) {
          const [z, x, y] = k.split("/").map(Number);
          const blob = fromB64(b64);
          const url = TOPO(z, x, y);
          // guardado para o mapa (pedido normal) e para o relatório (pedido CORS): ver sw.js
          await cache.put(url, new Response(blob, { headers: { "Content-Type": "image/png" } }));
          await cache.put(url + "?_cors=1", new Response(blob, { headers: { "Content-Type": "image/png" } }));
          n++;
        }
      }
      c.log("info", `Plano aberto: ${pf.plan.name ?? f.name}${n ? ` (com ${n} mosaicos do mapa)` : ""}`);
      changed("zones"); c.changed("route");
      const b = planBounds(r, 100);
      if (b) map.fitBounds([[b[0], b[1]], [b[2], b[3]]]);
      c.toast(`Plano "${pf.plan.name ?? f.name}" aberto${n ? " com mapa offline" : ""}`, "ok");
    } catch (e) { c.toast((e as Error).message, "warn"); }
  }
  $("#planSave").onclick = () => void savePlan();
  $<HTMLInputElement>("#planFile").onchange = (e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) void openPlan(f); (e.target as HTMLInputElement).value = ""; };

  return { render, draw, etas: () => etas, busy: () => !!drawing || addingPost };
}

function toB64(b: Blob): Promise<string> {
  return new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(b); });
}
function fromB64(s: string): Blob {
  const bin = atob(s), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Blob([u], { type: "image/png" });
}
