import "./shims/process";
import "./style.css";
import QRCode from "qrcode";
import {
  BOARD_NAMES, configureRadio, downloadImage, flashFactory, keyBytes, loadManifest, newKey, pickPort, PortLostError, type Board,
  type FirmwareManifest, type RadioPlan, type Role,
} from "./radio-setup";

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const store = {
  get(k: string) { try { return localStorage.getItem(`raidtrack.${k}`); } catch { return null; } },
  set(k: string, v: string) { try { localStorage.setItem(`raidtrack.${k}`, v); } catch { /* sem armazenamento */ } },
};
function toast(text: string, kind: "" | "warn" | "ok" = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = text;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), 5000);
}

// ───────────── Chave ─────────────
const keyIn = $<HTMLInputElement>("#key");
function checkKey() {
  const ok = !!keyBytes(keyIn.value);
  $("#keyMsg").textContent = keyIn.value.trim() === "" ? "Sem chave: gere uma nova ou cole a do raid." : ok ? "Chave válida (AES-256). Guardada neste computador." : "Chave inválida — deve ter 44 caracteres e terminar em =.";
  $("#keyMsg").className = `hint ${ok ? "ok" : keyIn.value.trim() ? "bad" : ""}`;
  if (ok) store.set("chave", keyIn.value.trim());
  if (!$("#keyQr").hidden) void drawQr();
  // A lista de rádios preparados é por chave: outra chave = outro raid
  if (ok && keyId() !== shownKey) { shownKey = keyId(); renderDone(); suggestNext(); }
  return ok;
}
async function drawQr() {
  if (!keyBytes(keyIn.value)) { $("#keyQr").hidden = true; return; }
  // Sempre escuro sobre branco: muitas câmaras não leem códigos QR invertidos
  await QRCode.toCanvas($<HTMLCanvasElement>("#qr"), keyIn.value.trim(), { width: 200, margin: 2, color: { dark: "#111111", light: "#ffffff" } });
}
keyIn.value = store.get("chave") ?? "";
keyIn.oninput = checkKey;
$("#keyNew").onclick = () => {
  if (keyIn.value && !confirmInline("#keyNew", "Substituir a chave? Os rádios já preparados ficam com a chave antiga e deixam de comunicar com os novos — têm de ser configurados outra vez.")) return;
  keyIn.value = newKey(); checkKey(); toast("Chave nova gerada", "ok");
};
$("#keyCopy").onclick = async () => {
  if (!checkKey()) return toast("Não há chave válida para copiar", "warn");
  try { await navigator.clipboard.writeText(keyIn.value.trim()); toast("Chave copiada", "ok"); }
  catch { keyIn.select(); toast("Selecionei a chave: use Ctrl+C / Cmd+C"); }
};
$("#keyQrBtn").onclick = async () => {
  if (!checkKey()) return toast("Gere ou cole uma chave primeiro", "warn");
  const box = $("#keyQr"); box.hidden = !box.hidden;
  $("#keyQrBtn").textContent = box.hidden ? "Mostrar QR" : "Esconder QR";
  if (!box.hidden) await drawQr();
};

/** Confirmação no próprio botão: o primeiro clique pede confirmação, o segundo (em 4 s) executa */
const armed = new Map<string, number>();
function confirmInline(sel: string, msg: string): boolean {
  const now = Date.now();
  if ((armed.get(sel) ?? 0) > now) { armed.delete(sel); return true; }
  armed.set(sel, now + 4000);
  toast(`${msg} Carregue outra vez para confirmar.`, "warn");
  return false;
}

const interval = $<HTMLSelectElement>("#interval");
interval.value = store.get("intervalo") ?? "60";
interval.onchange = () => store.set("intervalo", interval.value);

// ───────────── Rádio ─────────────
const role = (): Role => (document.querySelector<HTMLInputElement>('input[name="role"]:checked')!.value as Role);
const codeIn = $<HTMLInputElement>("#code"), nameIn = $<HTMLInputElement>("#name");
function syncRole() {
  $("#teamFields").hidden = role() === "base";
  renderFw();
}
document.querySelectorAll<HTMLInputElement>('input[name="role"]').forEach((r) => (r.onchange = syncRole));
codeIn.oninput = () => (codeIn.value = codeIn.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));

