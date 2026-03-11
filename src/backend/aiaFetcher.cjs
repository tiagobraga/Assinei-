const http = require('http');
const https = require('https');
const forge = require('node-forge');

async function fetchAiaChain(aiaUrl) {
    return new Promise((resolve, reject) => {
        const client = aiaUrl.startsWith('https') ? https : http;
        client.get(aiaUrl, (res) => {
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch AIA: ${res.statusCode}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                try {
                    const data = Buffer.concat(chunks);
                    // Parse p7b (PKCS#7)
                    const asn1 = forge.asn1.fromDer(data.toString('binary'));
                    const msg = forge.pkcs7.messageFromAsn1(asn1);
                    const b64Certs = msg.certificates.map(cert => {
                        const der = forge.pki.certificateToAsn1(cert);
                        return forge.util.encode64(forge.asn1.toDer(der).getBytes());
                    });
                    resolve(b64Certs);
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

function extractAiaUrl(certAsn1) {
    const cert = forge.pki.certificateFromAsn1(certAsn1);
    const aiaExt = cert.getExtension('authorityInfoAccess');
    if (aiaExt && aiaExt.value) {
        // Try to match a URL in the raw value string
        const match = aiaExt.value.match(/http:\/\/[^\s\x00]+/);
        if (match) {
            return match[0];
        }
    }
    return null;
}

module.exports = { fetchAiaChain, extractAiaUrl };
