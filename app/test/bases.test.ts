// Várias bases no mesmo raid: reconhecer rádios de base e ler o que outra base enviou (npx tsx test/bases.test.ts)
import { decode, encodeSosAck, encodeText, encodeTo, FROM_BASE, isApoioNode, isBaseNode } from "../src/protocol";
import { boardFits } from "../src/radio-setup";

let fail = 0;
const ok = (name: string, cond: boolean) => { console.log(`${cond ? "✓" : "✗"} ${name}`); if (!cond) fail++; };

ok("BASE é base", isBaseNode("BASE", "RaidTrack Base"));
ok("AP2 é base de apoio", isBaseNode("AP2", "RaidTrack Apoio 2") && isApoioNode("AP2"));
ok("EQ1 não é base", !isBaseNode("EQ1", "Equipa 1 Lobos"));
ok("nome longo basta (código ainda por chegar)", isBaseNode("a1b2", "RaidTrack Apoio 3"));
ok("equipa chamada 'Base Aérea' não é base", !isBaseNode("EQ4", "Base Aerea"));

const ack = decode(encodeTo(0x1234abcd, encodeSosAck(0x1234abcd, 7)));
ok("confirmação de SOS de outra base lê-se do envelope",
  ack?.type === "to" && ack.node === 0x1234abcd && ack.inner?.type === "sosAck" && ack.inner.seq === 7);
const txt = decode(encodeTo(0x55, encodeText(42, "Voltem ao posto 3")));
ok("mensagem de outra base para uma equipa", txt?.type === "to" && txt.inner?.type === "text" && txt.inner.text === "Voltem ao posto 3" && txt.inner.id === 42);
ok("envelope dentro de envelope é recusado", decode(encodeTo(1, encodeTo(2, encodeText(1, "x")))) === null);
ok("confirmações e envelopes só vêm de bases", FROM_BASE.has("sosAck") && FROM_BASE.has("to") && !FROM_BASE.has("sos") && !FROM_BASE.has("read"));

ok("T3-S3 serve para base e apoio", boardFits("t3s3", "base") && boardFits("t3s3", "apoio"));
ok("T-Beam não serve para apoio", !boardFits("tbeam", "apoio") && boardFits("tbeam", "equipa"));

if (fail) { console.log(`FALHOU: ${fail}`); process.exit(1); }
console.log("OK: bases");
