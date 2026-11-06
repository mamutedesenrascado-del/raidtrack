#include "RaidTrack.h"

#include "MeshService.h"
#include "NodeDB.h"
#include "PowerFSM.h"
#include "PowerStatus.h"
#include "main.h"
#include "modules/PositionModule.h"
#include <Arduino.h>
#include <cstring>

#if HAS_SCREEN
#include "graphics/Screen.h"
#endif

#if !defined(RAIDTRACK_ROLE_TEAM) && !defined(RAIDTRACK_ROLE_BASE)
// Sem papel definido: comporta-se como base (só recebe e mostra). Não interfere com builds normais.
#define RAIDTRACK_ROLE_BASE
#endif

// Tempos (ms) — ver docs/PROTOCOLO.md
#ifndef RAIDTRACK_SOS_HOLD_MS
#define RAIDTRACK_SOS_HOLD_MS 2000 // premir 2 s para disparar SOS
#endif
#ifndef RAIDTRACK_CANCEL_HOLD_MS
#define RAIDTRACK_CANCEL_HOLD_MS 5000 // premir 5 s com SOS ativo para cancelar
#endif
#ifndef RAIDTRACK_SOS_REPEAT_MS
#define RAIDTRACK_SOS_REPEAT_MS 30000 // repetir SOS até ACK
#endif
#ifndef RAIDTRACK_PING_JITTER_MS
#define RAIDTRACK_PING_JITTER_MS 8000 // atraso máximo de resposta a PING geral
#endif

using namespace raidtrack;

RaidTrackModule *raidTrackModule;

void setupRaidTrack()
{
    raidTrackModule = new RaidTrackModule();
}

// ---------------------------------------------------------------------------------------------
// Utilitários little-endian

static inline void putU16(uint8_t *b, uint16_t v)
{
    b[0] = v & 0xFF;
    b[1] = v >> 8;
}
static inline void putU32(uint8_t *b, uint32_t v)
{
    for (int i = 0; i < 4; i++)
        b[i] = (v >> (8 * i)) & 0xFF;
}
static inline uint16_t getU16(const uint8_t *b)
{
    return b[0] | (b[1] << 8);
}
static inline uint32_t getU32(const uint8_t *b)
{
    return (uint32_t)b[0] | ((uint32_t)b[1] << 8) | ((uint32_t)b[2] << 16) | ((uint32_t)b[3] << 24);
}

// ---------------------------------------------------------------------------------------------

RaidTrackModule::RaidTrackModule()
    : SinglePortModule("raidtrack", meshtastic_PortNum_PRIVATE_APP), concurrency::OSThread("RaidTrack")
{
    sosSeq = (uint16_t)random(1, 0xFFFF);
#ifdef RAIDTRACK_SOS_PIN
    pinMode(RAIDTRACK_SOS_PIN, INPUT_PULLUP);
#endif
#ifdef RAIDTRACK_BUZZER_PIN
    pinMode(RAIDTRACK_BUZZER_PIN, OUTPUT);
    digitalWrite(RAIDTRACK_BUZZER_PIN, LOW);
#endif
    LOG_INFO("RaidTrack: módulo ativo (%s)",
#ifdef RAIDTRACK_ROLE_TEAM
             "equipa"
#else
             "base"
#endif
    );
}

int32_t RaidTrackModule::runOnce()
{
    uint32_t now = millis();

#ifdef RAIDTRACK_ROLE_TEAM
    sosButtonTick(now);

    // Repetição do SOS até a base confirmar
    if (sosActive && !sosAcked && (int32_t)(now - sosNextRepeat) >= 0) {
        sendSos(true);
    }

    // Resposta diferida a PING
    if (pingReplyAt && (int32_t)(now - pingReplyAt) >= 0) {
        pingReplyAt = 0;
        if (positionModule) {
            LOG_INFO("RaidTrack: resposta a PING com posição");
            positionModule->sendOurPosition();
        }
    }
#endif

    buzzerTick(now);
    return 50; // ms — suficiente para ler o botão com debounce
}

