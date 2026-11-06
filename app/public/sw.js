// RaidTrack — service worker: app disponível sem Internet + mosaicos do mapa em cache
const APP = "raidtrack-app-v2";
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
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request.url);
      if (hit) return hit;
      try {
        const r = await fetch(e.request.url, { mode: "no-cors" });
        c.put(e.request.url, r.clone());
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
