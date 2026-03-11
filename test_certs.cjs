const pkcs11Service = require('./src/backend/pkcs11Service.cjs');

async function testFetchCerts() {
    console.log("Fetching certs...");
    const result = await pkcs11Service.getCertificates();
    if (result.success) {
        console.log(`Found ${result.certs.length} personal certificates`);
        if (result.certs.length > 0) {
            console.log(`Chain length for first cert: ${result.certs[0].chainB64.length}`);
            result.certs[0].chainB64.forEach((b64, i) => {
                const forge = require('node-forge');
                const certAsn1 = forge.asn1.fromDer(Buffer.from(b64, 'base64').toString('binary'));
                const cert = forge.pki.certificateFromAsn1(certAsn1);
                console.log(`  - [${i}] Subject:`, cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN')?.value);
                console.log(`         Issuer:`, cert.issuer.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN')?.value);
            });
        }
    } else {
        console.error(result.error);
    }
}

testFetchCerts();
