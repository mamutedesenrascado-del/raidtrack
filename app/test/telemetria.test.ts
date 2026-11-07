// Confirma que a configuração de telemetria leva o campo 14 (device_telemetry_enabled = true)
import { create, toBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/core";
import { buildSettings, keyBytes, newKey } from "../src/radio-setup";
const s = buildSettings({ role: "equipa", code: "EQ1", name: "x", pskB64: "", positionSecs: 60 }, keyBytes(newKey())!, "supreme");
const tel = s.find(([l]) => l === "Telemetria")![1] as { msg: Protobuf.ModuleConfig.ModuleConfig };
const bin = toBinary(Protobuf.ModuleConfig.ModuleConfigSchema, tel.msg);
const hex = Buffer.from(bin).toString("hex");
console.log(hex, hex.includes("7001") ? "OK: campo 14 = 1 presente" : "FALTA campo 14");