// ---------------------------------------------------------------------------------------------
// Botão SOS (só equipa)

void RaidTrackModule::sosButtonTick(uint32_t now)
{
#ifdef RAIDTRACK_SOS_PIN
    bool pressed = digitalRead(RAIDTRACK_SOS_PIN) == LOW;

    if (pressed && !btnDown) {
        btnDown = true;
        btnSince = now;
        btnHandled = false;
        powerFSM.trigger(EVENT_INPUT); // acorda o ecrã
    } else if (!pressed && btnDown) {
        btnDown = false;
    }

    if (!btnDown || btnHandled)
        return;

    uint32_t held = now - btnSince;

    if (!sosActive && held >= RAIDTRACK_SOS_HOLD_MS) {
        btnHandled = true;
        sosActive = true;
        sosAcked = false;
        sosSeq++;
        sendSos(false);
        banner("SOS ENVIADO\nA aguardar base...", 0);
        buzz(3, 150, 150);
    } else if (sosActive && held >= RAIDTRACK_CANCEL_HOLD_MS) {
        btnHandled = true;
        sendSosCancel();
        sosActive = false;
        sosAcked = false;
        banner("SOS CANCELADO", 4000);
        buzz(1, 600, 0);
    }
#else
    (void)now;
#endif
}

// ---------------------------------------------------------------------------------------------
// Envio

void RaidTrackModule::sendRaw(const uint8_t *buf, size_t len, NodeNum to, bool alert)
{
    meshtastic_MeshPacket *p = allocDataPacket();
    if (!p) {
        LOG_WARN("RaidTrack: sem memória para pacote");
        return;
    }
    p->to = to;
    p->channel = 0;
    p->want_ack = (to != NODENUM_BROADCAST);
    p->priority = alert ? meshtastic_MeshPacket_Priority_ALERT : meshtastic_MeshPacket_Priority_RELIABLE;
    p->decoded.payload.size = len;
    memcpy(p->decoded.payload.bytes, buf, len);
    service->sendToMesh(p, RX_SRC_LOCAL, true); // true = cópia para a app ligada a este nó
}

void RaidTrackModule::sendSos(bool repeat)
{
    uint8_t b[15];
    b[0] = MAGIC;
    b[1] = VERSION;
    b[2] = MSG_SOS;
    putU16(b + 3, sosSeq);

    bool hasFix = localPosition.latitude_i != 0 || localPosition.longitude_i != 0;
    putU32(b + 5, (uint32_t)localPosition.latitude_i);
    putU32(b + 9, (uint32_t)localPosition.longitude_i);
    b[13] = powerStatus ? powerStatus->getBatteryChargePercent() : 0;
    b[14] = (hasFix ? FLAG_HAS_FIX : 0) | (repeat ? FLAG_REPEAT : 0);

    LOG_WARN("RaidTrack: SOS seq=%u fix=%d repeat=%d", sosSeq, hasFix, repeat);
    sendRaw(b, sizeof(b), NODENUM_BROADCAST, true);
    sosNextRepeat = millis() + RAIDTRACK_SOS_REPEAT_MS;
}

void RaidTrackModule::sendSosCancel()
{
    uint8_t b[5] = {MAGIC, VERSION, MSG_SOS_CANCEL, 0, 0};
    putU16(b + 3, sosSeq);
    sendRaw(b, sizeof(b), NODENUM_BROADCAST, true);
}

// ---------------------------------------------------------------------------------------------
// Receção

