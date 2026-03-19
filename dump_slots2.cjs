const pkcs11js = require('pkcs11js');

try {
    const pkcs11 = new pkcs11js.PKCS11();
    pkcs11.load('/usr/lib/libneoidp11.so');
    pkcs11.C_Initialize();
    
    // Get ALL slots, including ones without tokens present (SerproID might dynamically populate them)
    const allSlots = pkcs11.C_GetSlotList(false);
    console.log(`Total slots (false): ${allSlots.length}`);
    
    const trueSlots = pkcs11.C_GetSlotList(true);
    console.log(`Total slots (true): ${trueSlots.length}`);
    
    pkcs11.C_Finalize();
    pkcs11.close();
} catch (e) {
    console.error(e);
}
