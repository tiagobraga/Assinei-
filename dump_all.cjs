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
        
        console.log("Searching for ALL objects (no filter)...");
        pkcs11.C_FindObjectsInit(session, []);
        let obj = pkcs11.C_FindObjects(session);
        let count = 0;
        
        while(obj) { 
            count++;
            
            try {
                const classVal = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_CLASS }]);
                const objClassStr = classVal[0].value ? classVal[0].value.readUInt32LE(0) : "Unknown";
                
                let labelStr = "N/A";
                try {
                    const labelVal = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_LABEL }]);
                    if (labelVal[0].value) labelStr = labelVal[0].value.toString('utf8');
                } catch(e) {}
                
                let idHex = "N/A";
                try {
                    const idVal = pkcs11.C_GetAttributeValue(session, obj, [{ type: pkcs11js.CKA_ID }]);
                    if (idVal[0].value) idHex = idVal[0].value.toString('hex');
                } catch(e) {}
                
                console.log(`[Object ${count}] Class: ${objClassStr} | Label: ${labelStr} | CKA_ID: ${idHex}`);
            } catch(e) {
                console.log(`[Object ${count}] Error reading attributes: ${e.message}`);
            }
            
            obj = pkcs11.C_FindObjects(session);
        }
        pkcs11.C_FindObjectsFinal(session);
        
        console.log(`\nTotal objects found: ${count}`);
        pkcs11.C_CloseSession(session);
    } else {
        console.log("No slots with tokens found.");
    }
} catch (e) {
    console.error(e);
}
