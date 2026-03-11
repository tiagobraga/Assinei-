const pkcs11js = require('pkcs11js');
const fs = require('node:fs');
const forge = require('node-forge');

const { fetchAiaChain, extractAiaUrl } = require('./aiaFetcher.cjs');

class Pkcs11Service {
    constructor() {
        this.pkcs11 = new pkcs11js.PKCS11();
        // Path padrão conhecido do SerproID no MacOS
        this.libPath = '/Applications/SerproID Desktop.app/Contents/Java/tools/macos/libneoidp11.dylib';
        this.isLoaded = false;
    }

    loadLibrary() {
        if (this.isLoaded) return true;
        if (!fs.existsSync(this.libPath)) {
            throw new Error(`Biblioteca PKCS#11 não encontrada em: ${this.libPath}. Certifique-se de que o SERPRO-ID está instalado.`);
        }
        this.pkcs11.load(this.libPath);
        this.pkcs11.C_Initialize();
        this.isLoaded = true;
        return true;
    }

    async getCertificates() {
        try {
            this.loadLibrary();
            const slots = this.pkcs11.C_GetSlotList(true); // true = slots with token present
            const certs = [];

            for (const slot of slots) {
                try {
                    const session = this.pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);

                    this.pkcs11.C_FindObjectsInit(session, [
                        { type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE },
                        { type: pkcs11js.CKA_CERTIFICATE_TYPE, value: pkcs11js.CKC_X_509 }
                    ]);

                    let obj = this.pkcs11.C_FindObjects(session);
                    let allDerCerts = [];
                    while (obj) {
                        try {
                            const val = this.pkcs11.C_GetAttributeValue(session, obj, [
                                { type: pkcs11js.CKA_VALUE },
                                { type: pkcs11js.CKA_LABEL }
                            ]);

                            const certDer = val[0].value;
                            if (certDer) {
                                allDerCerts.push(certDer.toString('base64'));
                            }
                        } catch (err) {
                            console.error("Erro ao ler objeto do certificado auxiliar:", err);
                        }
                        obj = this.pkcs11.C_FindObjects(session);
                    }
                    this.pkcs11.C_FindObjectsFinal(session);

                    // Re-processa e empacota apenas O CERTIFICADO FINAL (Subject == Nome), 
                    // mas envia toda a Array Root CA de confiança para ajudar o Adobe PDF
                    for (const certB64 of allDerCerts) {
                        const certAsn1 = forge.asn1.fromDer(Buffer.from(certB64, 'base64').toString('binary'));
                        const cert = forge.pki.certificateFromAsn1(certAsn1);

                        const subject = cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
                        const issuer = cert.issuer.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');

                        // Se o Emissor for ELE MESMO ou Autoridade Certificadora, pulamos do display inicial do Dropdown Frontend
                        // Queremos mostrar para o usuário APENAS o dele.
                        if (subject && issuer && subject.value !== issuer.value && !subject.value.includes('Autoridade Certificadora')) {

                            // Tentamos buscar as cadeias "Avós" via Internet usando a URL da Extensão AIA
                            let fullChainBase64Array = [certB64];
                            try {
                                const aiaUrl = extractAiaUrl(certAsn1);
                                if (aiaUrl) {
                                    console.log("Iniciando download da Cadeia Governamental Criptográfica:", aiaUrl);
                                    const downloadedChain = await fetchAiaChain(aiaUrl);
                                    fullChainBase64Array = fullChainBase64Array.concat(downloadedChain);
                                    console.log("Baixados com sucesso:", downloadedChain.length, "certificados pai.");
                                }
                            } catch (e) {
                                console.warn("Aviso: Falha ao tentar buscar cadeia hierárquica pelo AIA. Assinatura prosseguirá apenas com a chave raiz.", e);
                            }

                            certs.push({
                                slotId: slot.toString(),
                                label: 'Certificado',
                                subject: subject.value,
                                issuer: issuer.value,
                                validity: {
                                    notBefore: cert.validity.notBefore.toISOString(),
                                    notAfter: cert.validity.notAfter.toISOString()
                                },
                                serialNumber: cert.serialNumber,
                                rawDerBase64: certB64,
                                chainB64: fullChainBase64Array // Cadeia do Token acrescida dos Avós do ICP
                            });
                        }
                    }
                    this.pkcs11.C_CloseSession(session);
                } catch (err) {
                    console.error("Erro interno no slot PKCS#11:", err);
                }
            }

            return { success: true, certs: certs };
        } catch (error) {
            console.error("Erro PKCS#11 no loadLibrary:", error);
            return { success: false, error: error.message };
        }
    }

    close() {
        if (this.isLoaded) {
            try {
                this.pkcs11.C_Finalize();
                this.pkcs11.close();
            } catch (e) {
                console.error("Erro ao fechar lib:", e);
            }
            this.isLoaded = false;
        }
    }

    signData(slotIdStr, dataBuffer, pin = '') {
        try {
            this.loadLibrary();
            const slots = this.pkcs11.C_GetSlotList(true);
            const targetSlot = slots.find(s => s.toString() === slotIdStr);

            if (!targetSlot) throw new Error("Slot/Token não encontrado ou desconectado.");

            const session = this.pkcs11.C_OpenSession(targetSlot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);

            // Login no Token (o SERPRO-ID comumente puxa a notificação pro celular aqui ou exige PIN no middleware)
            if (pin || pin === '') {
                try {
                    this.pkcs11.C_Login(session, pkcs11js.CKU_USER, pin);
                } catch (loginErr) {
                    console.warn("Login PKCS11 (pode já estar logado):", loginErr.message);
                }
            }

            // Achar chave privada
            this.pkcs11.C_FindObjectsInit(session, [
                { type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_PRIVATE_KEY }
            ]);
            const privateKey = this.pkcs11.C_FindObjects(session);
            this.pkcs11.C_FindObjectsFinal(session);

            if (!privateKey) {
                this.pkcs11.C_CloseSession(session);
                throw new Error("Chave Privada não encontrada no token indicado.");
            }

            // Iniciar assinatura com RSA PKCS#1 Puro (O buffer recebido já conterá o pacote DigestInfo ASN.1 de Hashing)
            this.pkcs11.C_SignInit(session, { mechanism: pkcs11js.CKM_RSA_PKCS }, privateKey);

            // Assinar o Buffer recebido
            // Para RSA 2048 padrão o outBuf tem 256 bytes
            const signatureBuffer = this.pkcs11.C_Sign(session, dataBuffer, Buffer.alloc(256));

            try {
                this.pkcs11.C_Logout(session);
            } catch (e) { }
            this.pkcs11.C_CloseSession(session);

            return { success: true, signature: signatureBuffer };
        } catch (error) {
            console.error("Erro PKCS#11 em signData:", error);
            return { success: false, error: error.message };
        }
    }
}

module.exports = new Pkcs11Service();
