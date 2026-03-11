# Assinei!

**Assinei!** é um sistema desktop multiplataforma desenvolvido sob o conceito de *Vibe Coding*, que permite a assinatura digital de documentos no formato PDF utilizando os certificados e infraestrutura SERPRO-ID com base no padrão ICP-Brasil.

É um projeto open-source concebido e desenvolvido originalmente por **Tiago Emmanuel Nunes Braga** com foco em prover assinaturas digitais avançadas localmente (offline), dispensando uploads para nuvens ou integrações invasivas.

## Características

- **Multiplataforma:** Arquitetura *Electron* executável de forma nativa e enxuta no macOS, Windows e Linux.
- **Renderização Abas Modernas:** Carregue múltiplos documentos PDF em abas ágeis através do sistema nativo de visualização isolado no React.
- **PAdES Local Avançado:** Assinatura digital no padrão PAdES (PDF Advanced Electronic Signatures) contendo Cadeias Traseiras de Confiança ICP-Brasil (AIA).
- **Assinatura Visual Posicional:** Através de uma ferramenta customizada de Overlays Dinâmicos com cálculos Percentuais Cartesianos embutida, defina um Retângulo de Assinatura com a exata precisão (Math.max boundaries) em que a sua logomarca ou estampa descritiva será aplicada sobre as páginas do documento.
- **Integração SERPRO-ID:** Acionamento dinâmico via arquitetura IPC Main/Bridge para os drivers e bibliotecas criptográficas nativas do Serpro (`PKCS#11`), gerando as requisições que caem no seu smartphone via Token push.
- **Segurança de Sandbox:** Executável livre de metadados, operado contextualmente protegido (ContextIsolation).

## Fluxo de Desenvolvimento (Walkthrough)

O Assinei! foi idealizado num esforço concentrado de modelagem progressiva, cujos destaques incluem:
1. **Andaime (Scaffold)** inicial em Vite, React e TailwindCSS sobre Node.js empacotado pelo Electron.
2. Incorporação gráfica do `lucide-react` para estéticas de navegação, e migração dos controles primários de mouse via biblioteca PDF.js originária da Fundação Mozilla.
3. Superação de complexas restrições técnicas (Node Forge VS buffers de dados binários) no intercâmbio Node <-> PKCS#11 da ICP Brasil, contornando a ausência e incompatibilidade dos certificados PAdES mediante o pareamento e extração cirúrgica usando bibliotecas puras modulares (`pdf-lib` e `node-signpdf`).
4. Lapidações incrementais do Motor PAdES com conversões vetoriais X/Y e `Math.max` geográficos visando não distorcer estampas de certificado, resolvendo até o detalhe mínimo da inserção de logos personalizados como a logomarca nativa do Assinei.
5. Limpezas profundas no Code Signing da Apple com o tratamento de Apple Extended Attributes e arquivos intrusos (`osx xattr`).

### Como Desenvolver Localmente

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

## Credenciais
* **Desenvolvedor:** Tiago Emmanuel Nunes Braga 
* **Currículo Lattes:** [Acessar Lattes](https://lattes.cnpq.br/8376134230259399)
* **Status do Projeto:** Ativo, Funcional & Open-Source.
