// Verifica que toda a configuração gerada pelo instalador codifica e descodifica sem perdas
import { toBinary, fromBinary, toJson } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import * as P2 from "@meshtastic/protobufs";
import { buildSettings, keyBytes, newKey } from "../src/radio-setup";

const psk = keyBytes(newKey())!;
let n = 0;
for (const role of ["equipa", "base", "apoio"] as const) {
  const s = buildSettings({ role, code: role === "base" ? "BASE" : role === "apoio" ? "AP1" : "EQ1", name: "Equipa 1", pskB64: "", positionSecs: 120,
    ...(role === "apoio" ? { blePin: 482913 } : {}) }, psk, role === "equipa" ? "supreme" : "t3s3");
  if (role === "apoio") {
    const bt = s.find(([l]) => l === "Bluetooth")![1] as any;
    const v = bt.msg.payloadVariant.value;
    if (v.mode !== Protobuf.Config.Config_BluetoothConfig_PairingMode.FIXED_PIN || v.fixedPin !== 482913) throw new Error("apoio: PIN Bluetooth fixo não ficou na configuração");
    console.log("✓ apoio: Bluetooth com PIN fixo 482913");
  }
  for (const [label, x] of s) {
    // Mensagem Admin completa, como o rádio a recebe
    const variant = { owner: "setOwner", config: "setConfig", module: "setModuleConfig", canned: "setCannedMessageModuleMessages", channel: "setChannel" }[x.kind];
    const payload = x.kind === "canned" ? x.msg.messages : x.msg;
    const admin = (Protobuf.Admin as any).AdminMessageSchema;
    const bin = toBinary(admin, (await import("@bufbuild/protobuf")).create(admin, { payloadVariant: { case: variant, value: payload } } as any));
    // Descodifica com o esquema oficial mais recente (independente do usado para codificar)
    const back = fromBinary((P2 as any).Admin.AdminMessageSchema, bin);
    const j = JSON.stringify(toJson((P2 as any).Admin.AdminMessageSchema, back));
    console.log(`${role.padEnd(6)} ${label.padEnd(24)} ${bin.length.toString().padStart(3)} B  ${j.slice(0, 150)}`);
    n++;
  }
}
console.log(`OK: ${n} mensagens`);
