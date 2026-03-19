const forge = require('node-forge');

function test() {
    const keys = forge.pki.rsa.generateKeyPair(1024);
    const cert = forge.pki.createCertificate();
    cert.publicKey = keys.publicKey;
    cert.serialNumber = '01';
    cert.validity.notBefore = new Date();
    cert.validity.notAfter = new Date();
    cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);
    const attrs = [{ name: 'commonName', value: 'Test' }];
    cert.setSubject(attrs);
    cert.setIssuer(attrs);
    cert.sign(keys.privateKey);

    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer("TESTE");
    p7.addCertificate(cert);

    p7.addSigner({
        key: keys.privateKey,
        certificate: cert,
        digestAlgorithm: forge.pki.oids.sha256,
        authenticatedAttributes: [
            { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
            { type: forge.pki.oids.messageDigest },
            { type: forge.pki.oids.signingTime, value: new Date() }
        ]
    });

    p7.sign({ detached: true });

    const der = forge.asn1.toDer(p7.toAsn1()).getBytes();
    const asn1Obj = forge.asn1.fromDer(der);

    let msg = forge.pkcs7.messageFromAsn1(asn1Obj);
    console.log("Qtd Signers COM CHAVE REAL: ", msg.signers.length);
}
test();
