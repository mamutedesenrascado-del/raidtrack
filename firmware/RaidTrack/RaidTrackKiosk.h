#pragma once
/*
 * RaidTrack — "modo quiosque" do tracker de equipa (RAIDTRACK_KIOSK).
 *
 * O módulo desenha o ecrã inteiro (na vertical ou na horizontal) e recebe todos os botões,
 * para as equipas só verem mensagens, alertas e o essencial, sem menus do Meshtastic.
 * Ligação ao núcleo do Meshtastic: duas linhas em Screen.cpp e InputBroker.cpp
 * (firmware/patches/kiosk.patch, aplicado na compilação).
 */
class OLEDDisplay;
struct _InputEvent;

/** Desenha o ecrã no buffer do OLED; devolve false para deixar o Meshtastic desenhar (ex.: arranque) */
extern bool (*raidtrackKioskDraw)(OLEDDisplay *display);
/** Recebe um evento de botão; devolve true se o consumiu (não chega aos menus do Meshtastic) */
extern bool (*raidtrackKioskInput)(const struct _InputEvent *event);
