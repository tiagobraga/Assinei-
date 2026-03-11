const { fetchAiaChain, extractAiaUrl } = require('./src/backend/aiaFetcher.cjs');
const pkcs11Service = require('./src/backend/pkcs11Service.cjs');
const forge = require('node-forge');

async function testAia() {
    const result = await pkcs11Service.getCertificates();
    if (result.success && result.certs.length > 0) {
        const b64 = result.certs[0].rawDerBase64;
        const certAsn1 = forge.asn1.fromDer(Buffer.from(b64, 'base64').toString('binary'));
        const url = extractAiaUrl(certAsn1);
        console.log("Extracted URL:", url);

        if (url) {
            try {
                const chainB64 = await fetchAiaChain(url);
                console.log(`Success! Downloaded ${chainB64.length} certificates from ${url}`);
                chainB64.forEach((c, i) => {
                    const cert = forge.pki.certificateFromAsn1(forge.asn1.fromDer(Buffer.from(c, 'base64').toString('binary')));
                    console.log(`  [${i}] Subject:`, cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN')?.value);
                });
            } catch (e) {
                console.error("Fetch failed:", e);
            }
        }
    }
}

testAia();
