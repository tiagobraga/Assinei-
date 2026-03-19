const pkcs11js = require('pkcs11js');
const forge = require('node-forge');
const pkcs11Service = require('./src/backend/pkcs11Service.cjs');

async function dump() {
    try {
        pkcs11Service.loadLibrary();
        const slots = pkcs11Service.pkcs11.C_GetSlotList(true);
        console.log(`Found ${slots.length} slots with tokens.`);

        for (const slot of slots) {
            console.log(`\n--- Inspecting Slot ${slot.toString()} ---`);
            const session = pkcs11Service.pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);

            pkcs11Service.pkcs11.C_FindObjectsInit(session, [
                { type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE },
                { type: pkcs11js.CKA_CERTIFICATE_TYPE, value: pkcs11js.CKC_X_509 }
            ]);

            let obj = pkcs11Service.pkcs11.C_FindObjects(session);
            let count = 0;
            while (obj) {
                count++;
                try {
                    const val = pkcs11Service.pkcs11.C_GetAttributeValue(session, obj, [
                        { type: pkcs11js.CKA_VALUE }
                    ]);

                    const certDer = val[0].value;
                    if (certDer) {
                        const certAsn1 = forge.asn1.fromDer(certDer.toString('binary'));
                        const cert = forge.pki.certificateFromAsn1(certAsn1);

                        const subject = cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
                        const issuer = cert.issuer.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');

                        console.log(`\n[Certificate ${count}]`);
                        console.log(`Subject: ${subject ? subject.value : 'No CN apparent'}`);
                        console.log(`Issuer: ${issuer ? issuer.value : 'No CN apparent'}`);
                        console.log(`Serial: ${cert.serialNumber}`);
                        
                        const condition1 = subject && issuer;
                        const condition2 = subject && issuer && subject.value !== issuer.value;
                        const condition3 = subject && !subject.value.includes('Autoridade Certificadora');
                        
                        console.log(`Is Self-Signed (subj == issuer)? ${subject && issuer ? subject.value === issuer.value : 'N/A'}`);
                        console.log(`Includes 'Autoridade Certificadora' in subject? ${subject ? subject.value.includes('Autoridade Certificadora') : 'N/A'}`);
                        console.log(`Would pass current backend filter? ${condition1 && condition2 && condition3}`);
                    }
                } catch (err) {
                    console.error("Error reading cert object:", err.message);
                }
                obj = pkcs11Service.pkcs11.C_FindObjects(session);
            }
            pkcs11Service.pkcs11.C_FindObjectsFinal(session);
            pkcs11Service.pkcs11.C_CloseSession(session);
            console.log(`\nTotal certificates found in slot ${slot.toString()}: ${count}`);
        }
    } catch (e) {
        console.error("Fatal error:", e);
    }
}

dump();
