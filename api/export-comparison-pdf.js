import chromium from '@sparticuz/chromium';
import playwright from 'playwright-core';

export const config = {
    api: {
        bodyParser: {
            sizeLimit: '8mb'
        }
    }
};

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Enviar POST' });

    const html = String(req.body?.html || '').trim();
    if (!html) {
        return res.status(400).json({ error: 'Falta el HTML del informe' });
    }

    let browser = null;
    try {
        const executablePath = await chromium.executablePath();
        browser = await playwright.chromium.launch({
            args: chromium.args,
            executablePath,
            headless: chromium.headless
        });

        const page = await browser.newPage({ viewport: { width: 1280, height: 1810 } });
        await page.setContent(html, { waitUntil: 'networkidle' });
        await page.emulateMedia({ media: 'print' });

        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            preferCSSPageSize: true,
            margin: {
                top: '8mm',
                right: '8mm',
                bottom: '8mm',
                left: '8mm'
            }
        });

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Cache-Control', 'no-store, max-age=0');
        return res.status(200).send(Buffer.from(pdfBuffer));
    } catch (err) {
        console.error('[export-comparison-pdf] Error generando PDF:', err);
        return res.status(500).json({ error: 'No se pudo generar el PDF', details: err.message });
    } finally {
        if (browser) {
            try {
                await browser.close();
            } catch {
                // noop
            }
        }
    }
}