const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const signpdf = require('@signpdf/signpdf').default;
const { Signer } = require('@signpdf/utils');
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const forge = require('node-forge');
const fs = require('fs');
const crypto = require('crypto');

const pkcs11Service = require('./pkcs11Service.cjs');

// Implementação Nativa de um Assinador CMS para @signpdf que intercepta 
// a chave privada e delega o C_Sign para o Hardware do SERPRO!
class HardwareSigner extends Signer {
    constructor(slotId, certDerBase64, chainB64Array = []) {
        super();
        this.slotId = slotId;
        this.certDerBuffer = Buffer.from(certDerBase64, 'base64');
        this.chainB64Array = chainB64Array && chainB64Array.length > 0 ? chainB64Array : [certDerBase64];
    }

    async sign(pdfBuffer) {
        const certAsn1 = forge.asn1.fromDer(this.certDerBuffer.toString('binary'));
        const certObj = forge.pki.certificateFromAsn1(certAsn1);

        const p7 = forge.pkcs7.createSignedData();
        p7.content = forge.util.createBuffer(pdfBuffer.toString('binary'));

        // Empacota toda a Cadeia de Confiança (CA / ICP-Brasil Root) para o Adobe Acrobat não engasgar "Identity Unknown"
        this.chainB64Array.forEach(certB64 => {
            try {
                const chainAsn1 = forge.asn1.fromDer(Buffer.from(certB64, 'base64').toString('binary'));
                const chainCert = forge.pki.certificateFromAsn1(chainAsn1);
                p7.addCertificate(chainCert);
            } catch (err) {
                console.log("Aviso: Falha ao acoplar cert secundário na chain CMS:", err.message);
            }
        });

        const self = this;

        // Criando uma "Fake Key" personalizada.
        // O `node-forge` gerará o ASN.1 dos authenticatedAttributes, fará o hash e executará `sign`.
        // Nós interceptamos esse `sign(md)` para empacotar o DigestInfo e mandar para o C++.
        const customKey = {
            sign: function (md) {
                // `md` é o MessageDigest (usualmente SHA-256) validado com os atributos de assinatura
                const forgeHashStr = md.digest().getBytes();
                const attrsHash = Buffer.from(forgeHashStr, 'binary');

                // Pré-pendemos PKCS#1 DigestInfo (SHA-256) bruto
                const digestInfoPrefix = Buffer.from('3031300d060960864801650304020105000420', 'hex');
                const digestInfo = Buffer.concat([digestInfoPrefix, attrsHash]);

                // Acionamos a placa criptográfica na máquina C++
                const signResult = pkcs11Service.signData(self.slotId, digestInfo);

                if (!signResult.success) {
                    throw new Error(`Falha no Driver do Serpro: ${signResult.error}`);
                }

                // O node-forge espera os bytes criptografados devueltos como uma string binária nativa JS
                return signResult.signature.toString('binary');
            }
        };

        p7.addSigner({
            key: customKey,
            certificate: certObj,
            digestAlgorithm: forge.pki.oids.sha256,
            authenticatedAttributes: [
                { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
                { type: forge.pki.oids.messageDigest }
            ]
        });

        // HACK: O Node-Forge hardcoda a criptografia para genérico 'rsaEncryption' (1.2.840.113549.1.1.1).
        // Isso quebra a validação ISO do GOV.BR no Adobe Reader. Forçamos para 'sha256WithRSAEncryption'.
        p7.signers[p7.signers.length - 1].signatureAlgorithm = forge.pki.oids.sha256WithRSAEncryption;

        // Este comando fará toda a mágica, incluindo popular messageDigest e chamar o signer do customKey!
        p7.sign({ detached: true });

        const cmsAsn1 = p7.toAsn1();
        const cmsDer = forge.asn1.toDer(cmsAsn1).getBytes();

        return Buffer.from(cmsDer, 'binary');
    }
}

async function signBuffer(pdfBuffer, slotId, certDerBase64, chainB64Array = [], signatureBox = null) {
    try {
        const certAsn1 = forge.asn1.fromDer(Buffer.from(certDerBase64, 'base64').toString('binary'));
        const certObj = forge.pki.certificateFromAsn1(certAsn1);

        let subjectName = 'Assinante';
        const cnAttr = certObj.subject.attributes.find(a => a.shortName === 'CN' || a.name === 'commonName');
        if (cnAttr) {
            subjectName = cnAttr.value.split(':')[0]; // Remove CPF (e.g. NOME:12345678)
        }

        // Inicializar a leitura do PDF bruto (Trata arquivos modernos e streams XRef)
        const pdfDoc = await PDFDocument.load(pdfBuffer);

        // --- Criação do Carimbo Visual (Padrão Gov.BR/ICP-Brasil) ---
        const pages = pdfDoc.getPages();

        let targetPageIdx = 0;
        let sigWidth = 240;
        let sigHeight = 65;
        let finalX = 0;
        let finalY = 0;

        // Se o usuário desenhou a caixa lá no React, aplicamos as coordenadas 
        // Lembrando que o React (Web) trabalha com o Y=0 no TOPO,
        // enquanto o PDF trabalha com o Y=0 no RODAPÉ inferior.
        if (signatureBox && signatureBox.w > 0 && signatureBox.h > 0) {
            targetPageIdx = Math.max(0, signatureBox.page - 1);
            const targetPageObj = pages[targetPageIdx] || pages[0];
            const { width, height } = targetPageObj.getSize();

            // Aqui recebemos do React floats de Porcentagem (% entre 0 e 1)
            // Limitamos a um mínimo (ex: 200x45) para que o Box Cinza de fundo e o texto nunca escapem caso 
            // o usuário clique sem arrastar, desenhando apenas um "ponto" invisível na tela.
            sigWidth = Math.max(signatureBox.w * width, 200);
            sigHeight = Math.max(signatureBox.h * height, 45);
            finalX = signatureBox.x * width;
            // Inversão Cartesiana (Y=0 bottom) e escala
            finalY = height - (signatureBox.y * height) - sigHeight;
        } else {
            // Fallback ao Exemplo Base (Canto inferior direito com marcação padronizada)
            const lastPage = pages[pages.length - 1];
            targetPageIdx = pages.length - 1;
            const { width, height } = lastPage.getSize();

            finalX = width - sigWidth - 40;
            finalY = 40;
        }

        const targetPage = pages[targetPageIdx] || pages[0];

        // Fonte e Imagem
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

        let icpImg = null;
        try {
            const imgBuf = fs.readFileSync(__dirname + '/ipe.png');
            icpImg = await pdfDoc.embedPng(imgBuf);
        } catch (e) {
            console.log("Logomarca IPE não disponível, desenhando sem a logo visual.");
        }

        // Fundo Claro e Borda
        targetPage.drawRectangle({
            x: finalX,
            y: finalY,
            width: sigWidth,
            height: sigHeight,
            color: rgb(0.96, 0.96, 0.98),
            borderColor: rgb(0.5, 0.5, 0.5),
            borderWidth: 1.5,
        });

        // O padding e o Logo adaptam-se dinamicamente ao espaço (Limitado) desenhado
        const imgPadding = Math.min(8, sigHeight * 0.1);
        const imgSize = sigHeight - (imgPadding * 2);

        // Desenhar ICP Logo
        if (icpImg && imgSize > 10) {
            targetPage.drawImage(icpImg, {
                x: finalX + imgPadding,
                y: finalY + imgPadding,
                width: imgSize,
                height: imgSize
            });
        }

        // Textos (escala font baseada na altura desenhada do box)
        const textX = finalX + imgSize + (imgPadding * 2);
        const lineTop = finalY + sigHeight - (imgPadding * 2);
        const dynamicFontSize = Math.max(6, Math.min(8, sigHeight * 0.15));

        // Se box não for muito pequena
        if (sigWidth > textX - finalX) {
            targetPage.drawText('ASSINATURA DIGITAL', {
                x: textX, y: lineTop, size: dynamicFontSize, font: fontBold, color: rgb(0.2, 0.2, 0.2)
            });

            // Nome Limitado
            let shortName = subjectName;
            if (shortName.length > 28) shortName = shortName.substring(0, 25) + '...';

            const lineHeight = dynamicFontSize * 1.5;
            targetPage.drawText(shortName, {
                x: textX, y: lineTop - lineHeight, size: dynamicFontSize - 1, font, color: rgb(0.1, 0.1, 0.1)
            });

            // OID do Gov.BR exige menção de ICP ou Data
            const dataStr = new Date().toLocaleString('pt-BR');
            targetPage.drawText(`Assinado em ${dataStr}`, {
                x: textX, y: lineTop - (lineHeight * 2), size: dynamicFontSize - 2, font, color: rgb(0.4, 0.4, 0.4)
            });
        }

        targetPage.drawText(`Fornecido por SERPRO-ID / ICP-Brasil`, {
            x: textX, y: lineTop - 34, size: 7, font, color: rgb(0.5, 0.5, 0.5)
        });

        // Reservando Espaço Inicial do PAdES (Campo Invisível de ByteRange) para injeção posterior na estrutura pdf-lib.
        pdflibAddPlaceholder({
            pdfDoc,
            reason: 'Assinatura Digital SERPRO-ID',
            contactInfo: 'SERPRO',
            name: subjectName,
            location: 'BR',
            signatureLength: 33000,
            // Removido `widgetRect` para forçar a tag "Invisible Signature", evitando que 
            // leitores de PDF sobreponham uma caixa "Clique para Assinar" acima dos nossos gráficos visuais
        });

        // Grava as alterações para que o formato físico seja convertido p/ injeção CMS Hex do `signpdf`
        const pdfWithPlaceholder = Buffer.from(await pdfDoc.save());

        const signer = new HardwareSigner(slotId, certDerBase64, chainB64Array);
        const signedPdf = await signpdf.sign(pdfWithPlaceholder, signer);

        return { success: true, signedBuffer: signedPdf };
    } catch (err) {
        console.error("Erro Injeção PDF:", err);
        return { success: false, error: err.message };
    }
}

module.exports = { signBuffer };
