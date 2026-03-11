const fs = require('fs');

function extractDer(pdfPath, outPath) {
    const pdf = fs.readFileSync(pdfPath).toString('binary');

    const byteRangeRegex = /\/ByteRange\s*\[(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\]/;
    const match = pdf.match(byteRangeRegex);
    if (!match) {
        console.log("No ByteRange found in", pdfPath);
        return;
    }

    // As per PDF spec, the signature is EXACTLY the bytes between the two ranges.
    // The first range ends at byteRange[0] + byteRange[1]
    // The second range starts at byteRange[2]
    const gapStart = parseInt(match[1]) + parseInt(match[2]);
    const gapEnd = parseInt(match[3]);

    let searchArea = pdf.substring(gapStart, gapEnd);
    searchArea = searchArea.replace(/[^0-9A-Fa-f]/g, '');
    let hexString = searchArea.replace(/0+$/, ''); // trim padding
    if (hexString.length % 2 !== 0) hexString += '0';

    const derBuffer = Buffer.from(hexString, 'hex');
    fs.writeFileSync(outPath, derBuffer);
    console.log("Saved DER to", outPath);
}

extractDer('/Users/tiagobraga/Downloads/1. Resposta à Representação - IBICT_tb.pdf', '/Users/tiagobraga/Documents/0306_p_assinador_pdf/govbr.der');
extractDer('/Users/tiagobraga/Documents/documento_assinado_tb6.pdf', '/Users/tiagobraga/Documents/0306_p_assinador_pdf/meu.der');
