// A @meshtastic/core publicada inclui o logger "tslog" na versão Node; estes stubs mínimos
// deixam-no correr no browser (Windows/Mac/Android/iOS) sem alterar a biblioteca.
const g = globalThis as unknown as { process?: unknown; Buffer?: unknown };
g.process ??= { env: {}, cwd: () => "/", platform: "browser", versions: {} };
// O logger pergunta Buffer.isBuffer(x) ao registar objetos; no browser nada é um Buffer do Node
g.Buffer ??= { isBuffer: () => false };
export {};
