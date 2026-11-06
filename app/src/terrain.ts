// Terreno fictício desenhado no próprio browser (curvas de nível + cores hipsométricas).
// Usado na versão de demonstração, onde os mosaicos de mapas externos não podem ser carregados.
import L from "leaflet";

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function noise(x: number, y: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const s = (t: number) => t * t * (3 - 2 * t);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  const u = s(xf), v = s(yf);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
/** Elevação em metros para coordenadas de mundo normalizadas [0,1) */
function elev(u: number, v: number) {
  const f = 26000; // ~1,5 km por "colina" nesta latitude
  let e = 0, amp = 1, fr = f;
  for (let o = 0; o < 5; o++) { e += noise(u * fr, v * fr) * amp; amp *= 0.5; fr *= 2.1; }
  return 180 + (e / 1.94) * 420; // 180–600 m
}

const RAMP: [number, [number, number, number]][] = [
  [180, [196, 222, 178]], [300, [214, 226, 170]], [420, [228, 216, 168]], [520, [214, 190, 150]], [600, [200, 176, 146]],
];
function color(e: number): [number, number, number] {
  for (let i = 1; i < RAMP.length; i++) {
    if (e <= RAMP[i][0]) {
      const [e0, c0] = RAMP[i - 1], [e1, c1] = RAMP[i], t = (e - e0) / (e1 - e0);
      return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * t) as [number, number, number];
    }
  }
  return RAMP[RAMP.length - 1][1];
}

export function demoTerrain() {
  const Layer = L.GridLayer.extend({
    createTile(coords: L.Coords) {
      const S = 256, canvas = document.createElement("canvas");
      canvas.width = canvas.height = S;
      const ctx = canvas.getContext("2d")!;
      const img = ctx.createImageData(S, S);
      const n = 2 ** coords.z * S;
      const step = coords.z >= 15 ? 10 : coords.z >= 13 ? 20 : 50; // equidistância das curvas
      const E = new Float32Array((S + 1) * (S + 1));
      for (let y = 0; y <= S; y++)
        for (let x = 0; x <= S; x++) E[y * (S + 1) + x] = elev((coords.x * S + x) / n, (coords.y * S + y) / n);
      for (let y = 0; y < S; y++)
        for (let x = 0; x < S; x++) {
          const e = E[y * (S + 1) + x];
          const k = Math.floor(e / step);
          const line = k !== Math.floor(E[y * (S + 1) + x + 1] / step) || k !== Math.floor(E[(y + 1) * (S + 1) + x] / step);
          const major = line && Math.floor(e / (step * 5)) !== Math.floor(E[(y + 1) * (S + 1) + x + 1] / (step * 5));
          // sombreamento simples (luz de noroeste)
          const sh = Math.max(-1, Math.min(1, (E[y * (S + 1) + x + 1] - E[(y + 1) * (S + 1) + x]) * (coords.z >= 15 ? 0.6 : 0.25)));
          let [r, g, b] = color(e);
          r += sh * 14; g += sh * 14; b += sh * 14;
          if (line) { const m = major ? 0.55 : 0.78; r = r * m + 120 * (1 - m); g = g * m + 80 * (1 - m); b = b * m + 40 * (1 - m); }
          const i = (y * S + x) * 4;
          img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = 255;
        }
      ctx.putImageData(img, 0, 0);
      return canvas;
    },
  });
  return new (Layer as unknown as new (o: L.GridLayerOptions) => L.GridLayer)({
    maxZoom: 18, attribution: "Terreno fictício · demonstração RaidTrack",
  });
}
