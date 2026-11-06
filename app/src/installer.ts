import "./shims/process";
import "./style.css";
import QRCode from "qrcode";
import {
  configureRadio, downloadImage, flashFactory, keyBytes, loadManifest, newKey, pickPort,
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
  if (keyIn.value && !confirmInline("#keyNew", "Substituir a chave? Rádios já preparados deixam de comunicar com os novos.")) return;
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

interface Done { code: string; role: Role; node: string; t: number }
let done: Done[] = [];
try { done = JSON.parse(store.get("preparados") ?? "[]"); } catch { done = []; }
function renderDone() {
  $("#done").innerHTML = done.length
    ? done.slice().reverse().map((d) => `<tr><td><b>${d.code}</b></td><td>${d.role === "base" ? "Base" : "Equipa"}</td><td class="mono">${d.node}</td><td>${new Date(d.t).toLocaleTimeString("pt-PT", { hour: "2-digit", minute: "2-digit" })}</td></tr>`).join("")
    : `<tr><td colspan="4" class="empty">Ainda nenhum rádio preparado neste computador.</td></tr>`;
}
function suggestNext() {
  const nums = done.filter((d) => d.role === "equipa").map((d) => Number(d.code.replace(/\D/g, "")) || 0);
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
  if (f) el.innerHTML = `Firmware: <b>${f.name}</b> (ficheiro escolhido). Confirme que é o de <b>${role() === "base" ? "base" : "equipa"}</b>.`;
  else if (manifest) el.innerHTML = `Firmware RaidTrack <b>${manifest.version}</b> de ${new Date(manifest.built).toLocaleDateString("pt-PT")}, versão <b>${role()}</b> — descarregado automaticamente.`;
  else el.innerHTML = `Não há firmware publicado neste endereço. Escolha o ficheiro <b>${role() === "base" ? "raidtrack-base" : "raidtrack-equipa"}…factory.bin</b> ou use “Só configurar”.`;
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

async function getImage(r: Role): Promise<Uint8Array> {
  const f = fwFile.files?.[0];
  if (f) return new Uint8Array(await f.arrayBuffer());
  if (!manifest) throw new Error("Falta o ficheiro de firmware: escolha-o no passo 2.");
  return downloadImage(manifest.files[r], progress);
}

async function configure(port: SerialPort, p: RadioPlan) {
  const { nodeNum } = await configureRadio(port, p, log, progress);
  done.push({ code: p.code, role: p.role, node: nodeNum.toString(16), t: Date.now() });
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
  let image: Uint8Array | null = null;
  if (withFlash) {
    if (!fwFile.files?.[0] && !manifest) return toast("Falta o firmware: escolha o ficheiro no passo 2 ou use “Só configurar”", "warn");
  }
  let port: SerialPort;
  try { port = await pickPort(); } catch (e) { if (!/No port selected|cancel/i.test(String(e))) toast((e as Error).message, "warn"); return; }
  lastPort = port; pendingPlan = p;
  $("#run").hidden = false; $("#again").hidden = true; logEl.textContent = "";
  setBusy(true);
  try {
    if (withFlash) {
      image = await getImage(p.role);
      log(`Imagem: ${(image.length / 1024).toFixed(0)} KB`);
      await flashFactory(port, image, $<HTMLInputElement>("#erase").checked, log, progress);
      progress(100, "Firmware gravado. A aguardar o arranque do rádio…");
      await new Promise((r) => setTimeout(r, 8000)); // primeiro arranque: formata a memória interna
    }
    try {
      await configure(port, p);
    } catch (e) {
      // No T3-S3 a porta USB muda depois de reiniciar: o browser precisa que a escolha outra vez
      log(`Primeira tentativa de configuração falhou: ${(e as Error).message}`);
      if (withFlash) {
        progress(100, "Firmware gravado. Para configurar, escolha o rádio outra vez.");
        $("#again").hidden = false;
        return;
      }
      throw e;
    }
  } catch (e) {
    progress(0, "");
    label.innerHTML = `<span class="bad">Não foi possível concluir:</span> ${(e as Error).message}`;
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
