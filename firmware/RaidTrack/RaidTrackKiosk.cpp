// RaidTrack — modo quiosque do tracker de equipa (ver RaidTrackKiosk.h).
//
// Ecrãs: estado (início) · menu · enviar mensagem rápida · confirmar · mensagens recebidas.
// Por cima de tudo: SOS ativo e avisos da base / zonas proibidas (ficam até OK).
// Desenha num "canvas" de 64x128 (vertical) ou 128x64 (horizontal) e copia para o OLED, rodando.
//
// Botões (todos os tipos dão as mesmas ações):
//   cima / esquerda                  → anterior
//   baixo / direita / botão do T-Beam → seguinte
//   OK / pressão longa no botão      → escolher
//   voltar / cancelar                → voltar
#include "RaidTrack.h"

#if defined(RAIDTRACK_KIOSK) && defined(RAIDTRACK_ROLE_TEAM) && HAS_SCREEN

#include "FSCommon.h"
#include <Arduino.h>
#include "GPSStatus.h"
#include "MeshService.h"
#include "NodeDB.h"
#include "PowerFSM.h"
#include "PowerStatus.h"
#include "SPILock.h"
#include "gps/RTC.h"
#include "graphics/Screen.h"
#include "input/InputBroker.h"
#include "main.h"
#include <OLEDDisplay.h>
#include <OLEDDisplayFonts.h>
#include <cstring>
#if !MESHTASTIC_EXCLUDE_CANNEDMESSAGES
#include "modules/CannedMessageModule.h"
#endif

using namespace raidtrack;

namespace
{
const char *PREFS = "/prefs/raidtrack.dat";
constexpr uint32_t PREFS_MAGIC = 0x4B545452; // "RTTK"
constexpr uint32_t BOOT_MS = 6000;          // deixar o ecrã de arranque do Meshtastic
constexpr uint32_t IDLE_HOME_MS = 30000;    // volta ao início sem botões
constexpr uint8_t LINE_H = 11;              // ArialMT_Plain_10
constexpr uint8_t MAX_LINES = 24;
constexpr uint8_t LINE_LEN = 40;

/** Canvas em memória com a mesma API de desenho do OLED (fonte, texto, retângulos) */
class Canvas : public OLEDDisplay
{
  public:
    Canvas(uint16_t w, uint16_t h) { setGeometry(GEOMETRY_RAWMODE, w, h); }
    void display() override {}

  protected:
    int getBufferOffset() override { return 0; }
    bool connect() override { return true; }
};

/** Parte o texto em linhas que caibam em `maxW` píxeis, sem cortar palavras quando possível */
uint8_t wrapPx(OLEDDisplay *c, const char *text, uint16_t maxW, char out[][LINE_LEN], uint8_t maxLines)
{
    uint8_t n = 0;
    size_t len = strlen(text), i = 0;
    while (i < len && n < maxLines) {
        while (i < len && text[i] == ' ')
            i++;
        if (i >= len)
            break;
        size_t end = i, lastSpace = 0;
        while (end < len && end - i < LINE_LEN - 1) {
            if (text[end] == '\n')
                break;
            if (c->getStringWidth(text + i, end - i + 1) > maxW)
                break;
            if (text[end] == ' ')
                lastSpace = end;
            end++;
        }
        if (end < len && text[end] != '\n' && text[end] != ' ' && lastSpace > i)
            end = lastSpace;
        if (end == i)
            end = i + 1; // palavra maior que a linha: corta
        memcpy(out[n], text + i, end - i);
        out[n][end - i] = '\0';
        n++;
        i = end;
        if (i < len && text[i] == '\n')
            i++;
    }
    return n;
}

void header(OLEDDisplay *c, const char *left, const char *right)
{
    c->setColor(WHITE);
    c->fillRect(0, 0, c->width(), 12);
    c->setColor(BLACK);
    c->setFont(ArialMT_Plain_10);
    c->setTextAlignment(TEXT_ALIGN_LEFT);
    c->drawString(2, 0, left);
    if (right && *right) {
        c->setTextAlignment(TEXT_ALIGN_RIGHT);
        c->drawString(c->width() - 2, 0, right);
    }
    c->setColor(WHITE);
    c->setTextAlignment(TEXT_ALIGN_LEFT);
}

void footer(OLEDDisplay *c, const char *text)
{
    int y = c->height() - LINE_H;
    c->drawHorizontalLine(0, y - 1, c->width());
    c->setTextAlignment(TEXT_ALIGN_CENTER);
    c->drawString(c->width() / 2, y - 1, text);
    c->setTextAlignment(TEXT_ALIGN_LEFT);
}

/** Lista com cursor; devolve o primeiro item visível */
void list(OLEDDisplay *c, const char *const *items, int n, int sel, int top, int bottom)
{
    int rows = (bottom - top) / LINE_H;
    if (rows < 1)
        rows = 1;
    int first = sel - rows + 1 > 0 ? sel - rows + 1 : 0;
    for (int r = 0; r < rows && first + r < n; r++) {
        int i = first + r, y = top + r * LINE_H;
        if (i == sel) {
            c->fillRect(0, y + 1, c->width(), LINE_H);
            c->setColor(BLACK);
        }
        char buf[LINE_LEN];
        snprintf(buf, sizeof(buf), "%s", items[i]);
        // cortar o que não cabe
        size_t L = strlen(buf);
        while (L > 1 && c->getStringWidth(buf, L) > c->width() - 4)
            buf[--L] = '\0';
        c->drawString(2, y, buf);
        c->setColor(WHITE);
    }
}

uint8_t batteryPct()
{
    return powerStatus && powerStatus->getHasBattery() ? powerStatus->getBatteryChargePercent() : 0;
}
} // namespace

