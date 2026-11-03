#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELEASE_DIR="${PROJECT_DIR}/release"

echo "==> [1/3] Gerando pacote Click local para OpenStore via scripts/build_click.py..."
python3 "${PROJECT_DIR}/scripts/build_click.py"

CLICK_FILE="${RELEASE_DIR}/assinei-ut.braga_1.0.0_all.click"

echo "==> [2/3] Inspecionando pacote Click gerado..."
dpkg-deb -I "${CLICK_FILE}"

if command -v adb >/dev/null 2>&1 && adb get-state >/dev/null 2>&1; then
    echo "==> [3/3] Dispositivo Ubuntu Touch detectado via ADB! Enviando e instalando pacote..."
    adb push "${CLICK_FILE}" /tmp/assinei-ut.braga_1.0.0_all.click
    adb shell "gdbus call --system --dest com.lomiri.click --object-path /com/lomiri/click --method com.lomiri.click.Install /tmp/assinei-ut.braga_1.0.0_all.click"
    echo "Instalado com sucesso no dispositivo Ubuntu Touch!"
else
    echo "==> [3/3] Nenhum dispositivo ADB conectado no momento. Pacote pronto em: ${CLICK_FILE}"
fi
