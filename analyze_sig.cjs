const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const forge = require('node-forge');

async function analyze() {
    try {
        console.log("Iniciando leitura do arquivo...");
        const buf = fs.readFileSync('/Users/tiagobraga/Downloads/1. Resposta à Representação - IBICT_tb.pdf');
        const doc = await PDFDocument.load(buf);
        const form = doc.getForm();
        const fields = form.getFields();

        let sigField = null;
        for (const f of fields) {
            if (f.constructor.name === 'PDFSignature') {
                sigField = f;
                console.log("Assinatura encontrada:", f.getName());
                break;
            }
        }

        if (!sigField) {
            console.log("Nenhuma assinatura encontrada no formulario.");
            return;
        }

        const dict = sigField.acroField.dict;
        const v = dict.get(doc.context.obj('V'));
        if (!v) {
            console.log("Sem dicionario V.");
            return;
        }

        const sigDict = doc.context.lookup(v);
        console.log("Filter:", sigDict.get(doc.context.obj('Filter'))?.toString());
        console.log("SubFilter:", sigDict.get(doc.context.obj('SubFilter'))?.toString());
        console.log("Name:", sigDict.get(doc.context.obj('Name'))?.toString());

        const contents = sigDict.get(doc.context.obj('Contents'));
        if (contents) {
            let hex = contents.value;
            // PDFHexString pode ter < > em volta
            if (hex.startsWith('<') && hex.endsWith('>')) {
                hex = hex.substring(1, hex.length - 1);
            }
            console.log("Tamanho do HEX da assinatura:", hex.length);

            try {
                const der = Buffer.from(hex, 'hex').toString('binary').replace(/\0+$/, '');
                const asn1 = forge.asn1.fromDer(der);
                const p7 = forge.pkcs7.messageFromAsn1(asn1);

                console.log("Certificados embutidos:", p7.certificates.length);
                p7.certificates.forEach((c, idx) => {
                    const subjectCN = c.subject.attributes.find(a => a.shortName === 'CN' || a.name === 'commonName');
                    const issuerCN = c.issuer.attributes.find(a => a.shortName === 'CN' || a.name === 'commonName');
                    console.log(`  [${idx}] Subject:`, subjectCN ? subjectCN.value : 'N/A');
                    console.log(`  [${idx}] Issuer:`, issuerCN ? issuerCN.value : 'N/A');
                });

                if (p7.signers && p7.signers.length > 0) {
                    const signer = p7.signers[0];
                    console.log("\nDigest Algorithm:", forge.pki.oids[signer.digestAlgorithm] || signer.digestAlgorithm);
                    console.log("Atributos autenticados (PKCS#9):");
                    signer.authenticatedAttributes.forEach(a => {
                        console.log("  -", forge.pki.oids[a.type] || a.type, "(valor:", a.value ? JSON.stringify(a.value) : "complexo", ")");
                    });
                }
            } catch (e) {
                console.log("Erro ao parsear ASN1/PKCS7 interno:", e.message);
            }
        }

    } catch (e) {
        console.error("Erro fatal:", e);
    }
}
analyze();
