const pkcs11js = require('pkcs11js');
const pkcs11Service = require('./src/backend/pkcs11Service.cjs');

try {
    pkcs11Service.loadLibrary();
    const pkcs11 = pkcs11Service.pkcs11;
    
    // Check all slots
    const allSlots = pkcs11.C_GetSlotList(false);
    console.log(`Total slots reported by driver: ${allSlots.length}`);
    
    for (let i = 0; i < allSlots.length; i++) {
        const slot = allSlots[i];
        
        let slotInfo;
        try {
            slotInfo = pkcs11.C_GetSlotInfo(slot);
            console.log(`\n--- Slot[${i}] ---`);
            console.log(`Description: ${slotInfo.slotDescription.trim()}`);
            console.log(`Token Present: ${(slotInfo.flags & pkcs11js.CKF_TOKEN_PRESENT) !== 0}`);
        } catch(e) {
            console.log(`\n--- Slot[${i}] --- (Error getting info: ${e.message})`);
            continue;
        }
        
        if ((slotInfo.flags & pkcs11js.CKF_TOKEN_PRESENT) !== 0) {
            try {
                const tokenInfo = pkcs11.C_GetTokenInfo(slot);
                console.log(`Token Label: ${tokenInfo.label.trim()}`);
            } catch(e) {}
            
            try {
                const session = pkcs11.C_OpenSession(slot, pkcs11js.CKF_RW_SESSION | pkcs11js.CKF_SERIAL_SESSION);
                
                // Read certs before login
                pkcs11.C_FindObjectsInit(session, [{ type: pkcs11js.CKA_CLASS, value: pkcs11js.CKO_CERTIFICATE }]);
                let obj = pkcs11.C_FindObjects(session);
                let countBefore = 0;
                while(obj) { countBefore++; obj = pkcs11.C_FindObjects(session); }
                pkcs11.C_FindObjectsFinal(session);
                
                console.log(`Certificates found before login: ${countBefore}`);
                
                pkcs11.C_CloseSession(session);
            } catch (e) {
                console.log(`Error reading slot ${i}: ${e.message}`);
            }
        }
    }
} catch (e) {
    console.error(e);
}
