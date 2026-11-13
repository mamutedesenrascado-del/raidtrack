import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { viteSingleFile } from "vite-plugin-singlefile";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Plugin } from "vite";

// Escreve no sw.js a lista de todos os ficheiros da app (para funcionar sem Internet) e uma versão
// que muda sempre que algum ficheiro muda. Também gera precache.json (a app usa-o para mostrar o estado).
function precache(): Plugin {
  let outDir = "dist";
  return {
    name: "raidtrack-precache",
    apply: "build",
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files: string[] = [];
      const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
      walk(outDir);
      const list = files.map((f) => relative(outDir, f).split("\\").join("/"))
        .filter((f) => f !== "sw.js" && f !== "precache.json" && !f.endsWith(".map")).sort();
      const h = createHash("sha256");
      for (const f of list) h.update(f).update(readFileSync(join(outDir, f)));
      const versao = h.digest("hex").slice(0, 12);
      const urls = list.map((f) => "./" + f);
      const sw = join(outDir, "sw.js");
      writeFileSync(sw, readFileSync(sw, "utf8").replace("const PRECACHE = [];", `const PRECACHE = ${JSON.stringify(urls)};`).replace('const VERSAO = "dev";', `const VERSAO = "${versao}";`));
      writeFileSync(join(outDir, "precache.json"), JSON.stringify({ versao, ficheiros: urls }));
    },
  };
}

const nodeShim = fileURLToPath(new URL("./src/shims/node.ts", import.meta.url));

// base relativa: funciona no GitHub Pages, num servidor local ou dentro do Capacitor (Android/iOS)
// `vite build --mode demo` gera uma página única com dados fictícios (dist-demo/index.html)
export default defineConfig(({ mode }) => ({
  base: "./",
  resolve: { alias: { os: nodeShim, path: nodeShim, util: nodeShim } },
  plugins: mode === "demo" ? [viteSingleFile()] : [precache()],
  publicDir: mode === "demo" ? false : "public",
  build: {
    target: "es2022", chunkSizeWarningLimit: 1500, outDir: mode === "demo" ? "dist-demo" : "dist",
    rollupOptions: mode === "demo" ? undefined : { input: { app: "index.html", instalador: "instalador.html" } },
  },
}));
