// Gravação e configuração dos rádios a partir do browser (Web Serial).
// Substitui compilar.py --gravar e configurar.py: nada a instalar no computador.
import { create } from "@bufbuild/protobuf";
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { TransportWebSerial } from "@meshtastic/transport-web-serial";
import { ESPLoader, Transport } from "esptool-js";

export type Role = "base" | "equipa";

export interface RadioPlan {
  role: Role;
  code: string; // nome curto, máx. 4 caracteres
  name: string; // nome longo
  pskB64: string; // chave do raid (32 bytes em base64)
  positionSecs: number; // intervalo de posição das equipas
}

export const CANAL = "RaidTrack";
// Sem acentos: o ecrã OLED do T-Beam não desenha todos os caracteres portugueses.
export const MENSAGENS = [
  "Tudo bem", "Chegamos ao posto", "Saimos do posto", "A regressar a base",
  "Precisamos de agua", "Ferido ligeiro", "Estamos perdidos", "Pedimos contacto",
];
// Botões do T-Beam (ver docs/PROTOCOLO.md)
const PIN_UP = 25, PIN_DOWN = 13, PIN_OK = 15;

type Log = (msg: string) => void;
type Progress = (pct: number, label: string) => void;

export function newKey(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b));
}
export function keyBytes(b64: string): Uint8Array | null {
  try {
    const s = atob(b64.trim());
    if (s.length !== 32 && s.length !== 16) return null;
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function pickPort(): Promise<SerialPort> {
  if (!("serial" in navigator)) throw new Error("Este browser não tem acesso a USB. Use Google Chrome ou Microsoft Edge no computador.");
  return navigator.serial.requestPort();
}

// ───────────────────────── Gravação ─────────────────────────

/**
 * Grava a imagem completa (`.factory.bin`, endereço 0x0).
 * eraseAll=true apaga tudo antes (instalação nova); false mantém a configuração (atualização).
 */
export async function flashFactory(port: SerialPort, image: Uint8Array, eraseAll: boolean, log: Log, progress: Progress) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: (d: string) => log(d), write: (d: string) => log(d) };
  const esp = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
  try {
    progress(2, "A ligar ao rádio…");
    const chip = await esp.main();
    log(`Chip detetado: ${chip}`);
    if (eraseAll) {
      progress(5, "A apagar a memória (até 1 minuto)…");
      await esp.eraseFlash();
    }
    progress(10, "A gravar o firmware…");
    await esp.writeFlash({
      fileArray: [{ data: image, address: 0x0 }],
      flashMode: "keep", flashFreq: "keep", flashSize: "keep",
      eraseAll: false, compress: true,
      reportProgress: (_i, written, total) => progress(10 + Math.round((written / total) * 85), `A gravar o firmware… ${Math.round((written / total) * 100)}%`),
    });
    progress(97, "A reiniciar o rádio…");
    await esp.after("hard_reset");
  } finally {
    try { await transport.disconnect(); } catch { /* já fechado */ }
  }
  progress(100, "Firmware gravado");
}

// ───────────────────────── Configuração ─────────────────────────

function waitConfigured(dev: MeshDevice, ms: number): Promise<number> {
  return new Promise((resolve, reject) => {
    let myNum = 0;
    const t = setTimeout(() => reject(new Error("O rádio não respondeu. Desligue e volte a ligar o cabo USB e tente de novo.")), ms);
    dev.events.onMyNodeInfo.subscribe((m) => (myNum = m.myNodeNum));
    dev.events.onDeviceStatus.subscribe((s) => {
      if (s === Types.DeviceStatusEnum.DeviceConfigured) { clearTimeout(t); resolve(myNum); }
    });
  });
}

const cfg = (c: Protobuf.Config.Config["payloadVariant"]) => create(Protobuf.Config.ConfigSchema, { payloadVariant: c });
const mod = (c: Protobuf.ModuleConfig.ModuleConfig["payloadVariant"]) => create(Protobuf.ModuleConfig.ModuleConfigSchema, { payloadVariant: c });

export type Setting =
  | { kind: "owner"; msg: Protobuf.Mesh.User }
  | { kind: "config"; msg: Protobuf.Config.Config }
  | { kind: "module"; msg: Protobuf.ModuleConfig.ModuleConfig }
  | { kind: "canned"; msg: Protobuf.CannedMessages.CannedMessageModuleConfig }
  | { kind: "channel"; msg: Protobuf.Channel.Channel };

