// Rádio Meshtastic falso sobre Web Serial, para testar o instalador sem hardware.
// Imita o que vimos no T3-S3 real: região por definir; ao definir a região pela 1.ª vez o número do nó muda
// e o rádio reinicia (a porta USB desaparece e volta como nova); pacotes para o número antigo ficam sem resposta.
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
const M = Protobuf.Mesh, A = Protobuf.Admin, C = Protobuf.Config;

export const received: string[] = [];
export const state = { precision: -1, hwModel: 12, nodeNum: 0x924113d8, region: 0, reboots: 0, owner: "", channelName: "", committed: false };
let tx = false;
const listeners: Record<string, ((e: { port: unknown }) => void)[]> = { connect: [], disconnect: [] };
let current: FakePort;

function frame(msg: Uint8Array) { const b = new Uint8Array(4 + msg.length); b.set([0x94, 0xc3, msg.length >> 8, msg.length & 255]); b.set(msg, 4); return b; }

class FakePort {
  readable: ReadableStream<Uint8Array> | null = null;
  writable: WritableStream<Uint8Array> | null = null;
  private ctrl?: ReadableStreamDefaultController<Uint8Array>;
  alive = true;
  getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }
  async open() {
    if (!this.alive) throw new Error("NetworkError: device gone");
    if (this.readable) throw new Error("InvalidStateError: already open");
    let buf = new Uint8Array(0);
    this.readable = new ReadableStream({ start: (c) => (this.ctrl = c) });
    this.writable = new WritableStream({ write: (chunk) => {
      const n = new Uint8Array(buf.length + chunk.length); n.set(buf); n.set(chunk, buf.length); buf = n;
      while (buf.length >= 4 && buf[0] === 0x94 && buf[1] === 0xc3) {
        const len = (buf[2] << 8) | buf[3];
        if (buf.length < 4 + len) break;
        const msg = buf.slice(4, 4 + len); buf = buf.slice(4 + len);
        this.handle(fromBinary(M.ToRadioSchema, msg));
      }
    } });
  }
  async close() { try { this.ctrl?.close(); } catch { /* */ } this.readable = null; this.writable = null; }
  private send(fr: Parameters<typeof create<typeof M.FromRadioSchema>>[1]) {
    if (!this.alive) return;
    setTimeout(() => { try { this.ctrl?.enqueue(frame(toBinary(M.FromRadioSchema, create(M.FromRadioSchema, fr)))); } catch { /* closed */ } }, 5);
  }
  private ack(p: Protobuf.Mesh.MeshPacket) {
    const routing = toBinary(M.RoutingSchema, create(M.RoutingSchema, { variant: { case: "errorReason", value: M.Routing_Error.NONE } }));
    this.send({ payloadVariant: { case: "packet", value: create(M.MeshPacketSchema, { from: state.nodeNum, to: state.nodeNum,
      payloadVariant: { case: "decoded", value: { portnum: 5, payload: routing, requestId: p.id } } }) } });
  }
  private reboot() {
    state.reboots++;
    setTimeout(() => {
      this.alive = false; try { this.ctrl?.error(new Error("device lost")); } catch { /* */ }
      listeners.disconnect.forEach((f) => f({ port: this }));
      setTimeout(() => { current = new FakePort(); listeners.connect.forEach((f) => f({ port: current })); }, 3000);
    }, 1500);
  }
  private handle(t: Protobuf.Mesh.ToRadio) {
    const v = t.payloadVariant;
    if (v.case === "wantConfigId") {
      this.send({ payloadVariant: { case: "myInfo", value: create(M.MyNodeInfoSchema, { myNodeNum: state.nodeNum }) } });
      this.send({ payloadVariant: { case: "config", value: create(C.ConfigSchema, { payloadVariant: { case: "lora", value: create(C.Config_LoRaConfigSchema, { region: state.region }) } }) } });
      this.send({ payloadVariant: { case: "nodeInfo", value: create(M.NodeInfoSchema, { num: state.nodeNum, user: create(M.UserSchema, { hwModel: state.hwModel }) }) } });
      this.send({ payloadVariant: { case: "configCompleteId", value: v.value } });
      return;
    }
    if (v.case !== "packet" || v.value.payloadVariant.case !== "decoded") return;
    const p = v.value, d = v.value.payloadVariant.value;
    if (p.to !== state.nodeNum) { received.push(`IGNORADO (para nó antigo ${p.to.toString(16)})`); return; }
    if (d.portnum !== 6) return;
    const a = fromBinary(A.AdminMessageSchema, d.payload).payloadVariant;
    received.push(`${a.case}${a.case === "setConfig" ? ":" + a.value.payloadVariant.case : ""}${a.case === "setModuleConfig" && a.value.payloadVariant.case === "cannedMessage" ? ` pinos ${a.value.payloadVariant.value.inputbrokerPinA}/${a.value.payloadVariant.value.inputbrokerPinB}/${a.value.payloadVariant.value.inputbrokerPinPress}` : ""}${tx ? " [tx]" : ""}`);
    this.ack(p);
    if (a.case === "beginEditSettings") tx = true;
    if (a.case === "setOwner") state.owner = a.value.shortName;
    if (a.case === "setChannel") { state.channelName = a.value.settings?.name ?? ""; state.precision = a.value.settings?.moduleSettings?.positionPrecision ?? 0; }
    if (a.case === "setConfig" && a.value.payloadVariant.case === "lora") {
      const first = state.region === 0 && a.value.payloadVariant.value.region !== 0;
      state.region = a.value.payloadVariant.value.region;
      if (first) state.nodeNum = 0xa1b2c3d4; // identidade nova
      if (!tx) this.reboot();
    }
    if (a.case === "commitEditSettings") { tx = false; state.committed = true; this.reboot(); }
  }
}

current = new FakePort();
export const firstPort = current;
Object.defineProperty(navigator, "serial", { configurable: true, value: {
  getPorts: async () => (current.alive ? [current] : []),
  requestPort: async () => current,
  addEventListener: (ev: string, f: (e: { port: unknown }) => void) => listeners[ev]?.push(f),
  removeEventListener: (ev: string, f: (e: { port: unknown }) => void) => { listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f); },
} });
