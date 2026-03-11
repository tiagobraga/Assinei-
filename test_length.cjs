const { PDFDocument } = require('pdf-lib');
const signpdf = require('@signpdf/signpdf').default;
const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
const fs = require('fs');

async function test() {
    try {
        const pdfDoc = await PDFDocument.create();
        const page = pdfDoc.addPage();
        page.drawText('Test PDF');
        const pdfBytes = await pdfDoc.save();

        const doc = await PDFDocument.load(pdfBytes);
        pdflibAddPlaceholder({
            pdfDoc: doc,
            reason: 'Assinatura',
            signatureLength: 16384
        });
        const modifiedBytes = await doc.save();
        console.log("Placeholder adicionado com sucesso:", modifiedBytes.length);

        // Test signpdf signing
        const fakeSigner = {
            sign: async (buf) => Buffer.from('fake_signature_bytes_placeholder_for_len')
        }

        const finalPdf = await signpdf.sign(Buffer.from(modifiedBytes), fakeSigner);
        console.log("Assinatura feita, tamanho:", finalPdf.length);
    } catch (e) {
        console.error("ERRO CAPTURADO:");
        console.error(e.stack);
    }
}
test();
