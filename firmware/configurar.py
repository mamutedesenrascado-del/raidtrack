#!/usr/bin/env python3
"""
RaidTrack — configuração dos dispositivos depois de gravar o firmware.
Funciona em Windows e macOS. Requer:  pip install meshtastic  (no Mac: pip3 / python3)

Exemplos
  # 1) Gerar a chave do raid (uma vez por raid; guardar o resultado)
  python configurar.py chave

  # 2) Base (T3-S3) ligada por USB
  python configurar.py base   --porta COM5 --chave <CHAVE>

  # 3) Cada equipa (T-Beam)
  python configurar.py equipa --porta COM6 --chave <CHAVE> --codigo EQ1 --nome "Equipa 1 Lobos"

No macOS a porta é do tipo /dev/cu.usbserial-XXXX ou /dev/cu.usbmodemXXXX.
"""
import argparse
import base64
import os
import subprocess
import sys
import time

CANAL = "RaidTrack"

# Sem acentos: o ecrã OLED do T-Beam não desenha todos os caracteres portugueses.
MENSAGENS = [
    "Tudo bem",
    "Chegamos ao posto",
    "Saimos do posto",
    "A regressar a base",
    "Precisamos de agua",
    "Ferido ligeiro",
    "Estamos perdidos",
    "Pedimos contacto",
]

COMUM = [
    "lora.region", "EU_868",
    "lora.modem_preset", "LONG_FAST",
    "lora.hop_limit", "3",
    "device.role", "CLIENT",
    "telemetry.device_update_interval", "300",
]

EQUIPA = [
    "position.gps_mode", "ENABLED",
    "position.gps_update_interval", "30",
    "position.position_broadcast_secs", "60",
    "position.position_broadcast_smart_enabled", "false",
    "position.fixed_position", "false",
    # Botões: cima=25, baixo=13, OK=15 (ver docs/PROTOCOLO.md)
    "canned_message.enabled", "true",
    "canned_message.updown1_enabled", "true",
    "canned_message.inputbroker_pin_a", "25",
    "canned_message.inputbroker_pin_b", "13",
    "canned_message.inputbroker_pin_press", "15",
    "canned_message.allow_input_source", "updown1",
    "canned_message.send_bell", "false",
    # Ecrã ligado 24 h (0 = padrão de 10 min)
    "display.screen_on_secs", "86400",
]

BASE = [
    "position.gps_mode", "NOT_PRESENT",
    "bluetooth.enabled", "true",
    "bluetooth.mode", "RANDOM_PIN",
    "display.screen_on_secs", "86400",
]


def cli(porta, *args):
    # "python -m meshtastic" funciona em Windows e Mac mesmo sem a pasta de scripts no PATH
    cmd = [sys.executable, "-m", "meshtastic", "--port", porta, *args]
    print(">", " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        sys.exit(f"Falhou: {' '.join(cmd)}")
    time.sleep(2)  # o nó reinicia depois de algumas alterações


def sets(pares):
    out = []
    for k, v in zip(pares[::2], pares[1::2]):
        out += ["--set", k, v]
    return out


def canal(porta, chave):
    cli(porta, "--ch-index", "0", "--ch-set", "name", CANAL, "--ch-set", "psk", f"base64:{chave}")


def main():
    ap = argparse.ArgumentParser(description="Configuração RaidTrack")
    ap.add_argument("modo", choices=["chave", "base", "equipa"])
    ap.add_argument("--porta")
    ap.add_argument("--chave", help="PSK base64 do raid (gerada com 'chave')")
    ap.add_argument("--codigo", help="Código curto da equipa, máx. 4 caracteres (ex. EQ1)")
    ap.add_argument("--nome", help="Nome longo da equipa")
    a = ap.parse_args()

    if a.modo == "chave":
        print(base64.b64encode(os.urandom(32)).decode())
        print("Guarde esta chave: todos os dispositivos do raid têm de usar a mesma.")
        return

    if not a.porta or not a.chave:
        ap.error("--porta e --chave são obrigatórios")

    if a.modo == "base":
        cli(a.porta, "--set-owner", "RaidTrack Base", "--set-owner-short", "BASE")
        cli(a.porta, *sets(COMUM))
        cli(a.porta, *sets(BASE))
        canal(a.porta, a.chave)
    else:
        if not a.codigo:
            ap.error("--codigo é obrigatório para equipas")
        if len(a.codigo) > 4:
            ap.error("--codigo tem no máximo 4 caracteres")
        cli(a.porta, "--set-owner", a.nome or a.codigo, "--set-owner-short", a.codigo)
        cli(a.porta, *sets(COMUM))
        cli(a.porta, *sets(EQUIPA))
        cli(a.porta, "--set-canned-message", "|".join(MENSAGENS))
        canal(a.porta, a.chave)

    print("\nConcluído. Verifique com:  python -m meshtastic --port", a.porta, "--info   (Mac: python3 -m ...)")


if __name__ == "__main__":
    main()
