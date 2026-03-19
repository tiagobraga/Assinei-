const pkcs11js = require('pkcs11js');
const forge = require('node-forge');

try {
    const pkcs11 = new pkcs11js.PKCS11();
    pkcs11.load('/usr/lib/libneoidp11.so');
    pkcs11.C_Initialize();
    
    // Test without filtering for token present
    const allSlots = pkcs11.C_GetSlotList(false);
    console.log(`Total slots (including empty): ${allSlots.length}`);
    
    let totalCerts = 0;
    for (const slot of allSlots) {
        console.log(`\n--- Inspecting Slot ${slot.toString()} ---`);
        try {
            const slotInfo = pkcs11.C_GetSlotInfo(slot);
            console.log(`Description: ${slotInfo.slotDescription.trim()}`);
            console.log(`Token Present: ${(slotInfo.flags & pkcs11js.CKF_TOKEN_PRESENT) !== 0}`);
            
            if ((slotInfo.flags & pkcs11js.CKF_TOKEN_PRESENT) !== 0) {
                const session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);
                
                // Try logging in generically
                try {
                    pkcs11.C_Login(session, pkcs11js.CKU_SO, "");
                    console.log("Logged in as SO.");
                } catch(e) {}
                
                try {
                    pkcs11.C_Login(session, pkcs11js.CKU_USER, "");
                    console.log("Logged in as USER.");
                } catch(e) {}
                
                pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE }]);
                let obj = pkcs11.C_FindObjects(session);
                let count = 0;
                while(obj) { 
                    count++;
                    try {
                        const val = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_VALUE }, { type: pkcs11js.CKA_LABEL }]);
                        const certAsn1 = forge.asn1.fromDer(val[0].value.toString('binary'));
                        const cert = forge.pki.certificateFromAsn1(certAsn1);
                        const subject = cert.subject.attributes.find(a => a.name === 'commonName' || a.shortName === 'CN');
                        console.log(` Cert ${count}: Subj= ${subject ? subject.value : '?'} | Label= ${val[1].value ? val[1].value.toString() : '?'}`);
                    } catch(e) {}
                    obj = pkcs11.C_FindObjects(session);
                }
                pkcs11.C_FindObjectsFinal(session);
                
                console.log(`Certificates found: ${count}`);
                totalCerts += count;
                pkcs11.C_CloseSession(session);
            }
        } catch(e) {
            console.log("Error querying slot:", e.message);
        }
    }
    
    console.log(`\nGrand Total Certs across all slots: ${totalCerts}`);
    
    pkcs11.C_Finalize();
    pkcs11.close();
} catch (e) {
    console.error(e);
}
