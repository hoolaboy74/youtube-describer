const https = require('https');
const util = require('util');

// This script connects to a given hostname and prints its SSL certificate chain
// as seen by the Node.js runtime.

const hostname = 'texttospeech.googleapis.com';
const port = 443;

console.log(`--- Checking SSL Certificate Chain for: ${hostname} ---`);
console.log('This will show the exact certificate chain presented to this Node.js process.\n');

const options = {
    hostname: hostname,
    port: port,
    method: 'GET'
};

const req = https.request(options, res => {
    console.log(`\n--- Connection Successful (Status Code: ${res.statusCode}) ---\n`);
    res.destroy(); // We don't need the response body, just the connection.
});

req.on('socket', (socket) => {
    socket.on('secureConnect', () => {
        console.log('--- Secure TLS Connection Established ---\n');
        const cert = socket.getPeerCertificate(true);
        
        if (!cert || !cert.issuerCertificate) {
            console.error('Could not retrieve the full certificate chain.');
            return;
        }

        console.log('--- Certificate Chain Details ---\n');
        let currentCert = cert;
        let i = 0;
        while (currentCert) {
            console.log(`--- Certificate ${i} ---`);
            console.log(`Subject (CN): ${currentCert.subject.CN}`);
            console.log(`Issuer (O):   ${currentCert.issuer.O}`);
            console.log(`Issuer (CN):  ${currentCert.issuer.CN}`);
            console.log(`Valid From:   ${currentCert.valid_from}`);
            console.log(`Valid To:     ${currentCert.valid_to}`);
            console.log('---\n');

            // Check for a suspicious issuer
            if (currentCert.issuer.O && !['Google Trust Services', 'GTS', 'GlobalSign'].some(known => currentCert.issuer.O.includes(known))) {
                console.log(`>>> WARNING: Suspicious Issuer Found: "${currentCert.issuer.O}" <<<`);
                console.log('>>> This is likely the cause of the SSL error. It may be from security software on your machine. <<<');
            }

            currentCert = currentCert.issuerCertificate;
            i++;
        }
    });
});

req.on('error', (e) => {
    console.error('\n--- !!! CONNECTION FAILED !!! ---');
    console.error('The request failed before a secure connection could be established.');
    console.error('This strongly indicates something is blocking or intercepting the connection.');
    console.error('Full error details:');
    console.error(e);
});

req.end();
