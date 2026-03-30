const fetch = require('node-fetch');
const fs = require('fs');

async function test() {
    const html = `
        <div class="header">
            <img src="LOGO_PLACEHOLDER" class="logo">
            <h1>TEST REPORT</h1>
        </div>
        <p>This is a test of the logo injection.</p>
    `;

    try {
        console.log("Sending request to http://localhost:3001/api/generate-pdf...");
        const res = await fetch('http://localhost:3001/api/generate-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                html: html,
                filename: 'test_logo.pdf'
            })
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Server returned ${res.status}: ${err}`);
        }

        const buffer = await res.buffer();
        fs.writeFileSync('test_logo.pdf', buffer);
        console.log("Successfully generated test_logo.pdf. Check the file to see if the logo is there.");
        
        // Wait a bit then check logs
        setTimeout(() => {
            if (fs.existsSync('pdf_log.txt')) {
                console.log("\nServer Logs (pdf_log.txt):");
                console.log(fs.readFileSync('pdf_log.txt', 'utf8'));
            } else {
                console.log("\nNo server logs found. Are you sure you restarted the server?");
            }
        }, 1000);

    } catch (err) {
        console.error("Test failed:", err.message);
        console.log("\nPOSSIBLE SOLUTIONS:");
        console.log("1. Make sure you ran 'node server.js' in another terminal.");
        console.log("2. Make sure the server is on port 3001.");
    }
}

test();
