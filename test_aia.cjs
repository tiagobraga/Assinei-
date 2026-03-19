const pkcs11Service = require('./src/backend/pkcs11Service.cjs');
const forge = require('node-forge');

async function checkAIA() {
    const result = await pkcs11Service.getCertificates();
    if (result.success && result.certs.length > 0) {
        const b64 = result.certs[0].rawDerBase64;
        const certAsn1 = forge.asn1.fromDer(Buffer.from(b64, 'base64').toString('binary'));
        const cert = forge.pki.certificateFromAsn1(certAsn1);

        const aiaExt = cert.getExtension('authorityInfoAccess');
        if (aiaExt) {
            console.log("Authority Information Access extension found:", aiaExt);
        } else {
            console.log("No AIA extension found.");
            console.log("All extensions:", cert.extensions.map(e => e.name || e.id));
        }
    }
}

checkAIA();