// ---------------------------------------------------------------------------------------------

void RaidTrackModule::kioskInit()
{
    raidtrackKioskDraw = [](OLEDDisplay *d) { return raidTrackModule && raidTrackModule->kioskDraw(d); };
    raidtrackKioskInput = [](const struct _InputEvent *e) { return raidTrackModule && raidTrackModule->kioskInput(e); };
    kioskLoadPrefs();
}

void RaidTrackModule::kioskLoadPrefs()
{
#ifdef FSCom
    spiLock->lock();
    auto f = FSCom.open(PREFS, FILE_O_READ);
    if (f) {
        uint32_t magic = 0;
        uint8_t o = 0;
        if (f.read((uint8_t *)&magic, 4) == 4 && magic == PREFS_MAGIC && f.read(&o, 1) == 1 && o < 4)
            kOrient = o;
        f.close();
    }
    spiLock->unlock();
#endif
}

void RaidTrackModule::kioskSavePrefs()
{
#ifdef FSCom
    spiLock->lock();
    FSCom.mkdir("/prefs");
    if (FSCom.exists(PREFS))
        FSCom.remove(PREFS);
    auto f = FSCom.open(PREFS, FILE_O_WRITE);
    if (f) {
        uint32_t magic = PREFS_MAGIC;
        f.write((uint8_t *)&magic, 4);
        f.write(&kOrient, 1);
        f.flush();
        f.close();
    }
    spiLock->unlock();
#endif
}

void RaidTrackModule::kioskToast(const char *msg, uint32_t ms)
{
    snprintf(kToast, sizeof(kToast), "%s", msg);
    kToastUntil = millis() + ms;
    kioskRedraw();
}

void RaidTrackModule::kioskRedraw()
{
    if (screen)
        screen->runNow();
}

void RaidTrackModule::kioskRemember(const Notice &nt)
{
    // guarda as últimas mensagens lidas (a mais recente primeiro)
    uint8_t n = histCount < HIST_MAX ? histCount : HIST_MAX - 1;
    for (int i = n; i > 0; i--)
        hist[i] = hist[i - 1];
    hist[0].at = millis();
    hist[0].zone = nt.zone;
    snprintf(hist[0].text, sizeof(hist[0].text), "%s", nt.text);
    if (histCount < HIST_MAX)
        histCount++;
}

