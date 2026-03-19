const { PDFDocument } = require('pdf-lib');
const fs = require('fs');

async function run() {
    try {
        const dummyPdf = await PDFDocument.create();
        const page = dummyPdf.addPage([200, 200]);
        
        // We will test if embedPdf exists
        console.log("embedPdf exists:", typeof dummyPdf.embedPdf === 'function');
        console.log("embedPage exists:", typeof dummyPdf.embedPage === 'function');
        console.log("embedPages exists:", typeof dummyPdf.embedPages === 'function');
    } catch(e) {
        console.error(e);
    }
}
run();
