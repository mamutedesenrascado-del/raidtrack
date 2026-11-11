#pragma once
/*
 * RaidTrack — módulo opcional para o firmware Meshtastic.
 *
 * Instalação: copiar esta pasta para  <meshtastic>/src/modules/optional/RaidTrack/
 * O script bin/optional-modules.py do Meshtastic regista-o automaticamente (chama setupRaidTrack()).
 *
 * Papéis (definidos no ambiente PlatformIO, ver variants/raidtrack/raidtrack.ini):
 *   RAIDTRACK_ROLE_TEAM  — tracker de equipa (T-Beam): botão SOS, besouro, responde a PING
 *   RAIDTRACK_ROLE_BASE  — recetor da base (T3-S3): mostra SOS no ecrã; a app faz o resto
 *
 * Protocolo: docs/PROTOCOLO.md (porta PRIVATE_APP = 256).
 */
#include "SinglePortModule.h"
#include "concurrency/OSThread.h"
#include "configuration.h"
#include "RaidTrackKiosk.h"

namespace raidtrack
{
constexpr uint8_t MAGIC = 0x52;
constexpr uint8_t VERSION = 0x01;

enum MsgType : uint8_t {
    MSG_SOS = 0x01,
    MSG_SOS_ACK = 0x02,
    MSG_SOS_CANCEL = 0x03,
    MSG_PING = 0x04,
    MSG_ZONE = 0x05, // base → equipa: entrou numa zona proibida (fica no ecrã com som até OK)
    MSG_TEXT = 0x06, // base → equipa: mensagem que fica no ecrã até OK
    MSG_READ = 0x07, // equipa → base: a equipa carregou OK (confirmação de leitura)
};

enum SosFlags : uint8_t {
    FLAG_HAS_FIX = 0x01,
    FLAG_REPEAT = 0x02,
};
} // namespace raidtrack

class RaidTrackModule : public SinglePortModule, private concurrency::OSThread
{
  public:
    RaidTrackModule();

#ifdef RAIDTRACK_KIOSK
    // --- modo quiosque (RaidTrackKiosk.cpp) ---
    bool kioskDraw(OLEDDisplay *display);
    bool kioskInput(const struct _InputEvent *event);
#endif

  protected:
    ProcessMessage handleReceived(const meshtastic_MeshPacket &mp) override;
    int32_t runOnce() override;

  private:
    // --- envio ---
    void sendRaw(const uint8_t *buf, size_t len, NodeNum to, bool alert);
    void sendSos(bool repeat);
    void sendSosCancel();

    // --- interface ---
    void banner(const char *msg, uint32_t ms);
    void shortName(NodeNum n, char *out, size_t outLen);
    void buzz(uint8_t beeps, uint16_t onMs, uint16_t offMs);
    void buzzerTick(uint32_t now);
    void sosButtonTick(uint32_t now);

    // --- avisos persistentes (mensagens e zonas): ficam no ecrã até a equipa carregar OK ---
    struct Notice {
        uint16_t id;
        bool zone;
        NodeNum from;
        char text[164];
    };
    static constexpr uint8_t MAX_NOTICES = 4;
    Notice notices[MAX_NOTICES];
    uint8_t noticeCount = 0;
    uint8_t noticePage = 0;
    uint32_t noticeNextBeep = 0;
    uint32_t noticeNextCheck = 0;
    bool noticeOkPending = false; // OK carregado: tratar no próximo ciclo (o Meshtastic limpa o aviso depois do callback)
    void queueNotice(uint16_t id, bool zone, NodeNum from, const char *text, size_t len);
    void showNotice();
    void noticeTick(uint32_t now);
    static void onNoticeButton(int selected);
    void noticeConfirmed();
    void noticeDone();

    // Estado SOS (equipa)
    bool sosActive = false;
    bool sosAcked = false;
    uint16_t sosSeq = 0;
    uint32_t sosNextRepeat = 0;

    // Botão SOS
    bool btnDown = false;
    uint32_t btnSince = 0;
    bool btnHandled = false;

    // Resposta a PING com atraso aleatório (evita colisões quando a base pede a todos)
    uint32_t pingReplyAt = 0;

#ifdef RAIDTRACK_KIOSK
    // --- modo quiosque ---
    enum KScreen : uint8_t { K_HOME, K_MENU, K_SEND, K_CONFIRM, K_HISTORY };
    KScreen kScreen = K_HOME;
    int8_t kSel = 0;          // linha escolhida na lista atual
    int8_t kScroll = 0;       // página (mensagens longas, histórico)
    int8_t kPick = -1;        // mensagem rápida escolhida (para confirmar)
    int8_t kNoticePages = 1;  // páginas do aviso atual (calculado ao desenhar)
    uint8_t kOrient = 0;      // 0/1 = vertical (dois sentidos), 2/3 = horizontal (normal / invertida)
    uint32_t kLastInput = 0;
    char kToast[48] = "";
    uint32_t kToastUntil = 0;
    OLEDDisplay *kCanvas = nullptr;
    struct Hist {
        uint32_t at;
        bool zone;
        char text[164];
    };
    static constexpr uint8_t HIST_MAX = 6;
    Hist hist[HIST_MAX];
    uint8_t histCount = 0;
    void kioskInit();
    void kioskToast(const char *msg, uint32_t ms);
    void kioskRedraw();
    void kioskRemember(const Notice &nt);
    void kioskLoadPrefs();
    void kioskSavePrefs();
    void kioskSendText(const char *text);
    int kioskCannedCount();
    const char *kioskCanned(int i);
    void kioskRender(OLEDDisplay *c);
    void kioskBlit(OLEDDisplay *c, OLEDDisplay *d);
    void kioskUpdateHome(OLEDDisplay *c);
    void kioskTick(uint32_t now);
#endif

    // Besouro não bloqueante
    uint8_t buzzSteps = 0; // nº de transições restantes
    uint16_t buzzOnMs = 0, buzzOffMs = 0;
    uint32_t buzzNext = 0;
    bool buzzState = false;
};

extern RaidTrackModule *raidTrackModule;

// Chamado pelo Meshtastic (OptionalModules.h gerado em build)
void setupRaidTrack();
