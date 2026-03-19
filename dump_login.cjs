const pkcs11js = require('pkcs11js');
const pkcs11Service = require('./src/backend/pkcs11Service.cjs');
const forge = require('node-forge');

try {
    pkcs11Service.loadLibrary();
    const pkcs11 = pkcs11Service.pkcs11;
    const slots = pkcs11.C_GetSlotList(true);
    
    if (slots.length > 0) {
        const slot = slots[0];
        const session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);
        
        console.log("Attempting C_Login...");
        try {
            pkcs11.C_Login(session, pkcs11js.CKU_USER, "");
            console.log("Login call successful or bypassed.");
        } catch (e) {
            console.log("Login failed: " + e.message);
        }
        
        pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE }]);
        let obj = pkcs11.C_FindObjects(session);
        let count = 0;
        while(obj) { 
            count++;
            
            const val = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_VALUE }]);
            const certAsn1 = forge.asn1.fromDer(val[0].value.toString('binary'));
            const cert = forge.pki.certificateFromAsn1(certAsn1);
            const subject = cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
            console.log(`[After Login] Found Cert: ${subject ? subject.value : 'No CN'}`);

            obj = pkcs11.C_FindObjects(session);
        }
        pkcs11.C_FindObjectsFinal(session);
        
        console.log(`Total certificates found after login attempt: ${count}`);
        
        // Also check private keys
        pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_PRIVATE_KEY }]);
        let privKey = pkcs11.C_FindObjects(session);
        let privCount = 0;
        while(privKey) { privCount++; privKey = pkcs11.C_FindObjects(session); }
        pkcs11.C_FindObjectsFinal(session);
        
        console.log(`Total private keys found after login attempt: ${privCount}`);
        
        try {
            pkcs11.C_Logout(session);
        } catch(e) {}
        pkcs11.C_CloseSession(session);
    }
} catch (e) {
    console.error(e);
}
