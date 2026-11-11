// RaidTrack — service worker: app disponível sem Internet + mosaicos do mapa em cache
const APP = "raidtrack-app-v4";
const TILES = "raidtrack-tiles-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(["./", "./index.html", "./instalador.html", "./manifest.webmanifest", "./icon.svg"])).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== APP && k !== TILES).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;

  // Mosaicos: cache primeiro (funciona no campo sem rede)
  if (/tile\.(opentopomap|openstreetmap)\.org$/.test(url.hostname)) {
    // O relatório PDF pede mosaicos em modo CORS para os desenhar num canvas: uma resposta "opaca" (no-cors)
    // guardada pelo mapa não serve para isso, por isso estes ficam numa entrada à parte.
    const cors = e.request.mode === "cors";
    // (a chave muda na query: a Cache API ignora o "#" na comparação de endereços)
    const key = cors ? e.request.url + (url.search ? "&" : "?") + "_cors=1" : e.request.url;
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(key);
      if (hit) return hit;
      try {
        const r = await fetch(e.request.url, { mode: cors ? "cors" : "no-cors" });
        if (cors && !r.ok) return r;
        c.put(key, r.clone());
        return r;
      } catch { return new Response("", { status: 504 }); }
    }));
    return;
  }

  // App: rede primeiro (atualizações), cache se offline
  if (url.origin === location.origin) {
    e.respondWith(fetch(e.request).then((r) => {
      if (r.ok) caches.open(APP).then((c) => c.put(e.request, r.clone()));
      return r;
    }).catch(() => caches.match(e.request).then((h) => h || caches.match("./index.html"))));
  }
});
