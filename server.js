require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer');

const app = express();
const PORT = 3001;

// API Key from environment variable
const API_KEY = process.env.OPENAI_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
// No-cache headers for JS/HTML so browser always loads latest version
app.use((req, res, next) => {
    if (req.path.endsWith('.js') || req.path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
    }
    next();
});
app.use(express.static(path.join(__dirname, '.'))); // Serve static files from current directory

// PDF Generation Endpoint (Puppeteer-based - reliable server-side rendering)
app.post('/api/generate-pdf', async (req, res) => {
    let browser;
    const logFile = path.join(__dirname, 'pdf_log.txt');
    const log = (msg) => {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(logFile, `[${timestamp}] ${msg}\n`);
    };

    try {
        const { html, filename } = req.body;
        if (!html) {
            log("Error: No HTML content provided");
            return res.status(400).json({ error: 'No HTML content provided' });
        }

        log(`Starting PDF generation: ${filename || 'unnamed'}`);

        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu']
        });

        const page = await browser.newPage();

        // --- Logo Injection ---
        let logoDataUri = '';
        try {
            const logoPath = path.join(__dirname, 'logo.png');
            if (fs.existsSync(logoPath)) {
                const logoBuffer = fs.readFileSync(logoPath);
                
                // Detect MIME type from file signature
                let mimeType = 'image/png';
                const hex = logoBuffer.toString('hex', 0, 4).toUpperCase();
                if (hex === 'FFD8FFE0' || hex === 'FFD8FFE1') mimeType = 'image/jpeg';
                else if (hex === '47494638') mimeType = 'image/gif';
                else if (hex === '3C3F786D') mimeType = 'image/svg+xml';
                
                // Check if it's already a base64 string or binary
                let base64;
                if (logoBuffer.toString('utf8').startsWith('iVBO')) {
                    log("logo.png detected as base64 text");
                    base64 = logoBuffer.toString('utf8').trim();
                } else {
                    log(`logo.png detected as binary (${mimeType})`);
                    base64 = logoBuffer.toString('base64');
                }
                
                logoDataUri = `data:${mimeType};base64,${base64}`;
                log(`Logo Data URI successfully prepared as ${mimeType}`);
            } else {
                log("Warning: logo.png not found at root");
            }
        } catch (logoErr) {
            log(`Logo processing error: ${logoErr.message}`);
        }

        // --- HTML Wrapping & Injection ---
        let finalHtml = html;
        if (logoDataUri) {
            // Use regex to replace LOGO_PLACEHOLDER even if the browser resolved it to a full URL
            // (e.g. src="http://localhost:3001/LOGO_PLACEHOLDER")
            const logoRegex = /src=["'][^"']*LOGO_PLACEHOLDER[^"']*["']/g;
            const matches = html.match(logoRegex) || [];
            finalHtml = html.replace(logoRegex, `src="${logoDataUri}"`);
            log(`Injected logo into ${matches.length} placeholder(s) using Regex`);
        }

        // Determine if we need to wrap the HTML
        let fullHtml = finalHtml;
        if (!finalHtml.toLowerCase().includes('<html')) {
            log("Wrapping content in HTML/Body tags");
            fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: white; -webkit-print-color-adjust: exact; }
    @page { margin: 0; size: A4; }
  </style>
</head>
<body>${finalHtml}</body>
</html>`;
        } else {
            log("HTML tags detected, skipping wrapping");
        }

        await page.setContent(fullHtml, { waitUntil: 'networkidle0', timeout: 30000 });
        await page.evaluateHandle('document.fonts.ready');
        log("Page content set, fonts ready");

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        await browser.close();
        log(`PDF created successfully (${pdfBuffer.length} bytes)`);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'reporte.pdf'}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.end(pdfBuffer);

    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        log(`CRITICAL ERROR: ${error.message}`);
        console.error('PDF Generation Error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Proxy Endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { prompt, model } = req.body;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: model || "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0,
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error("OpenAI API Error:", errorText);
            let errorJson = {};
            try { errorJson = JSON.parse(errorText); } catch(ex) {}
            return res.status(response.status).json({ 
                error: (errorJson.error && errorJson.error.message) || errorText 
            });
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Server Side Error:", error);
        res.status(500).json({ error: "No se pudo conectar con el servicio de IA. Revise la conexión o configuración." });
    }
});

// Save Logo Endpoint
app.post('/api/save-logo', async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) {
            return res.status(400).json({ error: "No image data provided" });
        }

        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const filePath = path.join(__dirname, 'logo.png');

        fs.writeFile(filePath, buffer, (err) => {
            if (err) {
                console.error("Error saving logo:", err);
                return res.status(500).json({ error: "Failed to save logo" });
            }
            res.json({ success: true, message: "Logo saved successfully" });
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