/** Toda a configuração de um rádio, como mensagens prontas a enviar (função pura, testável sem rádio) */
export function buildSettings(plan: RadioPlan, psk: Uint8Array): [string, Setting][] {
  const C = Protobuf.Config, M = Protobuf.ModuleConfig;
  // A primeira alteração de config abre a transação de edição: tudo o resto fica pendente até ao commit (um só reinício)
  const out: [string, Setting][] = [
    ["Papel", { kind: "config", msg: cfg({ case: "device", value: create(C.Config_DeviceConfigSchema, { role: C.Config_DeviceConfig_Role.CLIENT }) }) }],
    ["Nome", { kind: "owner", msg: create(Protobuf.Mesh.UserSchema, { longName: plan.name, shortName: plan.code }) }],
    ["Rádio LoRa EU868", { kind: "config", msg: cfg({ case: "lora", value: create(C.Config_LoRaConfigSchema, {
      usePreset: true, region: C.Config_LoRaConfig_RegionCode.EU_868, modemPreset: C.Config_LoRaConfig_ModemPreset.LONG_FAST,
      hopLimit: 3, txEnabled: true }) }) }],
    ["Ecrã", { kind: "config", msg: cfg({ case: "display", value: create(C.Config_DisplayConfigSchema, { screenOnSecs: 86400 }) }) }],
    ["Telemetria", { kind: "module", msg: mod({ case: "telemetry", value: create(M.ModuleConfig_TelemetryConfigSchema, { deviceUpdateInterval: 300 }) }) }],
  ];
  if (plan.role === "equipa") {
    out.push(
      ["GPS e posição", { kind: "config", msg: cfg({ case: "position", value: create(C.Config_PositionConfigSchema, {
        gpsMode: C.Config_PositionConfig_GpsMode.ENABLED, gpsUpdateInterval: Math.min(30, plan.positionSecs),
        positionBroadcastSecs: plan.positionSecs, positionBroadcastSmartEnabled: false, fixedPosition: false }) }) }],
      ["Botões", { kind: "module", msg: mod({ case: "cannedMessage", value: create(M.ModuleConfig_CannedMessageConfigSchema, {
        enabled: true, updown1Enabled: true, inputbrokerPinA: PIN_UP, inputbrokerPinB: PIN_DOWN, inputbrokerPinPress: PIN_OK,
        allowInputSource: "updown1", sendBell: false }) }) }],
      ["Mensagens pré-definidas", { kind: "canned", msg: create(Protobuf.CannedMessages.CannedMessageModuleConfigSchema, { messages: MENSAGENS.join("|") }) }],
    );
  } else {
    out.push(
      ["Sem GPS", { kind: "config", msg: cfg({ case: "position", value: create(C.Config_PositionConfigSchema, { gpsMode: C.Config_PositionConfig_GpsMode.NOT_PRESENT }) }) }],
      ["Bluetooth", { kind: "config", msg: cfg({ case: "bluetooth", value: create(C.Config_BluetoothConfigSchema, {
        enabled: true, mode: C.Config_BluetoothConfig_PairingMode.RANDOM_PIN }) }) }],
    );
  }
  out.push(["Canal cifrado", { kind: "channel", msg: create(Protobuf.Channel.ChannelSchema, {
    index: 0, role: Protobuf.Channel.Channel_Role.PRIMARY,
    settings: create(Protobuf.Channel.ChannelSettingsSchema, { name: CANAL, psk }) }) }]);
  return out;
}

export async function configureRadio(port: SerialPort, plan: RadioPlan, log: Log, progress: Progress): Promise<{ nodeNum: number }> {
  const psk = keyBytes(plan.pskB64);
  if (!psk) throw new Error("A chave do raid não é válida.");

  progress(5, "A ligar ao rádio…");
  const transport = await TransportWebSerial.createFromPort(port, 115200);
  const dev = new MeshDevice(transport);
  const ready = waitConfigured(dev, 45_000);
  void dev.configure();
  const nodeNum = await ready;
  log(`Rádio ligado (nó ${nodeNum.toString(16)})`);

  const steps: [string, () => Promise<unknown>][] = buildSettings(plan, psk).map(([label, s]) => [label, () => {
    switch (s.kind) {
      case "owner": return dev.setOwner(s.msg);
      case "config": return dev.setConfig(s.msg);
      case "module": return dev.setModuleConfig(s.msg);
      case "canned": return dev.setCannedMessages(s.msg);
      case "channel": return dev.setChannel(s.msg);
    }
  }]);

  try {
    for (let i = 0; i < steps.length; i++) {
      const [label, run] = steps[i];
      progress(10 + Math.round((i / steps.length) * 80), `A configurar: ${label}…`);
      await run();
      log(`✓ ${label}`);
    }
    progress(92, "A guardar e reiniciar…");
    await dev.commitEditSettings();
    log("✓ Configuração guardada; o rádio vai reiniciar");
  } finally {
    await new Promise((r) => setTimeout(r, 1500));
    try { await dev.disconnect(); } catch { /* o rádio já reiniciou */ }
  }
  progress(100, "Configurado");
  return { nodeNum };
}

/** Lê a imagem de firmware publicada com a app (GitHub Pages) */
export interface FirmwareManifest { version: string; built: string; files: Record<Role, string> }
export async function loadManifest(): Promise<FirmwareManifest | null> {
  try {
    const r = await fetch("./firmware/manifest.json", { cache: "no-cache" });
    return r.ok ? ((await r.json()) as FirmwareManifest) : null;
  } catch {
    return null;
  }
}
export async function downloadImage(file: string, progress: Progress): Promise<Uint8Array> {
  progress(1, "A descarregar o firmware…");
  const r = await fetch(`./firmware/${file}`);
  if (!r.ok) throw new Error(`Não foi possível descarregar ${file} (${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}