ProcessMessage RaidTrackModule::handleReceived(const meshtastic_MeshPacket &mp)
{
    const auto &pl = mp.decoded.payload;
    if (pl.size < 3 || pl.bytes[0] != MAGIC || pl.bytes[1] != VERSION) {
        return ProcessMessage::CONTINUE; // não é nosso — deixa passar (outros usos de PRIVATE_APP)
    }

    const uint8_t *b = pl.bytes;
    NodeNum from = getFrom(&mp);
    char who[8];
    shortName(from, who, sizeof(who));
    char msg[64];

    switch (b[2]) {
    case MSG_SOS:
        if (pl.size < 15)
            break;
        // Qualquer nó mostra o SOS; na base é o que interessa. A app recebe o pacote em paralelo.
        snprintf(msg, sizeof(msg), "!!! SOS %s !!!\nBat %u%%%s", who, b[13], (b[14] & FLAG_HAS_FIX) ? "" : " SEM GPS");
        banner(msg, 0);
        buzz(5, 200, 100);
        break;

    case MSG_SOS_CANCEL:
        snprintf(msg, sizeof(msg), "SOS %s cancelado", who);
        banner(msg, 6000);
        break;

#ifdef RAIDTRACK_ROLE_TEAM
    case MSG_SOS_ACK: {
        if (pl.size < 9)
            break;
        NodeNum target = getU32(b + 3);
        uint16_t seq = getU16(b + 7);
        if (target == nodeDB->getNodeNum() && sosActive && seq == sosSeq) {
            sosAcked = true;
            banner("BASE RECEBEU O SOS\nAjuda a caminho", 0);
            buzz(1, 1500, 0);
        }
        break;
    }

    case MSG_PING:
        // PING dirigido a nós: responde já. PING geral: atraso aleatório para não colidir.
        pingReplyAt = millis() + (isToUs(&mp) ? 100 : (uint32_t)random(500, RAIDTRACK_PING_JITTER_MS));
        break;
#endif

    default:
        break;
    }

    // CONTINUE: o RoutingModule tem de ver o pacote para o entregar à app (USB/BLE) da base.
    return ProcessMessage::CONTINUE;
}

// ---------------------------------------------------------------------------------------------
// Interface

void RaidTrackModule::shortName(NodeNum n, char *out, size_t outLen)
{
    meshtastic_NodeInfoLite *node = nodeDB->getMeshNode(n);
    // v2.8: o nome está diretamente no NodeInfoLite; a presença de User é um bit em `bitfield`
    if (nodeInfoLiteHasUser(node) && node->short_name[0]) {
        snprintf(out, outLen, "%s", node->short_name);
    } else {
        snprintf(out, outLen, "%04x", (unsigned)(n & 0xFFFF));
    }
}

void RaidTrackModule::banner(const char *msg, uint32_t ms)
{
#if HAS_SCREEN && !defined(MESHTASTIC_INCLUDE_INKHUD)
    powerFSM.trigger(EVENT_RECEIVED_MSG); // garante ecrã ligado
    if (screen)
        screen->showSimpleBanner(msg, ms ? ms : 30000);
#else
    (void)msg;
    (void)ms;
#endif
}

void RaidTrackModule::buzz(uint8_t beeps, uint16_t onMs, uint16_t offMs)
{
#ifdef RAIDTRACK_BUZZER_PIN
    buzzSteps = beeps * 2;
    buzzOnMs = onMs;
    buzzOffMs = offMs;
    buzzState = false;
    buzzNext = millis();
#else
    (void)beeps;
    (void)onMs;
    (void)offMs;
#endif
}

void RaidTrackModule::buzzerTick(uint32_t now)
{
#ifdef RAIDTRACK_BUZZER_PIN
    if (!buzzSteps || (int32_t)(now - buzzNext) < 0)
        return;
    buzzState = !buzzState;
    digitalWrite(RAIDTRACK_BUZZER_PIN, buzzState ? HIGH : LOW);
    buzzNext = now + (buzzState ? buzzOnMs : buzzOffMs);
    buzzSteps--;
    if (!buzzSteps)
        digitalWrite(RAIDTRACK_BUZZER_PIN, LOW);
#else
    (void)now;
#endif
}
