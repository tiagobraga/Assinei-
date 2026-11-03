# Assinei!

![Assinei Logo](public/ipe.png)

**Assinei!** é um sistema multiplataforma (Desktop & Mobile **Ubuntu Touch**) desenvolvido sob o conceito de *Vibe Coding*, que permite a assinatura digital de documentos no formato PDF utilizando os certificados e infraestrutura **SERPRO-ID** com base no padrão **ICP-Brasil (PAdES — `adbe.pkcs7.detached`)**.

É um projeto open-source concebido e desenvolvido originalmente por **Tiago Emmanuel Nunes Braga** com foco em prover assinaturas digitais avançadas localmente, dispensando uploads do documento para terceiros.

---

## Características

- **Multiplataforma (Desktop & Mobile):**
  - **Desktop (Windows, macOS e Linux):** Arquitetura *Electron* executável de forma nativa e enxuta.
  - **Ubuntu Touch (`ubuntu-touch-24.04-1.x` / Lomiri):** Pacote `.click` nativo (`assinei-ut.braga`) pronto para a **OpenStore**, com integração ao `Lomiri.Content` (Content Hub), renderização PDF.js compatível com QtWebEngine e motor SerproID Cloud / PAdES 100% independente de arquitetura (`all` / ARM64).
- **Renderização em Abas Modernas:** Carregue múltiplos documentos PDF em abas ágeis com renderização em `<canvas>` de alta resolução.
- **PAdES Local Avançado:** Assinatura digital no padrão PAdES (PDF Advanced Electronic Signatures) contendo Cadeias de Confiança ICP-Brasil (AIA).
- **Assinatura Visual Posicional (Mouse & Touch):** Defina com precisão a área da página onde sua logomarca (Ipê, Brasão da República ou IBICT) e os dados do certificado serão estampados.
- **Integração SERPRO-ID (PKCS#11 Desktop & Cloud HTTPS no Ubuntu Touch):**
  - No Desktop via biblioteca PKCS#11 (`libserproidp11.so`).
  - No Ubuntu Touch via pareamento direto por QR Code na opção **Computadores** do aplicativo SerproID, sincronização de certificados e disparo de notificação Push PIN para assinatura.

---

## Downloads

### Desktop (v1.0.0)
- 💻 **Windows** (Instalador Nativo): [Baixar Exe](https://github.com/tiagobraga/Assinei-/releases/download/v1.0.0/Assinei.Setup.0.0.0.exe)
- 🐧 **Linux** (Pacote Debian): [Baixar .deb](https://github.com/tiagobraga/Assinei-/releases/download/v1.0.0/0306_p_assinador_pdf_0.0.0_amd64.deb)
- 🐧 **Linux** (Portátil AppImage): [Baixar .AppImage](https://github.com/tiagobraga/Assinei-/releases/download/v1.0.0/Assinei.-0.0.0.AppImage)

### Ubuntu Touch / OpenStore (v1.0.0)
- 📱 **Ubuntu Touch (24.04 Noble — `all` / ARM64):** [`release/assinei-ut.braga_1.0.0_all.click`](release/assinei-ut.braga_1.0.0_all.click)

---

## 📱 Edição Ubuntu Touch & OpenStore (`assinei-ut.braga`)

A edição para **Ubuntu Touch** foi projetada para funcionar em dispositivos móveis ARM64 sob confinamento estrito do **AppArmor** (`policy_version: 2404.1`):

1. **Lomiri Content Hub (`Lomiri.Content 1.3`):** Permite abrir PDFs recebidos de qualquer aplicativo do Ubuntu Touch e exportar/compartilhar o PDF assinado (`_tb.pdf`).
2. **Fluxo SerproID "Computadores" via QR Code:**
   - **Passo 1 (Autorizar Computador):** Gera o QR Code oficial compatível com o aplicativo móvel SerproID (*Computadores -> +*).
   - **Passo 2 (Ler Certificados):** Sincroniza os certificados vinculados ao dispositivo e anexa a cadeia ICP-Brasil.
3. **Motor PAdES + Estampa Visual em Python Puro (`src/ubuntu_touch/pades_signer.py`):** Gera o `ByteRange`, a estampa visual com logo (`FlateDecode` com canal Alpha `/SMask` sem depender de `python3-pil`) e a estrutura CMS/PKCS#7 (`adbe.pkcs7.detached`).

### Como Testar e Gerar o Pacote `.click` (Ubuntu Touch)

```bash
# Executar a suíte de testes unitários e criptográficos PAdES
python3 -m unittest discover -s tests -v

# Gerar o pacote .click pronto para submissão na OpenStore
python3 scripts/build_click.py
```

O pacote final é gerado em `release/assinei-ut.braga_1.0.0_all.click`. Para detalhes de publicação na loja oficial do Ubuntu Touch, consulte [`openstore/SUBMISSION_GUIDE.md`](openstore/SUBMISSION_GUIDE.md).

---

## 💻 Fluxo de Desenvolvimento Desktop (Walkthrough)

O Assinei! foi idealizado num esforço concentrado de modelagem progressiva, cujos destaques incluem:
1. **Andaime (Scaffold)** inicial em Vite, React e TailwindCSS sobre Node.js empacotado pelo Electron.
2. Incorporação gráfica do `lucide-react` para estéticas de navegação, e migração dos controles primários de mouse via biblioteca PDF.js originária da Fundação Mozilla.
3. Superação de complexas restrições técnicas (Node Forge VS buffers de dados binários) no intercâmbio Node <-> PKCS#11 da ICP Brasil, contornando a ausência e incompatibilidade dos certificados PAdES mediante o pareamento e extração cirúrgica usando bibliotecas puras modulares (`pdf-lib` e `node-signpdf`).
4. Lapidações incrementais do Motor PAdES com conversões vetoriais X/Y e `Math.max` geográficos visando não distorcer estampas de certificado, resolvendo até o detalhe mínimo da inserção de logos personalizados como a logomarca nativa do Assinei.
5. Limpezas profundas no Code Signing da Apple com o tratamento de Apple Extended Attributes e arquivos intrusos (`osx xattr`).

### Como Desenvolver Localmente (Desktop)

```bash
# Clone este repositório
git clone https://github.com/tiagobraga/Assinei-

# Instale os pacotes e dependências nativas (necessita python compiler e build-essential)
npm install

# Para rodar o ambiente de desenvolvimento lado a lado com a janela do Electron
npm run electron:dev

# Para compilar um executável empacotado nativo do seu Sistema (ex: DMG, EXE)
npm run electron:build
```

---

## Credenciais
* **Desenvolvedor:** Tiago Emmanuel Nunes Braga
* **Currículo Lattes:** [Acessar Lattes](https://lattes.cnpq.br/8376134230259399)
* **Status do Projeto:** v1.0.0 Lançada publicamente! (Desktop & Ubuntu Touch — Sistema Ativo, Funcional & Open-Source).
