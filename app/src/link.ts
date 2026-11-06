// Ligação ao rádio da base. Duas implementações: rádio real (Meshtastic) e simulador.
import { MeshDevice, Protobuf, Types } from "@meshtastic/core";
import { PORT_PRIVATE } from "./protocol";
import { isNative, TransportCapacitorBle } from "./transport-capacitor-ble";

export type Dest = number | "all";
export type LinkStatus = "desligado" | "a ligar" | "ligado";

export interface LinkEvents {
  status(s: LinkStatus, detail?: string): void;
  myNode(num: number): void;
  node(num: number, short: string, long: string): void;
  position(num: number, lat: number, lon: number, when: number): void;
  battery(num: number, pct: number): void;
  radio(num: number, snr: number, rssi: number, hops: number | null): void;
  text(from: number, to: number, text: string, when: number): void;
  priv(from: number, data: Uint8Array, when: number): void;
}

export interface Link {
  readonly kind: string;
  /** Resolve quando a mensagem é confirmada (DM) ou enviada (broadcast); rejeita em erro. */
  sendText(text: string, dest: Dest): Promise<void>;
  sendPrivate(data: Uint8Array, dest: Dest): Promise<void>;
  disconnect(): Promise<void>;
}

const BROADCAST = 0xffffffff;

export async function connectRadio(how: "usb" | "ble", ev: LinkEvents): Promise<Link> {
  ev.status("a ligar");
  let transport: Types.Transport;
  if (how === "usb") {
    if (!("serial" in navigator)) throw new Error("Este browser não suporta USB (Web Serial). Use Chrome ou Edge.");
    const { TransportWebSerial } = await import("@meshtastic/transport-web-serial");
    transport = await TransportWebSerial.create(115200);
  } else if (isNative()) {
    transport = await TransportCapacitorBle.create(); // app Android/iOS
  } else {
    if (!("bluetooth" in navigator))
      throw new Error("Este browser não suporta Bluetooth (Web Bluetooth). Use Chrome/Edge; no iPhone use a app RaidTrack ou o browser Bluefy.");
    const { TransportWebBluetooth } = await import("@meshtastic/transport-web-bluetooth");
    transport = await TransportWebBluetooth.create();
  }

  const dev = new MeshDevice(transport);
  const e = dev.events;

  e.onDeviceStatus.subscribe((s) => {
    if (s === Types.DeviceStatusEnum.DeviceConfigured) ev.status("ligado");
    else if (s === Types.DeviceStatusEnum.DeviceDisconnected) ev.status("desligado");
    else if (s === Types.DeviceStatusEnum.DeviceReconnecting) ev.status("a ligar", "a religar…");
  });
  e.onMyNodeInfo.subscribe((m) => ev.myNode(m.myNodeNum));

  // Base de dados de nós enviada pelo rádio ao ligar (inclui última posição conhecida)
  e.onNodeInfoPacket.subscribe((n) => {
    if (n.user) ev.node(n.num, n.user.shortName, n.user.longName);
    const p = n.position;
    if (p && (p.latitudeI || p.longitudeI)) ev.position(n.num, p.latitudeI! / 1e7, p.longitudeI! / 1e7, (p.time || n.lastHeard) * 1000);
    if (n.deviceMetrics?.batteryLevel) ev.battery(n.num, n.deviceMetrics.batteryLevel);
  });
  e.onUserPacket.subscribe((m) => ev.node(m.from, m.data.shortName, m.data.longName));
  e.onPositionPacket.subscribe((m) => {
    const p = m.data;
    if (p.latitudeI || p.longitudeI) ev.position(m.from, p.latitudeI! / 1e7, p.longitudeI! / 1e7, m.rxTime.getTime());
  });
  e.onTelemetryPacket.subscribe((m) => {
    const v = m.data.variant;
    if (v.case === "deviceMetrics" && v.value.batteryLevel !== undefined) ev.battery(m.from, v.value.batteryLevel);
  });
  e.onMeshPacket.subscribe((p) => {
    if (p.rxSnr || p.rxRssi) ev.radio(p.from, p.rxSnr, p.rxRssi, p.hopStart ? p.hopStart - p.hopLimit : null);
  });
  e.onMessagePacket.subscribe((m) => ev.text(m.from, m.to, m.data, m.rxTime.getTime()));
  e.onPrivatePacket.subscribe((m) => ev.priv(m.from, m.data, m.rxTime.getTime()));

  await dev.configure();
  if (how === "usb") dev.setHeartbeatInterval(60_000); // a ligação série cai ao fim de 15 min sem heartbeat

  const to = (d: Dest) => (d === "all" ? BROADCAST : d);
  return {
    kind: how === "usb" ? "USB" : "Bluetooth",
    async sendText(text, dest) {
      await dev.sendText(text, to(dest), dest !== "all", 0);
    },
    async sendPrivate(data, dest) {
      await dev.sendPacket(data, PORT_PRIVATE as Protobuf.Portnums.PortNum, to(dest), 0, dest !== "all");
    },
    async disconnect() {
      await dev.disconnect();
      ev.status("desligado");
    },
  };
}
