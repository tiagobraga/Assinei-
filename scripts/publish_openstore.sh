#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLICK_FILE="${PROJECT_DIR}/release/assinei-ut.braga_1.0.0_all.click"
APP_ID="assinei-ut.braga"

if [[ ! -f "${CLICK_FILE}" ]]; then
    echo "==> Pacote Click ainda não existe, executando build_click.py..."
    python3 "${PROJECT_DIR}/scripts/build_click.py"
fi

echo "==> Verificando integridade do pacote Click para a OpenStore..."
dpkg-deb -I "${CLICK_FILE}"
echo ""
echo "==> Conteúdo do pacote:"
dpkg-deb -c "${CLICK_FILE}"

if [[ -n "${OPENSTORE_API_KEY:-}" ]]; then
    echo ""
    echo "==> Enviando revisão para a OpenStore (${APP_ID})..."
    curl -fSL -X POST \
        -F "file=@${CLICK_FILE}" \
        -F "channel=noble" \
        -F "changelog=Versão 1.0.0: Assinador digital PAdES ICP-Brasil com suporte nativo ao certificado em nuvem SerproID e integração com o Lomiri Content Hub." \
        "https://open-store.io/api/v3/manage/${APP_ID}/revision?apikey=${OPENSTORE_API_KEY}"
    echo ""
    echo "Upload concluído com sucesso na OpenStore!"
else
    echo ""
    echo "NOTA: Variável OPENSTORE_API_KEY não definida."
    echo "Para publicar pela interface web da OpenStore:"
    echo "  1. Acesse https://open-store.io/submit"
    echo "  2. Preencha os dados conforme openstore/SUBMISSION_GUIDE.md"
    echo "  3. Faça upload de: ${CLICK_FILE}"
fi
