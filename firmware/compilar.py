#!/usr/bin/env python3
"""
Compila e grava o firmware RaidTrack no próprio PC (Windows ou macOS).
Requer Python 3.10+ e git.  Instala o PlatformIO sozinho.

  python compilar.py equipa              # só compila
  python compilar.py equipa --gravar COM6
  python compilar.py base   --gravar /dev/cu.usbmodem1101

Na primeira vez demora (descarrega o Meshtastic e as ferramentas ESP32, ~1,5 GB).
"""
import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

MESHTASTIC_REF = "v2.8.2.d5f1619"
AQUI = Path(__file__).resolve().parent
MT = AQUI / "_meshtastic"
ENVS = {"equipa": "raidtrack-equipa", "equipa-supreme": "raidtrack-equipa-supreme", "base": "raidtrack-base"}


def fixar_dependencias():
    """Limita versões de pacotes Python que o PlatformIO instala sozinho (UV_CONSTRAINT é respeitado pelo uv).
    - pioarduino 6.2.0.post1 anuncia-se como "6.2.0-post.1" e a plataforma ESP32 rejeita-o no fim da compilação.
    - Mac Intel: cryptography >= 49 deixou de ter pacote pré-compilado para x86_64 (exigia Rust + OpenSSL).
      Só se põe teto: o ESP-IDF fixa 44.0.x e o PlatformIO pede >= 45; ambos têm pacote Intel."""
    linhas = ["pioarduino==6.2.0"]
    if platform.system() == "Darwin" and platform.machine() == "x86_64":
        linhas.append("cryptography<49")
        print("Mac Intel detetado: a usar cryptography < 49 (pacote pré-compilado).")
    c = AQUI / "_constraints.txt"
    c.write_text("\n".join(linhas) + "\n")
    os.environ["UV_CONSTRAINT"] = str(c)
    os.environ["PIP_CONSTRAINT"] = str(c)


def run(cmd, cwd=None):
    print(">", " ".join(map(str, cmd)))
    if subprocess.run(cmd, cwd=cwd).returncode != 0:
        sys.exit("Falhou.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("alvo", choices=ENVS)
    ap.add_argument("--gravar", metavar="PORTA", help="grava no dispositivo ligado nesta porta")
    a = ap.parse_args()

    if sys.version_info < (3, 10):
        sys.exit(f"Python {sys.version.split()[0]} é antigo. Use Python 3.12 ou 3.13 (ex.: python3.13 compilar.py ...).")
    fixar_dependencias()

    if not MT.exists():
        run(["git", "clone", "--depth", "1", "--branch", MESHTASTIC_REF,
             "--recurse-submodules", "--shallow-submodules",
             "https://github.com/meshtastic/firmware.git", str(MT)])

    # Copia sempre a versão atual do módulo
    dst = MT / "src" / "modules" / "optional" / "RaidTrack"
    shutil.rmtree(dst, ignore_errors=True)
    shutil.copytree(AQUI / "RaidTrack", dst)
    # Pequenas alterações ao núcleo (modo quiosque): aplicadas uma vez, com git apply (Windows e Mac)
    for patch in sorted((AQUI / "patches").glob("*.patch")):
        if subprocess.run(["git", "apply", "--check", str(patch)], cwd=MT, capture_output=True).returncode == 0:
            run(["git", "apply", str(patch)], cwd=MT)
        elif subprocess.run(["git", "apply", "--reverse", "--check", str(patch)], cwd=MT, capture_output=True).returncode != 0:
            sys.exit(f"Não foi possível aplicar {patch.name}: apague a pasta {MT} e volte a correr.")
    (MT / "variants" / "raidtrack").mkdir(exist_ok=True)
    shutil.copy(AQUI / "raidtrack.ini", MT / "variants" / "raidtrack" / "raidtrack.ini")

    if shutil.which("pio") is None:
        run([sys.executable, "-m", "pip", "install", "-q", "platformio"])
    pio = [sys.executable, "-m", "platformio"]

    env = ENVS[a.alvo]
    if a.gravar:
        run(pio + ["run", "-e", env, "-t", "upload", "--upload-port", a.gravar], cwd=MT)
        print("\nGravado. Agora:  python configurar.py", a.alvo, "--porta", a.gravar, "--chave <CHAVE> ...")
    else:
        run(pio + ["run", "-e", env], cwd=MT)
        print("\nBinários em", MT / ".pio" / "build" / env)


if __name__ == "__main__":
    main()
