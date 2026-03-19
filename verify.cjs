const fs = require('fs');
const crypto = require('crypto');
const forge = require('node-forge');

function verifyPdfSignature(pdfPath) {
    const pdf = fs.readFileSync(pdfPath);

    // Find ByteRange
    const byteRangeRegex = /\/ByteRange\s*\[(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\]/;
    const match = pdf.toString('binary').match(byteRangeRegex);
    if (!match) {
        console.log("No ByteRange found in", pdfPath);
        return;
    }

    console.log("Validating PDF:", pdfPath);
    const byteRange = [
        parseInt(match[1]),
        parseInt(match[2]),
        parseInt(match[3]),
        parseInt(match[4])
    ];
    console.log("ByteRange:", byteRange);

    // Extract signed data
    const signedData = Buffer.concat([
        pdf.slice(byteRange[0], byteRange[0] + byteRange[1]),
        pdf.slice(byteRange[2], byteRange[2] + byteRange[3])
    ]);

    // Extract signature hex
    const sigHexRegex = /<([0-9a-fA-F]+)>/g;
    let sigHexMatch;
    let hexString = '';
    // Find the longest hex string that falls inside the gap
    let searchArea = pdf.slice(byteRange[0] + byteRange[1], byteRange[2]).toString('ascii');

    const hexMatch = searchArea.match(/<([0-9a-fA-F]+)>/);
    if (!hexMatch) {
        console.log("No signature payload found in gap.");
        return;
    }
    hexString = hexMatch[1];
    if (hexString.endsWith('000000000000000000')) {
        // Trim zeros
        hexString = hexString.replace(/0+$/, '');
        // Ensure even length
        if (hexString.length % 2 !== 0) hexString += '0';
    }
    console.log("Sig length (hex):", hexString.length);

    const der = Buffer.from(hexString, 'hex').toString('binary');
    let p7;
    try {
        const asn1 = forge.asn1.fromDer(der);
        p7 = forge.pkcs7.messageFromAsn1(asn1);
    } catch (e) {
        console.log("Error parsing PKCS7:", e.message);
        return;
    }

    console.log("Signers:", p7.signers.length);
    const signer = p7.signers[0];

    const contentDigest = p7.signers[0].authenticatedAttributes.find(a => forge.pki.oids[a.type] === 'messageDigest');
    const expectedHashForge = contentDigest ? contentDigest.value : null;
    let expectedHashHex = '';
    if (expectedHashForge) {
        expectedHashHex = forge.util.bytesToHex(expectedHashForge);
        console.log("Expected PDF Hash (from PKCS7):", expectedHashHex);
    } else {
        console.log("No messageDigest found in attributes!");
    }

    // Compute actual hash
    const hash = crypto.createHash('sha256');
    hash.update(signedData);
    const actualHashHex = hash.digest('hex');
    console.log("Actual PDF Hash   (calculated):", actualHashHex);

    if (actualHashHex === expectedHashHex) {
        console.log(">>> HASH MATCHES! Document was NOT altered.");
    } else {
        console.log(">>> HASH DOES NOT MATCH! Document corrupted or ByteRange wrong.");
    }
}

module.exports = { verifyPdfSignature };
console.log("Verifier loaded.");