int RaidTrackModule::kioskCannedCount()
{
    int n = 0;
#if !MESHTASTIC_EXCLUDE_CANNEDMESSAGES
    if (cannedMessageModule)
        while (n < 20 && *cannedMessageModule->getMessageByIndex(n))
            n++;
#endif
    return n;
}

const char *RaidTrackModule::kioskCanned(int i)
{
#if !MESHTASTIC_EXCLUDE_CANNEDMESSAGES
    if (cannedMessageModule)
        return cannedMessageModule->getMessageByIndex(i);
#endif
    (void)i;
    return "";
}

void RaidTrackModule::kioskSendText(const char *text)
{
    // Mensagem de texto normal para o canal (a app da base mostra-a como mensagem da equipa)
    meshtastic_MeshPacket *p = allocDataPacket();
    if (!p)
        return;
    p->decoded.portnum = meshtastic_PortNum_TEXT_MESSAGE_APP;
    p->to = NODENUM_BROADCAST;
    p->channel = 0;
    p->want_ack = false;
    size_t len = strlen(text);
    if (len > sizeof(p->decoded.payload.bytes))
        len = sizeof(p->decoded.payload.bytes);
    memcpy(p->decoded.payload.bytes, text, len);
    p->decoded.payload.size = len;
    service->sendToMesh(p, RX_SRC_LOCAL, true);
    LOG_INFO("RaidTrack: mensagem rápida enviada: %s", text);
}

void RaidTrackModule::kioskTick(uint32_t now)
{
    // sem botões há algum tempo: volta ao início
    if (kScreen != K_HOME && (int32_t)(now - kLastInput - IDLE_HOME_MS) >= 0) {
        kScreen = K_HOME;
        kioskRedraw();
    }
    // atualizar o início (bateria, GPS, rede) de vez em quando — o Screen já desenha a 1 fps
}

// ---------------------------------------------------------------------------------------------
// Botões

bool RaidTrackModule::kioskInput(const struct _InputEvent *ev)
{
    if (!ev)
        return false;
    const InputEvent *e = (const InputEvent *)ev;
    enum Act { A_NONE, A_PREV, A_NEXT, A_OK, A_BACK } a = A_NONE;
    switch (e->inputEvent) {
    case INPUT_BROKER_UP:
    case INPUT_BROKER_LEFT:
    case INPUT_BROKER_UP_LONG:
        a = A_PREV;
        break;
    case INPUT_BROKER_DOWN:
    case INPUT_BROKER_RIGHT:
    case INPUT_BROKER_DOWN_LONG:
    case INPUT_BROKER_USER_PRESS:
        a = A_NEXT;
        break;
    case INPUT_BROKER_SELECT:
    case INPUT_BROKER_SELECT_LONG:
    case INPUT_BROKER_ALT_PRESS:
        a = A_OK;
        break;
    case INPUT_BROKER_BACK:
    case INPUT_BROKER_CANCEL:
    case INPUT_BROKER_ALT_LONG:
        a = A_BACK;
        break;
    default:
        // tudo o resto (desligar, reset, GPS, BT, ping…) fica bloqueado no quiosque
        return true;
    }
    kLastInput = millis();
    kToastUntil = 0;

    // 1) aviso da base / zona proibida: percorrer páginas e confirmar
    if (noticeCount) {
        // número de páginas calculado no último desenho
        if (a == A_PREV && kScroll > 0)
            kScroll--;
        else if (a == A_NEXT || a == A_OK) {
            if (kScroll + 1 < kNoticePages)
                kScroll++;
            else if (a == A_OK) {
                noticeDone();
                kScroll = 0;
            }
        }
        kioskRedraw();
        return true;
    }

    // 2) SOS ativo: nada a escolher (cancelar = manter o botão SOS 5 s)
    if (sosActive && !sosAcked) {
        kioskRedraw();
        return true;
    }

    const int nMenu = 4; // ver K_MENU em kioskRender
    switch (kScreen) {
    case K_HOME:
        if (a == A_OK || a == A_NEXT || a == A_PREV) {
            kScreen = K_MENU;
            kSel = 0;
        }
        break;
    case K_MENU:
        if (a == A_PREV)
            kSel = (kSel + nMenu - 1) % nMenu;
        else if (a == A_NEXT)
            kSel = (kSel + 1) % nMenu;
        else if (a == A_BACK)
            kScreen = K_HOME;
        else if (a == A_OK) {
            if (kSel == 0) {
                kScreen = K_SEND;
                kSel = 0;
            } else if (kSel == 1) {
                kScreen = K_HISTORY;
                kScroll = 0;
            } else if (kSel == 2) {
                kOrient = (kOrient + 1) % 4;
                kioskSavePrefs();
                kioskToast(kOrient < 2 ? "Vertical" : "Horizontal", 2500);
            } else
                kScreen = K_HOME;
        }
        break;
    case K_SEND: {
        int n = kioskCannedCount() + 1; // + "Voltar"
        if (a == A_PREV)
            kSel = (kSel + n - 1) % n;
        else if (a == A_NEXT)
            kSel = (kSel + 1) % n;
        else if (a == A_BACK)
            kScreen = K_MENU, kSel = 0;
        else if (a == A_OK) {
            if (kSel == n - 1)
                kScreen = K_MENU, kSel = 0;
            else
                kPick = kSel, kScreen = K_CONFIRM, kSel = 0;
        }
        break;
    }
    case K_CONFIRM:
        if (a == A_PREV || a == A_NEXT)
            kSel = 1 - kSel;
        else if (a == A_BACK)
            kScreen = K_SEND, kSel = kPick;
        else if (a == A_OK) {
            if (kSel == 0 && kPick >= 0) {
                kioskSendText(kioskCanned(kPick));
                kScreen = K_HOME;
                kioskToast("Mensagem enviada", 3000);
                buzz(1, 80, 0);
            } else
                kScreen = K_SEND, kSel = kPick;
        }
        break;
    case K_HISTORY:
        if (a == A_PREV && kScroll > 0)
            kScroll--;
        else if (a == A_NEXT && kScroll + 1 < (histCount ? histCount : 1))
            kScroll++;
        else if (a == A_OK || a == A_BACK)
            kScreen = K_MENU, kSel = 1;
        break;
    }
    kioskRedraw();
    return true;
}

