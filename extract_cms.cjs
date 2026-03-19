const fs = require('fs');
const { PDFDocument } = require('pdf-lib');
const forge = require('node-forge');

(async () => {
    try {
        const buf = fs.readFileSync('/Users/tiagobraga/Downloads/1. Resposta à Representação - IBICT_tb.pdf');
        const doc = await PDFDocument.load(buf);
        const form = doc.getForm();
        const f = form.getFields().find(f => f.constructor.name === 'PDFSignature');
        if (!f) return;

        const dict = f.acroField.dict;
        const v = dict.get(doc.context.obj('V'));
        const sigDict = doc.context.lookup(v);
        const contents = sigDict.get(doc.context.obj('Contents'));

        const hex = contents.value; // It's a hex string <...>
        const derStr = Buffer.from(hex, 'hex').toString('binary');

        const asn1 = forge.asn1.fromDer(derStr);
        const p7 = forge.pkcs7.messageFromAsn1(asn1);

        console.log('Certificates in P7:');
        p7.certificates.forEach(c => {
            console.log('  Subject:', c.subject.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(', '));
            console.log('  Issuer:', c.issuer.attributes.map(a => `${a.shortName || a.name}=${a.value}`).join(', '));
        });

        const signer = p7.signers[0];
        console.log('\nSigner Info:');
        console.log('  Digest Alg:', forge.pki.oids[signer.digestAlgorithm] || signer.digestAlgorithm);
        console.log('  Authenticated Attributes OIDs:');
        signer.authenticatedAttributes.forEach(a => console.log('    ', forge.pki.oids[a.type] || a.type));

    } catch (e) { console.error(e.message); }
})();
