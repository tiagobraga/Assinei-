const pkcs11js = require('pkcs11js');
const forge = require('node-forge');

try {
    const pkcs11 = new pkcs11js.PKCS11();
    pkcs11.load('/usr/lib/x86_64-linux-gnu/p11-kit-proxy.so');
    pkcs11.C_Initialize();
    
    const slots = pkcs11.C_GetSlotList(true);
    console.log(`Total active slots on p11-kit proxy: ${slots.length}`);
    
    let totalCerts = 0;
    for (const slot of slots) {
        console.log(`\n--- Slot ${slot.toString()} ---`);
        try {
            const tokenInfo = pkcs11.C_GetTokenInfo(slot);
            console.log(`Label: ${tokenInfo.label.trim()}`);
            
            const session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);
            
            pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE }]);
            let obj = pkcs11.C_FindObjects(session);
            let count = 0;
            while(obj) { 
                count++;
                try {
                    const val = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_VALUE }]);
                    const certAsn1 = forge.asn1.fromDer(val[0].value.toString('binary'));
                    const cert = forge.pki.certificateFromAsn1(certAsn1);
                    const subject = cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
                    const issuer = cert.issuer.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
                    console.log(` Cert ${count}: Subj= ${subject ? subject.value : '?'} | Iss= ${issuer ? issuer.value : '?'}`);
                } catch(e) {}
                obj = pkcs11.C_FindObjects(session);
            }
            pkcs11.C_FindObjectsFinal(session);
            
            console.log(`Certificates found: ${count}`);
            totalCerts += count;
            pkcs11.C_CloseSession(session);
            
        } catch(e) {
            console.log("Error querying slot:", e.message);
        }
    }
    
    console.log(`\nGrand Total Certs: ${totalCerts}`);
    
    pkcs11.C_Finalize();
    pkcs11.close();
} catch (e) {
    console.error(e);
}