// ---------------------------------------------------------------------------------------------
// Desenho

bool RaidTrackModule::kioskDraw(OLEDDisplay *d)
{
    if (millis() < BOOT_MS || !d)
        return false;
    bool portrait = kOrient < 2;
    uint16_t W = portrait ? d->height() : d->width(), H = portrait ? d->width() : d->height();
    if (!kCanvas || kCanvas->width() != W || kCanvas->height() != H) {
        delete kCanvas;
        kCanvas = new Canvas(W, H);
        if (!kCanvas->init()) {
            delete kCanvas;
            kCanvas = nullptr;
            return false;
        }
    }
    kioskRender(kCanvas);
    kioskBlit(kCanvas, d);
    return true;
}

void RaidTrackModule::kioskBlit(OLEDDisplay *c, OLEDDisplay *d)
{
    d->clear();
    d->setColor(WHITE);
    const uint16_t cw = c->width(), ch = c->height(), dw = d->width(), dh = d->height();
    for (uint16_t y = 0; y < ch; y++) {
        for (uint16_t x = 0; x < cw; x++) {
            if (!(c->buffer[x + (y / 8) * cw] & (1 << (y & 7))))
                continue;
            switch (kOrient) {
            case 0: // vertical: topo do texto no lado esquerdo do ecrã
                d->setPixel(y, dh - 1 - x);
                break;
            case 1: // vertical, ao contrário
                d->setPixel(dw - 1 - y, x);
                break;
            case 2:
                d->setPixel(x, y);
                break;
            default:
                d->setPixel(dw - 1 - x, dh - 1 - y);
                break;
            }
        }
    }
}

