#!/bin/bash
set -e

echo "Instalando a versão mais recente do Assinador..."
sudo apt install -y ./release/0306_p_assinador_pdf_0.0.0_amd64.deb

# Localizando o arquivo .desktop gerado
DESKTOP_FILE=$(find /usr/share/applications -name "0306_p_assinador_pdf*.desktop" | head -n 1)

if [ -z "$DESKTOP_FILE" ]; then
    echo "Aviso: Arquivo .desktop não encontrado em /usr/share/applications!"
else
    echo "Configurando a inicialização do sistema em $DESKTOP_FILE..."
    
    # Garantir que a flag não seja adicionada mais de uma vez
    if grep -q "\-\-no\-sandbox" "$DESKTOP_FILE"; then
        echo "A flag --no-sandbox já está configurada."
    else
        # Alterar a linha Exec adicionando a flag antes de outros argumentos, preservando o caminho original do executável
        sudo sed -i 's/^Exec=\([^ ]*\) /Exec=\1 --no-sandbox /' "$DESKTOP_FILE"
        echo "Pronto! O aplicativo foi atualizado com a flag --no-sandbox."
    fi
fi
