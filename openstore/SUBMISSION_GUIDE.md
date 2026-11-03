# Guia de Publicação na OpenStore — Assinei! (`assinei-ut.braga`)

Este documento contém todos os campos prontos para submissão do aplicativo na **OpenStore** (`https://open-store.io/submit`), além das instruções para atualizações futuras via API.

---

## 1. Cadastro Inicial em `https://open-store.io/submit`

| Campo na OpenStore | Valor para Preencher |
| :--- | :--- |
| **App Name (Package ID)** | `assinei-ut.braga` |
| **Title** | `Assinei!` |
| **Category** | `Office` |
| **License** | `GNU General Public License v3.0` |
| **Source URL** | `https://github.com/tiagobraga/Assinei-` |

### Tagline (Resumo Curto)
- **Português**:
  `Assinador digital de documentos PDF no padrão PAdES / ICP-Brasil com certificado em nuvem SerproID`
- **Inglês**:
  `PAdES / ICP-Brasil digital PDF signer using SerproID cloud certificates for Ubuntu Touch`

### Description (Descrição Completa — PT-BR / EN)
```text
Assine documentos PDF no padrão PAdES (PDF Advanced Electronic Signatures) da ICP-Brasil diretamente no seu dispositivo Ubuntu Touch utilizando seu certificado digital em nuvem SerproID.

Destaques:
• Integração Nativa com o Lomiri Content Hub: Abra arquivos PDF diretamente pelo Gerenciador de Arquivos, navegador Morph, Telegram ou Nextcloud ("Abrir com Assinei!"), e exporte ou compartilhe o documento assinado (_tb.pdf) com um toque.
• Posicionamento Visual Touch-First: Alterne entre o modo de leitura/rolagem e o modo de marcação para desenhar com o dedo o local exato onde a estampa visual da assinatura será gravada na página.
• Estampas Personalizáveis: Escolha entre os selos visuais Ipê, Brasão da República ou IBICT.
• Suporte Nativo ao SerproID em ARM64: Pareie seu dispositivo, sincronize seus certificados ICP-Brasil com cadeias de certificação completas e autorize a assinatura via notificação de PIN no SerproID.
• Confinamento Estrito AppArmor: Funciona 100% dentro das políticas de segurança padrão da OpenStore.

---
[EN]
Sign PDF documents using the ICP-Brasil PAdES (PDF Advanced Electronic Signatures) standard directly on your Ubuntu Touch device with your SerproID cloud digital certificate.

Key Features:
• Native Lomiri Content Hub Integration: Import PDF files from any Ubuntu Touch app ("Open with Assinei!") and export/share the signed PDF (_tb.pdf) effortlessly.
• Touch-First Visual Stamp Positioning: Toggle between scroll mode and stamp placement mode to draw the exact rectangle for your visual signature stamp on any page.
• Native ARM64 SerproID Cloud Support: Pair your device, sync ICP-Brasil certificates with full CA chains, and authorize signatures via SerproID PIN push notifications.
```

### Keywords (Palavras-chave)
```text
pdf, assinatura, serproid, icp-brasil, pades, govbr, certificado, signature
```

### Changelog (Versão 1.0.0)
```text
Versão inicial (v1.0.0) para Ubuntu Touch 24.04 (Noble):
- Integração nativa com Lomiri Content Hub (importação e exportação de documentos PDF)
- Motor de assinatura PAdES (adbe.pkcs7.detached) com cadeias completas ICP-Brasil
- Integração nativa com SerproID Cloud API (pareamento, sincronização de certificados e assinatura com PIN push)
- Posicionamento visual da estampa de assinatura otimizado para telas de toque
```

---

## 2. Arquivo do Pacote Click

- **Caminho do Pacote**: `release/assinei-ut.braga_1.0.0_all.click`
- **Canal**: `noble` (Ubuntu Touch 24.04)

---

## 3. Publicação Automatizada via Linha de Comando

```bash
OPENSTORE_API_KEY="sua_chave_aqui" ./scripts/publish_openstore.sh
```
