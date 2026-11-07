// Protocolo RaidTrack sobre PRIVATE_APP (256) — espelho de firmware/RaidTrack e docs/PROTOCOLO.md
export const PORT_PRIVATE = 256;
const MAGIC = 0x52;
const VERSION = 0x01;

export const enum MsgType {
  Sos = 0x01,
  SosAck = 0x02,
  SosCancel = 0x03,
  Ping = 0x04,
  Zone = 0x05,
  Text = 0x06,
  Read = 0x07,
}

export type RaidMsg =
  | { type: "sos"; seq: number; lat: number | null; lon: number | null; battery: number; repeat: boolean }
  | { type: "sosAck"; node: number; seq: number }
  | { type: "sosCancel"; seq: number }
  | { type: "ping" }
  | { type: "zone" | "text"; id: number; text: string }
  | { type: "read"; id: number };

export function decode(b: Uint8Array): RaidMsg | null {
  if (b.length < 3 || b[0] !== MAGIC || b[1] !== VERSION) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  switch (b[2]) {
    case MsgType.Sos: {
      if (b.length < 15) return null;
      const hasFix = (b[14] & 0x01) !== 0;
      return {
        type: "sos",
        seq: v.getUint16(3, true),
        lat: hasFix ? v.getInt32(5, true) / 1e7 : null,
        lon: hasFix ? v.getInt32(9, true) / 1e7 : null,
        battery: b[13],
        repeat: (b[14] & 0x02) !== 0,
      };
    }
    case MsgType.SosAck:
      if (b.length < 9) return null;
      return { type: "sosAck", node: v.getUint32(3, true), seq: v.getUint16(7, true) };
    case MsgType.SosCancel:
      if (b.length < 5) return null;
      return { type: "sosCancel", seq: v.getUint16(3, true) };
    case MsgType.Ping:
      return { type: "ping" };
    case MsgType.Zone:
    case MsgType.Text:
      if (b.length < 6) return null;
      return { type: b[2] === MsgType.Zone ? "zone" : "text", id: v.getUint16(3, true), text: new TextDecoder().decode(b.subarray(5)) };
    case MsgType.Read:
      if (b.length < 5) return null;
      return { type: "read", id: v.getUint16(3, true) };
  }
  return null;
}

export function encodeSosAck(node: number, seq: number): Uint8Array {
  const b = new Uint8Array(9);
  const v = new DataView(b.buffer);
  b.set([MAGIC, VERSION, MsgType.SosAck]);
  v.setUint32(3, node >>> 0, true);
  v.setUint16(7, seq, true);
  return b;
}

export function encodePing(): Uint8Array {
  return new Uint8Array([MAGIC, VERSION, MsgType.Ping]);
}

/** Usado só pelo simulador */
export function encodeSos(seq: number, lat: number | null, lon: number | null, battery: number, repeat: boolean): Uint8Array {
  const b = new Uint8Array(15);
  const v = new DataView(b.buffer);
  b.set([MAGIC, VERSION, MsgType.Sos]);
  v.setUint16(3, seq, true);
  v.setInt32(5, Math.round((lat ?? 0) * 1e7), true);
  v.setInt32(9, Math.round((lon ?? 0) * 1e7), true);
  b[13] = battery;
  b[14] = (lat !== null ? 1 : 0) | (repeat ? 2 : 0);
  return b;
}

/** Mensagem que fica no ecrã do tracker até a equipa carregar OK (texto já sem acentos, ≤ 160) */
export function encodeText(id: number, text: string): Uint8Array {
  return encodeNotice(MsgType.Text, id, text);
}
/** Alerta de zona proibida (som repetido no tracker até OK) */
export function encodeZone(id: number, text: string): Uint8Array {
  return encodeNotice(MsgType.Zone, id, text);
}
function encodeNotice(type: MsgType, id: number, text: string): Uint8Array {
  const t = new TextEncoder().encode(text).slice(0, 160);
  const b = new Uint8Array(5 + t.length);
  b.set([MAGIC, VERSION, type]);
  new DataView(b.buffer).setUint16(3, id & 0xffff, true);
  b.set(t, 5);
  return b;
}
/** Usado só pelo simulador: a equipa carregou OK */
export function encodeRead(id: number): Uint8Array {
  const b = new Uint8Array(5);
  b.set([MAGIC, VERSION, MsgType.Read]);
  new DataView(b.buffer).setUint16(3, id, true);
  return b;
}
