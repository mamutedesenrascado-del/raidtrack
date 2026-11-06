import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import { viteSingleFile } from "vite-plugin-singlefile";

const nodeShim = fileURLToPath(new URL("./src/shims/node.ts", import.meta.url));

// base relativa: funciona no GitHub Pages, num servidor local ou dentro do Capacitor (Android/iOS)
// `vite build --mode demo` gera uma página única com dados fictícios (dist-demo/index.html)
export default defineConfig(({ mode }) => ({
  base: "./",
  resolve: { alias: { os: nodeShim, path: nodeShim, util: nodeShim } },
  plugins: mode === "demo" ? [viteSingleFile()] : [],
  publicDir: mode === "demo" ? false : "public",
  build: {
    target: "es2022", chunkSizeWarningLimit: 1500, outDir: mode === "demo" ? "dist-demo" : "dist",
    rollupOptions: mode === "demo" ? undefined : { input: { app: "index.html", instalador: "instalador.html" } },
  },
}));
