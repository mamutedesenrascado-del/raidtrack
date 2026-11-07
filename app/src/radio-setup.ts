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
const CHIP_NAMES: Record<number, string> = { 0: "ESP32", 2: "ESP32-S2", 5: "ESP32-C3", 9: "ESP32-S3", 13: "ESP32-C6", 16: "ESP32-H2" };
/** Lê o identificador de chip do cabeçalho do bootloader dentro da imagem (.factory.bin) */
export function imageChipId(img: Uint8Array): number | null {
  for (const off of [0x0, 0x1000]) {
    if (img.length > off + 24 && img[off] === 0xe9) return img[off + 12] | (img[off + 13] << 8);
  }
  return null;
}

export async function flashFactory(port: SerialPort, image: Uint8Array, eraseAll: boolean, log: Log, progress: Progress) {
  const transport = new Transport(port, false);
  const terminal = { clean() {}, writeLine: (d: string) => log(d), write: (d: string) => log(d) };
  const esp = new ESPLoader({ transport, baudrate: 460800, terminal, debugLogging: false });
  try {
    progress(2, "A ligar ao rádio…");
    const chip = await esp.main();
    log(`Chip detetado: ${chip}`);
    // Recusa gravar um firmware feito para outro chip (ex.: firmware de T-Beam ESP32 numa placa ESP32-S3)
    const want = imageChipId(image), have = (esp.chip as unknown as { IMAGE_CHIP_ID?: number }).IMAGE_CHIP_ID;
    if (want !== null && have !== undefined && want !== have) {
      throw new Error(`Este firmware é para ${CHIP_NAMES[want] ?? want}, mas a placa ligada tem ${CHIP_NAMES[have] ?? chip}. ` +
        `Confirme que escolheu o tipo certo (Equipa = T-Beam ESP32, Base = T3-S3). Nada foi gravado.`);
    }
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

// ── Sessão com o rádio ──
interface Session { port: SerialPort; transport: TransportWebSerial; dev: MeshDevice; nodeNum: number; region: number }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: o rádio não respondeu a tempo.`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
/** A biblioteca rejeita com objetos {id, error}; converte para mensagens legíveis */
function toError(e: unknown, what: string): Error {
  if (e instanceof Error) return e;
  const code = (e as { error?: number })?.error;
  const name = code !== undefined ? Protobuf.Mesh.Routing_Error[code] ?? String(code) : String(e);
  return new Error(`${what}: o rádio não confirmou (${name}).`);
}

async function closeSession(s: Session | null) {
  if (!s) return;
  try { await withTimeout(s.dev.disconnect(), 4000, "Desligar"); } catch { /* segue */ }
  try { await s.transport.disconnect(); } catch { /* já fechado */ }
  try { await s.port.close(); } catch { /* já fechado */ }
}

/** Abre a porta e espera que o rádio envie toda a configuração atual */
async function openSession(port: SerialPort, ms: number): Promise<Session> {
  const transport = await TransportWebSerial.createFromPort(port, 115200);
  const dev = new MeshDevice(transport);
  let nodeNum = 0, region = 0;
  dev.events.onMyNodeInfo.subscribe((m) => (nodeNum = m.myNodeNum));
  dev.events.onConfigPacket.subscribe((c) => { if (c.payloadVariant.case === "lora") region = c.payloadVariant.value.region; });
  const configured = new Promise<void>((resolve) => dev.events.onDeviceStatus.subscribe((st) => { if (st === Types.DeviceStatusEnum.DeviceConfigured) resolve(); }));
  void dev.configure().catch(() => {});
  const s: Session = { port, transport, dev, nodeNum: 0, region: 0 };
  try {
    await withTimeout(configured, ms, "Ligação");
  } catch (e) {
    await closeSession(s);
    throw e;
  }
  s.nodeNum = nodeNum; s.region = region;
  return s;
}

/**
 * Depois de um reinício, a porta USB do ESP32-S3 (T3-S3) desaparece e volta como nova.
 * Procura-a entre as portas já autorizadas neste browser (mesmo fabricante/produto) e liga.
 */
async function reopen(prefer: SerialPort, totalMs: number, log: Log): Promise<Session> {
  const info = prefer.getInfo();
  const deadline = Date.now() + totalMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    const ports = await navigator.serial.getPorts();
    const same = ports.filter((p) => { const i = p.getInfo(); return i.usbVendorId === info.usbVendorId && i.usbProductId === info.usbProductId; });
    const order = [prefer, ...same.filter((p) => p !== prefer)];
    for (const p of order) {
      try { return await openSession(p, 15_000); }
      catch (e) { lastErr = e; try { await p.close(); } catch { /* fechada */ } }
    }
    await sleep(2000);
  }
  log(`Última tentativa: ${(lastErr as Error)?.message ?? lastErr}`);
  throw new PortLostError();
}
export class PortLostError extends Error {
  constructor() { super("Não encontrei o rádio depois de reiniciar. Escolha a porta outra vez."); }
}

export async function configureRadio(port: SerialPort, plan: RadioPlan, log: Log, progress: Progress): Promise<{ nodeNum: number; port: SerialPort }> {
  const psk = keyBytes(plan.pskB64);
  if (!psk) throw new Error("A chave do raid não é válida.");
  const settings = buildSettings(plan, psk);
  const lora = settings.find(([, x]) => x.kind === "config" && x.msg.payloadVariant.case === "lora")![1] as Extract<Setting, { kind: "config" }>;
  const EU868 = Protobuf.Config.Config_LoRaConfig_RegionCode.EU_868;

  progress(5, "A ligar ao rádio…");
  let s: Session | null = await reopen(port, 45_000, log);
  try {
    log(`Rádio ligado (nó ${s.nodeNum.toString(16)}, região ${s.region})`);

    // 1.ª vez: definir a região à parte. O rádio cria aí a sua identidade (o número do nó muda) e reinicia;
    // tudo o resto só se envia depois, numa nova ligação.
    if (s.region !== EU868) {
      progress(15, "A definir a região EU868 — o rádio vai reiniciar…");
      s.dev.events.onPendingSettingsChange.dispatch(true); // envia sem transação, para gravar e reiniciar já
      try { await withTimeout(s.dev.setConfig(lora.msg), 12_000, "Região"); log("✓ Região EU868"); }
      catch { log("Região enviada (o rádio reinicia antes de confirmar — é normal)"); }
      await closeSession(s); s = null;
      progress(25, "A aguardar que o rádio reinicie…");
      await sleep(14_000);
      s = await reopen(port, 60_000, log);
      log(`Rádio ligado de novo (nó ${s.nodeNum.toString(16)}, região ${s.region})`);
      if (s.region !== EU868) throw new Error("A região não ficou gravada. Tente “Só configurar” outra vez.");
    }

    for (let i = 0; i < settings.length; i++) {
      const [label, x] = settings[i];
      progress(30 + Math.round((i / settings.length) * 60), `A configurar: ${label}…`);
      const send = () => {
        switch (x.kind) {
          case "owner": return s!.dev.setOwner(x.msg);
          case "config": return s!.dev.setConfig(x.msg);
          case "module": return s!.dev.setModuleConfig(x.msg);
          case "canned": return s!.dev.setCannedMessages(x.msg);
          case "channel": return s!.dev.setChannel(x.msg);
        }
      };
      try { await withTimeout(send(), 20_000, label); }
      catch (e) { throw toError(e, label); }
      log(`✓ ${label}`);
    }
    progress(92, "A guardar e reiniciar…");
    try { await withTimeout(s.dev.commitEditSettings(), 15_000, "Guardar"); }
    catch (e) { throw toError(e, "Guardar"); }
    log("✓ Configuração guardada; o rádio vai reiniciar");
    await sleep(1500);
    progress(100, "Configurado");
    return { nodeNum: s.nodeNum, port: s.port };
  } finally {
    await closeSession(s);
  }
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
