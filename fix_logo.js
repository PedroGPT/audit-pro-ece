const fs = require('fs');
const path = require('path');

const logoPath = path.join(__dirname, 'logo.png');
try {
    const content = fs.readFileSync(logoPath, 'utf8').trim();
    // Check if it looks like base64 (starts with iVBO for PNG)
    if (content.startsWith('iVBO') || content.length > 1000) {
        console.log('Detected base64 text in logo.png. Converting to binary...');
        const buffer = Buffer.from(content, 'base64');
        fs.writeFileSync(logoPath, buffer);
        console.log('Successfully converted logo.png to binary.');
    } else {
        console.log('logo.png does not appear to be base64 text or is already binary.');
    }
} catch (err) {
    console.error('Error processing logo.png:', err);
}