/** Impressão digital curta da chave (nunca se guarda a chave na lista) */
function keyId(): string {
  let h = 0x811c9dc5;
  for (const c of keyIn.value.trim()) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
let shownKey = "";

interface Done { code: string; role: Role; node: string; t: number; k?: string }
let done: Done[] = [];
try { done = JSON.parse(store.get("preparados") ?? "[]"); } catch { done = []; }
const mine = () => done.filter((d) => d.k === keyId());
function renderDone() {
  const list = mine();
  const others = done.length - list.length;
  const fmt = (t: number) => new Date(t).toLocaleString("pt-PT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  $("#done").innerHTML = list.length
    ? list.slice().reverse().map((d) => `<tr><td><b>${d.code}</b></td><td>${d.role === "base" ? "Base" : "Equipa"}</td><td class="mono">${d.node}</td><td>${fmt(d.t)}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">Ainda nenhum rádio preparado com esta chave.</td></tr>`;
  $("#doneOther").textContent = others
    ? `${others} rádio${others > 1 ? "s" : ""} preparado${others > 1 ? "s" : ""} com outra chave não aparece${others > 1 ? "m" : ""} aqui: ${others > 1 ? "têm de ser configurados" : "tem de ser configurado"} outra vez (“Só configurar”) para ${others > 1 ? "comunicarem" : "comunicar"} neste raid.`
    : "";
}
function suggestNext() {
  const nums = mine().filter((d) => d.role === "equipa").map((d) => Number(d.code.replace(/\D/g, "")) || 0);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  codeIn.value = `EQ${n}`;
  nameIn.value = `Equipa ${n}`;
}

// ───────────── Firmware ─────────────
let manifest: FirmwareManifest | null = null;
const fwFile = $<HTMLInputElement>("#fwFile");
function renderFw() {
  const f = fwFile.files?.[0];
  const el = $("#fwInfo");
  if (f) el.innerHTML = `Firmware: <b>${f.name}</b> (ficheiro escolhido). O instalador confirma se serve para a placa antes de gravar.`;
  else if (manifest) el.innerHTML = `Firmware RaidTrack <b>${manifest.version}</b> de ${new Date(manifest.built).toLocaleDateString("pt-PT")}. A placa é detetada ao ligar (${role() === "base" ? "T3-S3" : "T-Beam ou T-Beam Supreme"}) e o firmware certo é descarregado sozinho.`;
  else el.innerHTML = `Não há firmware publicado neste endereço. Escolha um ficheiro <b>…factory.bin</b> ou use “Só configurar”.`;
  el.className = `hint ${!f && !manifest ? "bad" : ""}`;
}
fwFile.onchange = renderFw;

// ───────────── Execução ─────────────
const bar = $("#barFill"), label = $("#runLabel"), logEl = $("#log");
const log = (m: string) => { logEl.textContent += m.endsWith("\n") ? m : m + "\n"; logEl.scrollTop = logEl.scrollHeight; };
const progress = (pct: number, text: string) => { bar.style.width = `${pct}%`; label.textContent = text; };
let busy = false;
let lastPort: SerialPort | null = null;
let pendingPlan: RadioPlan | null = null;

function plan(): RadioPlan | null {
  if (!checkKey()) { toast("Defina primeiro a chave do raid (passo 1)", "warn"); keyIn.focus(); return null; }
  if (role() === "base") return { role: "base", code: "BASE", name: "RaidTrack Base", pskB64: keyIn.value.trim(), positionSecs: Number(interval.value) };
  const code = codeIn.value.trim();
  if (!code) { toast("Escreva o código da equipa (ex. EQ1)", "warn"); codeIn.focus(); return null; }
  return { role: "equipa", code, name: nameIn.value.trim() || code, pskB64: keyIn.value.trim(), positionSecs: Number(interval.value) };
}

function setBusy(b: boolean) {
  busy = b;
  ($("#go") as HTMLButtonElement).disabled = b;
  ($("#cfgOnly") as HTMLButtonElement).disabled = b;
  document.body.classList.toggle("busy", b);
}

async function getImage(b: Board): Promise<Uint8Array> {
  const f = fwFile.files?.[0];
  if (f) return new Uint8Array(await f.arrayBuffer());
  if (!manifest) throw new Error("Falta o ficheiro de firmware: escolha-o no passo 2.");
  // manifestos antigos usavam "equipa"/"base"
  const legacy = manifest.files as Record<string, string | undefined>;
  const file = manifest.files[b] ?? (b === "tbeam" ? legacy.equipa : b === "t3s3" ? legacy.base : undefined);
  if (!file) throw new Error(`Ainda não há firmware publicado para ${BOARD_NAMES[b]}. Aguarde a próxima publicação. Nada foi gravado.`);
  return downloadImage(file, progress);
}

let flashedBoard: Board | undefined;
async function configure(port: SerialPort, p: RadioPlan) {
  const { nodeNum } = await configureRadio(port, p, log, progress, flashedBoard);
  done = done.filter((d) => !(d.k === keyId() && d.code === p.code)); // reconfigurar não duplica
  done.push({ code: p.code, role: p.role, node: nodeNum.toString(16), t: Date.now(), k: keyId() });
  store.set("preparados", JSON.stringify(done));
  renderDone();
  label.innerHTML = `<b>${p.code} pronto.</b> Pode desligar o cabo e ligar o próximo rádio.`;
  toast(`${p.code} preparado`, "ok");
  if (p.role === "equipa") suggestNext();
}

async function run(withFlash: boolean) {
  if (busy) return;
  const p = plan();
  if (!p) return;
  if (withFlash) {
    if (!fwFile.files?.[0] && !manifest) return toast("Falta o firmware: escolha o ficheiro no passo 2 ou use “Só configurar”", "warn");
  }
  let port: SerialPort;
  try { port = await pickPort(); } catch (e) { if (!/No port selected|cancel/i.test(String(e))) toast((e as Error).message, "warn"); return; }
  lastPort = port; pendingPlan = p;
  $("#run").hidden = false; $("#again").hidden = true; logEl.textContent = ""; flashedBoard = undefined;
  setBusy(true);
  try {
    if (withFlash) {
      flashedBoard = await flashFactory(port, p.role, getImage, $<HTMLInputElement>("#erase").checked, log, progress);
      progress(100, "Firmware gravado. A aguardar o primeiro arranque (até 30 s)…");
      await new Promise((r) => setTimeout(r, 6000)); // primeiro arranque: formata a memória interna
    }
    try {
      await configure(port, p);
    } catch (e) {
      log(`Configuração interrompida: ${(e as Error).message}`);
      if (e instanceof PortLostError) {
        progress(100, withFlash ? "Firmware gravado. Para configurar, escolha o rádio outra vez." : "Escolha o rádio outra vez para continuar.");
        $("#again").hidden = false;
        return;
      }
      throw e;
    }
  } catch (e) {
    progress(0, "");
    const msg = (e as Error).message;
    label.innerHTML = /Failed to connect/i.test(msg)
      ? `<span class="bad">O rádio não entrou em modo de gravação.</span> Ponha-o em modo de gravação à mão: mantenha premido <b>BOOT</b>, carregue e largue <b>RST</b>, largue <b>BOOT</b>. Depois carregue de novo em <b>Gravar e configurar</b> e escolha a porta outra vez. No fim da gravação carregue em <b>RST</b> uma vez.`
      : `<span class="bad">Não foi possível concluir:</span> ${msg}`;
    log(String((e as Error).stack ?? e));
  } finally {
    setBusy(false);
  }
}

$("#go").onclick = () => run(true);
$("#cfgOnly").onclick = () => run(false);
$("#again").onclick = async () => {
  if (!pendingPlan) return;
  let port: SerialPort;
  try { port = await pickPort(); } catch { return; }
  lastPort = port;
  $("#again").hidden = true;
  setBusy(true);
  try { await configure(port, pendingPlan); }
  catch (e) { label.innerHTML = `<span class="bad">Não foi possível configurar:</span> ${(e as Error).message}`; $("#again").hidden = false; }
  finally { setBusy(false); }
};
void lastPort;

// ───────────── Arranque ─────────────
if (!("serial" in navigator)) { $("#noSerial").hidden = false; ($("#go") as HTMLButtonElement).disabled = true; ($("#cfgOnly") as HTMLButtonElement).disabled = true; }
checkKey();
renderDone();
suggestNext();
syncRole();
loadManifest().then((m) => { manifest = m; renderFw(); });