void RaidTrackModule::kioskRender(OLEDDisplay *c)
{
    c->clear();
    c->setColor(WHITE);
    c->setFont(ArialMT_Plain_10);
    c->setTextAlignment(TEXT_ALIGN_LEFT);
    const int W = c->width(), H = c->height();
    const bool portrait = H > W;
    char me[8];
    shortName(nodeDB->getNodeNum(), me, sizeof(me));
    char bat[8];
    if (powerStatus && powerStatus->getIsCharging())
        snprintf(bat, sizeof(bat), "USB");
    else
        snprintf(bat, sizeof(bat), "%u%%", batteryPct());

    // ── aviso da base / zona proibida (até OK)
    if (noticeCount) {
        const Notice &nt = notices[0];
        header(c, nt.zone ? (portrait ? "PROIBIDA" : "ZONA PROIBIDA") : "BASE", "");
        char lines[MAX_LINES][LINE_LEN];
        uint8_t n = wrapPx(c, nt.text, W - 4, lines, MAX_LINES);
        int top = 14, bottom = H - LINE_H - 1;
        int per = (bottom - top) / LINE_H;
        if (per < 1)
            per = 1;
        kNoticePages = n ? (n + per - 1) / per : 1;
        if (kScroll >= kNoticePages)
            kScroll = kNoticePages - 1;
        for (int i = 0; i < per && kScroll * per + i < n; i++)
            c->drawString(2, top + i * LINE_H, lines[kScroll * per + i]);
        char f[24];
        if (kScroll + 1 < kNoticePages)
            snprintf(f, sizeof(f), "%d/%d  Mais >", kScroll + 1, kNoticePages);
        else
            snprintf(f, sizeof(f), kNoticePages > 1 ? "%d/%d  OK" : "OK", kScroll + 1, kNoticePages);
        footer(c, f);
        if (nt.zone && (millis() / 500) % 2) // pisca o contorno
            c->drawRect(0, 0, W, H);
        return;
    }

    // ── SOS ativo (até a base confirmar; avisos da base aparecem por cima)
    if (sosActive && !sosAcked) {
        c->fillRect(0, 0, W, H);
        c->setColor(BLACK);
        c->setTextAlignment(TEXT_ALIGN_CENTER);
        c->setFont(ArialMT_Plain_24);
        c->drawString(W / 2, portrait ? 14 : 2, "SOS");
        c->setFont(ArialMT_Plain_10);
        char lines[MAX_LINES][LINE_LEN];
        uint8_t n = wrapPx(c, "Enviado. A aguardar a base... Cancelar: manter SOS 5 s", W - 4, lines, MAX_LINES);
        int y = portrait ? 46 : 30;
        for (uint8_t i = 0; i < n && y < H - LINE_H + 2; i++, y += LINE_H)
            c->drawString(W / 2, y, lines[i]);
        c->setColor(WHITE);
        return;
    }

    // ── aviso curto (ex.: mensagem enviada, SOS de outra equipa)
    if (kToastUntil && (int32_t)(millis() - kToastUntil) < 0) {
        header(c, me, bat);
        char lines[MAX_LINES][LINE_LEN];
        uint8_t n = wrapPx(c, kToast, W - 4, lines, MAX_LINES);
        int y = (H - n * LINE_H) / 2;
        c->setTextAlignment(TEXT_ALIGN_CENTER);
        for (uint8_t i = 0; i < n; i++, y += LINE_H)
            c->drawString(W / 2, y, lines[i]);
        c->setTextAlignment(TEXT_ALIGN_LEFT);
        return;
    }
    kToastUntil = 0;

    switch (kScreen) {
    case K_MENU: {
        header(c, "Menu", bat);
        static const char *const MENU[] = {"Enviar mensagem", "Mensagens lidas", "Rodar ecra", "Voltar"};
        static const char *const MENU_V[] = {"Enviar msg", "Lidas", "Rodar ecra", "Voltar"}; // vertical: 64 px
        list(c, portrait ? MENU_V : MENU, 4, kSel, 14, H - LINE_H - 1);
        footer(c, "OK = escolher");
        return;
    }
    case K_SEND: {
        header(c, "Enviar", bat);
        int n = kioskCannedCount();
        const char *items[21];
        for (int i = 0; i < n; i++)
            items[i] = kioskCanned(i);
        items[n] = "< Voltar";
        list(c, items, n + 1, kSel, 14, H - LINE_H - 1);
        footer(c, n ? "OK = escolher" : "Sem mensagens");
        return;
    }
    case K_CONFIRM: {
        header(c, "Enviar?", bat);
        char lines[MAX_LINES][LINE_LEN];
        uint8_t n = wrapPx(c, kioskCanned(kPick), W - 4, lines, MAX_LINES);
        int maxL = (H - 14 - 2 * LINE_H - LINE_H) / LINE_H;
        for (uint8_t i = 0; i < n && i < maxL; i++)
            c->drawString(2, 14 + i * LINE_H, lines[i]);
        static const char *const YN[] = {"Sim, enviar", "Nao"};
        list(c, YN, 2, kSel, H - 2 * LINE_H - 2, H);
        return;
    }
    case K_HISTORY: {
        char t[16];
        snprintf(t, sizeof(t), "Lidas %d/%d", histCount ? kScroll + 1 : 0, histCount);
        header(c, t, "");
        if (!histCount) {
            c->drawString(2, 16, "Nenhuma");
        } else {
            const Hist &h = hist[kScroll];
            char head[24];
            uint32_t mins = (millis() - h.at) / 60000;
            snprintf(head, sizeof(head), portrait ? "%s %lum" : "%s ha %lu min", h.zone ? "Zona" : "Base", (unsigned long)mins);
            c->drawString(2, 13, head);
            char lines[MAX_LINES][LINE_LEN];
            uint8_t n = wrapPx(c, h.text, W - 4, lines, MAX_LINES);
            int per = (H - 25 - LINE_H - 1) / LINE_H;
            for (int i = 0; i < n && i < per; i++)
                c->drawString(2, 25 + i * LINE_H, lines[i]);
        }
        footer(c, "OK = voltar");
        return;
    }
    default:
        break;
    }

    // ── início: código da equipa, GPS, rede, SOS
    header(c, portrait ? "" : "RaidTrack", bat);
    c->setTextAlignment(TEXT_ALIGN_CENTER);
    c->setFont(portrait ? ArialMT_Plain_24 : ArialMT_Plain_16);
    c->drawString(W / 2, portrait ? 16 : 11, me);
    c->setFont(ArialMT_Plain_10);
    int y = portrait ? 46 : 29;

    char gps[24];
    bool fix = gpsStatus && gpsStatus->getHasLock();
    if (fix)
        snprintf(gps, sizeof(gps), "GPS ok (%u sat)", (unsigned)gpsStatus->getNumSatellites());
    else
        snprintf(gps, sizeof(gps), "GPS a procurar");

    // rede: há quanto tempo ouvimos outro nó (a base ou outra equipa)
    char net[24] = "Rede: --";
    uint32_t nowS = getTime(), last = 0;
    for (size_t i = 0; i < nodeDB->getNumMeshNodes(); i++) {
        const meshtastic_NodeInfoLite *n = nodeDB->getMeshNodeByIndex(i);
        if (n && n->num != nodeDB->getNodeNum() && n->last_heard > last)
            last = n->last_heard;
    }
    if (last && nowS >= last) {
        uint32_t m = (nowS - last) / 60;
        if (m < 1)
            snprintf(net, sizeof(net), "Rede: agora");
        else
            snprintf(net, sizeof(net), "Rede: ha %lu min", (unsigned long)m);
    }

    if (portrait) {
        c->drawString(W / 2, y, fix ? "GPS ok" : "GPS ...");
        y += LINE_H;
        c->drawString(W / 2, y, net + 6); // sem "Rede: "
        y += LINE_H + 4;
        if (sosActive && sosAcked) {
            c->drawString(W / 2, y, "SOS: base");
            y += LINE_H;
            c->drawString(W / 2, y, "recebeu");
        } else {
            c->drawString(W / 2, y, "SOS: manter");
            y += LINE_H;
            c->drawString(W / 2, y, "botao 2 s");
        }
    } else {
        c->drawString(W / 2, y, gps);
        c->drawString(W / 2, y + LINE_H - 1, sosActive && sosAcked ? "SOS: base recebeu" : net);
    }
    c->setTextAlignment(TEXT_ALIGN_LEFT);
    footer(c, "OK = menu");
}

#endif
