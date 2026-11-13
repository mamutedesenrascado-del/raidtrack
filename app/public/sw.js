// RaidTrack — service worker: app disponível sem Internet + mosaicos do mapa em cache.
// PRECACHE e VERSAO são preenchidos na compilação (vite.config.ts) com todos os ficheiros da app:
// basta abrir a app uma vez com Internet para ficar tudo guardado neste computador / tablet.
const PRECACHE = [];
const VERSAO = "dev";
const APP = "raidtrack-app-" + VERSAO;
const TILES = "raidtrack-tiles-v1";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(APP);
    // um a um: um ficheiro que falhe não impede os outros (volta a tentar na próxima abertura)
    await Promise.allSettled(["./", ...PRECACHE].map(async (u) => {
      const r = await fetch(u, { cache: "reload" });
      if (r.ok) await c.put(u, r);
    }));
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const comTempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tempo")), ms))]);

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Mosaicos: cache primeiro (funciona no campo sem rede)
  if (/tile\.(opentopomap|openstreetmap)\.org$/.test(url.hostname)) {
    // O relatório PDF pede mosaicos em modo CORS para os desenhar num canvas: uma resposta "opaca" (no-cors)
    // guardada pelo mapa não serve para isso, por isso estes ficam numa entrada à parte.
    // (a chave muda na query: a Cache API ignora o "#" na comparação de endereços)
    const cors = e.request.mode === "cors";
    const key = cors ? e.request.url + (url.search ? "&" : "?") + "_cors=1" : e.request.url;
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(key);
      if (hit) return hit;
      try {
        const r = await fetch(e.request.url, { mode: cors ? "cors" : "no-cors" });
        if (cors && !r.ok) return r;
        await c.put(key, r.clone());
        return r;
      } catch { return new Response("", { status: 504 }); }
    }));
    return;
  }

  if (url.origin !== location.origin) return;
  // Ficheiros com nome único (assets/…-hash.js, firmware): cache primeiro — nunca mudam
  if (/\/assets\//.test(url.pathname) || /\.bin$/.test(url.pathname)) {
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((h) => h || fetch(e.request).then(async (r) => {
      if (r.ok) { const c = await caches.open(APP); await c.put(e.request, r.clone()); }
      return r;
    })));
    return;
  }
  // Páginas e manifestos: rede primeiro (atualizações), com limite de 4 s; sem rede usa a cópia guardada
  e.respondWith((async () => {
    try {
      const r = await comTempo(fetch(e.request), 4000);
      if (r.ok) { const copia = r.clone(); caches.open(APP).then((c) => c.put(e.request, copia)); }
      return r;
    } catch {
      const h = await caches.match(e.request, { ignoreSearch: true });
      if (h) return h;
      if (e.request.mode === "navigate")
        return (await caches.match(url.pathname.endsWith("instalador.html") ? "./instalador.html" : "./index.html")) || (await caches.match("./"));
      return new Response("", { status: 504 });
    }
  })());
});
