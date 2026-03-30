const chromium = require('@sparticuz/chromium');
const puppeteer = require('puppeteer-core');
const fs = require('fs');
const path = require('path');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { html, filename } = req.body;
    if (!html) {
        return res.status(400).json({ error: 'No HTML content provided' });
    }

    let browser;
    try {
        // Lanzamos Puppeteer configurado para la nube (Ahorra memoria y peso)
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();

        // 1. Cargamos el logo local si existe (para integrarlo mediante Base64)
        let logoDataUri = '';
        try {
            const logoPaths = [
                path.join(process.cwd(), 'logo.png'),
                path.join(__dirname, '..', 'logo.png'),
                path.join(__dirname, 'logo.png')
            ];
            for (const p of logoPaths) {
                if (fs.existsSync(p)) {
                    const logoBuffer = fs.readFileSync(p);
                    const base64 = logoBuffer.toString('base64');
                    logoDataUri = `data:image/png;base64,${base64}`;
                    break;
                }
            }
        } catch (e) {
            console.error("No se pudo cargar el logo local en la nube.");
        }

        // 2. Aplicamos la misma lógica de inyección de logo y wrapper de ECE
        let finalHtml = html;
        if (logoDataUri) {
            const logoRegex = /src=["'][^"']*LOGO_PLACEHOLDER[^"']*["']/g;
            finalHtml = html.replace(logoRegex, `src="${logoDataUri}"`);
        }

        let fullHtml = finalHtml;
        if (!finalHtml.toLowerCase().includes('<html')) {
            fullHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: white; -webkit-print-color-adjust: exact; font-family: sans-serif; }
    @page { margin: 0; size: A4; }
  </style>
</head>
<body>${finalHtml}</body>
</html>`;
        }

        // TIEMPOS ULTRA-AGRESIVOS PARA PLAN HOBBY (Límite 10s)
        await page.setContent(fullHtml, { waitUntil: 'load', timeout: 8000 });
        try {
            await page.evaluateHandle('document.fonts.ready', { timeout: 1000 });
        } catch (e) {
            // Ignoramos timeout de fuentes para priorizar la generación del PDF
        }

        // Generamos el PDF con el mismo formato A4
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '0', right: '0', bottom: '0', left: '0' }
        });

        await browser.close();

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename || 'reporte_ece.pdf'}"`);
        res.end(pdfBuffer);

    } catch (error) {
        if (browser) await browser.close().catch(() => {});
        console.error('Error de PDF en Cloud:', error);
        res.status(500).json({ error: error.message });
    }
};
