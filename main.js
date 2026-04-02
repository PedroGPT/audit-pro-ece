/**
 * AUDIT PRO ENERGÍA - SISTEMA INTEGRAL DE AUDITORÍA ELÉCTRICA
 * Versión Profesional Completa - Restauración de Ingeniería
 * -----------------------------------------------------------
 * - Módulo de Ingeniería: Peajes y Cargos BOE 2024/2025 (P1-P6)
 * - Módulo Visual: PDF.js Engine con Renderizado en Canvas
 * - Módulo Cloud: Supabase Real-time Sync & Historical Database
 * - Módulo Drive: Google Drive Picker API & OAuth2 Integration
 * - Módulo IA: Extracción avanzada mediante OpenAI
 */

// ========================================================================
// 1. CONFIGURACIÓN, CREDENCIALES Y CONSTANTES DE SEGURIDAD
// ========================================================================
const DEVELOPER_KEY = 'AIzaSyACZ4t052cFJU_Nw1rJ0c5w-MjOkQ538n8';
const CLIENT_ID = '401814876123-0h2kp6oj36p1oiugodc8vgacohmf8ibo.apps.googleusercontent.com';
const APP_ID = '401814876123';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

const SUPABASE_URL = 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';

// ========================================================================
// 2. ESTADO GLOBAL DE LA APLICACIÓN (STATE MANAGEMENT)
// ========================================================================
let tokenClient;
let gapiInited = false;
let gisInited = false;
let invoices = []; 
let dbInvoices = []; 
let currentAudit = null;
let supabaseClient = null;
let modalGuardUntil = { detail: 0, commercializer: 0, compareSelector: 0, clientSupply: 0 };
let clientSupplyRows = [];
let currentClientSupplyPdfUrl = null;

// Mapa para mantener los objetos File en memoria para el visor de PDF
window.pendingPdfFiles = new Map();

// ========================================================================
// 3. MOTOR DE INGENIERÍA: CONSTANTES TÉCNICAS BOE (6 PERIODOS)
// ========================================================================
const BOE = {
    // Peajes y Cargos de Potencia (P1 a P6) - €/kW/año
    power: {
        peajes: [0.063851, 0.003157, 0.002016, 0.001716, 0.001601, 0.001509],
        cargos: [0.004124, 0.000431, 0.000287, 0.000227, 0.000192, 0.000183]
    },
    // Peajes y Cargos de Energía (P1 a P6) - €/kWh
    energy: {
        peajes: [0.030588, 0.024765, 0.015031, 0.010178, 0.008434, 0.006256],
        cargos: [0.028766, 0.019432, 0.009021, 0.004561, 0.003412, 0.002134]
    },
    taxes: {
        iee: 0.0511269, // Impuesto Especial Eléctrico (5.11269%)
        iva: 0.21,      // IVA General 21% (tasa)
        ivaFactor: 1.21, // Multiplicador 1+IVA para usar en descuentos/recálculo inverso
        ivaReducido: 0.10, // IVA reducido 10% (tasa)
        ivaReducidoFactor: 1.10 // Multiplicador 1+IVA reducido
    },
    penalties: {
        reactiva: 0.041554, // Coste kVArh penalizable
        excesosCoef: 1.4064, // Coeficiente K para excesos de potencia
        cosPhiThreshold: 0.95 // Umbral de penalización reactiva
    }
};

// Base de datos de precios de referencia para comparativas
const MARKET_BENCHMARK = {
    "fenie": { 
        name: "Fenie Energía", 
        energy: [0.1285, 0.1082, 0.0981, 0.0881, 0.0881, 0.0881], 
        power: [0.0365, 0.0051, 0.0042, 0.0031, 0.0031, 0.0031]
    },
    "repsol": { 
        name: "Repsol", 
        energy: [0.1350, 0.1150, 0.1050, 0.0950, 0.0950, 0.0950], 
        power: [0.0382, 0.0061, 0.0051, 0.0041, 0.0041, 0.0041]
    }
};

// ========================================================================
// 4. INICIALIZACIÓN DE COMPONENTES (CLOUD & AUTH)
// ========================================================================
async function initApp() {
    console.log("[System] Lanzando Suite de Auditoría Eléctrica Profesional...");
    if (window.supabase) {
        supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
        console.log("Supabase Cloud Sync: CONNECTED ✓");
    }
    loadLocalStore();
}

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => {
        v.classList.add('hidden');
        v.style.display = 'none';
    });
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.remove('hidden');
        target.style.display = 'block';
    }
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
    });
}

function parseSpanishNumber(value) {
    if (value === null || value === undefined) return 0;
    const str = String(value).trim().replace(/\s+/g, '');
    if (!str) return 0;

    // Caso mixto ES: 1.234,56
    if (str.includes('.') && str.includes(',')) {
        return Number(str.replace(/\./g, '').replace(/,/g, '.')) || 0;
    }

    // Caso ES simple: 123,45
    if (str.includes(',')) {
        return Number(str.replace(/,/g, '.')) || 0;
    }

    // Caso IA/EN: 0.097553
    return Number(str) || 0;
}

function parsePeriodValue(value) {
    if (value === null || value === undefined) return 0;
    if (typeof value === 'number') return value >= 1 && value <= 6 ? value : 0;
    const match = String(value).match(/[1-6]/);
    return match ? Number(match[0]) : 0;
}

function firstPositiveNumber(...values) {
    for (const v of values) {
        const n = parseSpanishNumber(v);
        if (n > 0) return n;
    }
    return 0;
}

function detectComercializadoraFromText(text) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();

    const known = [
        'endesa', 'iberdrola', 'naturgy', 'repsol', 'totalenergies',
        'edp', 'holaluz', 'factorenergia', 'audax', 'fenie'
    ];

    const hit = known.find(name => lower.includes(name));
    if (hit) return hit.toUpperCase();

    const labelMatch = lower.match(/(?:comercializadora|compa(?:ñ|n)i?a|empresa)\s*[:\-]?\s*([a-z0-9áéíóúüñ\s\.,\-]{3,80})/i);
    if (labelMatch) return labelMatch[1].trim().toUpperCase();

    return 'N/D';
}

async function generatePdfPagePreviews(pdf, maxPages = 8) {
    try {
        const totalPages = Number(pdf?.numPages || 0);
        const pagesToRender = Math.min(totalPages, maxPages);
        const previews = [];

        for (let i = 1; i <= pagesToRender; i++) {
            const page = await pdf.getPage(i);
            const viewport = page.getViewport({ scale: 1.4 });
            const canvas = document.createElement('canvas');
            const context = canvas.getContext('2d');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            await page.render({ canvasContext: context, viewport }).promise;
            previews.push(canvas.toDataURL('image/png'));
        }

        return previews;
    } catch (err) {
        console.warn('[Preview] No se pudo generar previsualizacion de factura:', err);
        return [];
    }
}

async function renderPdfFileAllPages(file, container) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const pagesHtml = [];

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        await page.render({ canvasContext: context, viewport }).promise;

        pagesHtml.push(`
            <div style="margin-bottom: 1rem;">
                <div style="font-size:0.85rem; color:#64748b; margin-bottom:0.25rem;">Pagina ${i}/${pdf.numPages}</div>
                ${canvas.outerHTML}
            </div>
        `);
    }

    container.innerHTML = `<div style="display:flex; flex-direction:column; align-items:center;">${pagesHtml.join('')}</div>`;
}

function detectTariffTypeFromText(text) {
    const raw = String(text || '');
    const lower = raw.toLowerCase();

    // Patrones frecuentes en facturas: 2.0TD, 3.0A, 6.1TD, etc.
    const match = lower.match(/(?:tarifa|peaje|acceso|tipo\s*de\s*tarifa)?\s*[:\-]?\s*(2\.0\s*td|2\.0|3\.0\s*a?|3\.0|6\.1\s*td|6\.1)/i);
    if (match) {
        const normalized = match[1].replace(/\s+/g, '').toUpperCase();
        if (normalized.startsWith('2.0')) return '2.0';
        if (normalized.startsWith('3.0')) return '3.0';
        if (normalized.startsWith('6.1')) return '6.1';
    }

    if (/\b2\.0\b|\b2\.0td\b/.test(lower)) return '2.0';
    if (/\b3\.0\b|\b3\.0a\b|\b3\.0td\b/.test(lower)) return '3.0';
    if (/\b6\.1\b|\b6\.1td\b/.test(lower)) return '6.1';

    return 'N/D';
}

function getActivePeriodsByTariff(tariffType, energyItems = []) {
    const t = String(tariffType || '').trim();
    if (t === '2.0') return [1, 2, 3];

    // Para 3.0 y 6.1 no se inventan periodos: usar solo los detectados en factura.
    const detected = (energyItems || [])
        .filter(item => Number(item.kwh || 0) > 0)
        .map(item => Number(item.period || 0))
        .filter(p => p >= 1 && p <= 6);

    return [...new Set(detected)].sort((a, b) => a - b);
}

function sortTariffValue(tariffType) {
    const order = { '2.0': 1, '3.0': 2, '6.1': 3 };
    return order[String(tariffType || '')] || 99;
}

function getConfiguredEnergyPeriodsByTariff(tariffType) {
    const t = String(tariffType || '').trim();
    if (t === '2.0') return [1, 2, 3];
    if (t === '3.0' || t === '6.1') return [1, 2, 3, 4, 5, 6];
    return [1, 2, 3, 4, 5, 6];
}

function getConfiguredPowerPeriodsByTariff(tariffType) {
    const t = String(tariffType || '').trim();
    if (t === '2.0') return [1, 2];
    if (t === '3.0' || t === '6.1') return [1, 2, 3, 4, 5, 6];
    return [1, 2, 3, 4, 5, 6];
}

function extractEnergyPeriodItems(text) {
    const raw = String(text || '').replace(/×/g, '*').replace(/x/g, '*');
    const byPeriod = {};

    // Prioridad 1: patrón completo Pn: xxx kWh * yyy €/kWh
    const fullRe = /P\s*([1-6])\s*:\s*(\d+[\d\.,]*)\s*kwh\s*[*]\s*(\d+[\d\.,]*)\s*(?:€\s*)?\/?\s*kwh/gi;
    let m;
    while ((m = fullRe.exec(raw)) !== null) {
        const period = Number(m[1]);
        const kwh = parseSpanishNumber(m[2]);
        const unitPriceKwh = parseSpanishNumber(m[3]);
        // Mantener la primera aparición (normalmente "importe por energía consumida")
        if (!byPeriod[period]) {
            byPeriod[period] = { period, kwh, unitPriceKwh };
        }
    }

    // Prioridad 2: OCR roto (buscar Pn y luego kWh/precio en ventana cercana)
    if (Object.keys(byPeriod).length === 0) {
        const pRe = /P\s*([1-6])\s*:/gi;
        let pMatch;
        while ((pMatch = pRe.exec(raw)) !== null) {
            const period = Number(pMatch[1]);
            const window = raw.slice(pMatch.index, pMatch.index + 140);
            const kwhMatch = window.match(/(\d+[\d\.,]*)\s*kwh/i);
            const priceMatch = window.match(/(\d+[\d\.,]*)\s*(?:€\s*)?\/?\s*kwh/i);
            const kwh = kwhMatch ? parseSpanishNumber(kwhMatch[1]) : 0;
            const unitPriceKwh = priceMatch ? parseSpanishNumber(priceMatch[1]) : 0;
            if (kwh > 0) byPeriod[period] = { period, kwh, unitPriceKwh };
        }
    }

    return Object.values(byPeriod).sort((a, b) => a.period - b.period);
}

function extractTollPeriodItems(text) {
    const raw = String(text || '').replace(/×/g, '*').replace(/x/g, '*');
    const blockMatch = raw.match(/coste\s+de\s+peajes\s+de\s+transporte\s*,?\s*distribuci[oó]n\s+y\s+cargos?\s*:?([\s\S]{0,2200}?)(?:alquiler|otros\s+conceptos|impuesto\s+de\s+electricidad|total\s+factura|informaci[oó]n\s+adicional|$)/i);
    const scoped = blockMatch ? blockMatch[1] : raw;

    const byPeriod = {};
    const re = /P\s*([1-6])\s*:?\s*(\d+[\d\.,]*)\s*kwh\s*[*]\s*(\d+[\d\.,]*)\s*(?:€\s*)?\/?\s*kwh/gi;
    let m;
    while ((m = re.exec(scoped)) !== null) {
        const period = Number(m[1]);
        const kwh = parseSpanishNumber(m[2]);
        const unitPriceKwh = parseSpanishNumber(m[3]);
        if (!byPeriod[period]) {
            byPeriod[period] = { period, kwh, unitPriceKwh };
        }
    }

    // Fallback OCR: Pn seguido de precio /kWh aunque falten separadores
    if (Object.keys(byPeriod).length === 0) {
        const pRe = /P\s*([1-6])\s*:?/gi;
        let pMatch;
        while ((pMatch = pRe.exec(scoped)) !== null) {
            const period = Number(pMatch[1]);
            const window = scoped.slice(pMatch.index, pMatch.index + 180);
            const kwhMatch = window.match(/(\d+[\d\.,]*)\s*kwh/i);
            const priceMatch = window.match(/(\d+[\d\.,]*)\s*(?:€\s*)?\/?\s*kwh/i);
            if (kwhMatch && priceMatch) {
                byPeriod[period] = {
                    period,
                    kwh: parseSpanishNumber(kwhMatch[1]),
                    unitPriceKwh: parseSpanishNumber(priceMatch[1])
                };
            }
        }
    }

    return Object.values(byPeriod).sort((a, b) => a.period - b.period);
}

function extractPowerPeriodItems(text) {
    const raw = String(text || '').replace(/×/g, '*').replace(/x/g, '*');
    const byPeriod = {};
    const re = /P\s*([1-6])\s*:\s*(\d+[\d\.,]*)\s*kw\s*[*]\s*(\d+[\d\.,]*)\s*(?:€\s*)?\/?\s*kw/gi;
    let m;
    while ((m = re.exec(raw)) !== null) {
        const period = Number(m[1]);
        const kw = parseSpanishNumber(m[2]);
        const unitPriceKw = parseSpanishNumber(m[3]);
        byPeriod[period] = { period, kw, unitPriceKw };
    }

    return Object.values(byPeriod).sort((a, b) => a.period - b.period);
}

function validateMandatoryTolls(inv) {
    const energyPeriods = (inv.energyPeriodItems || []).filter(item => Number(item.kwh || 0) > 0);
    const tollPeriods = (inv.tollPeriodItems || []).filter(item => Number(item.unitPriceKwh || 0) > 0);

    const missing = energyPeriods
        .filter(e => !tollPeriods.some(t => t.period === e.period))
        .map(e => e.period)
        .sort((a, b) => a - b);

    inv._missingTollPeriods = missing;
    inv._hasMandatoryTolls = missing.length === 0 && energyPeriods.length > 0;
    return inv._hasMandatoryTolls;
}

function normalizeEnergyAndTolls(inv) {
    const energyInput = (inv.energyPeriodItems || []).filter(item => Number(item.period) >= 1 && Number(item.period) <= 6);
    const tollInput = (inv.tollPeriodItems || []).filter(item => Number(item.period) >= 1 && Number(item.period) <= 6);

    const energyByPeriod = {};
    const tollByPeriod = {};

    // Mantener peajes válidos existentes
    tollInput.forEach(item => {
        const period = Number(item.period);
        const price = Number(item.unitPriceKwh || 0);
        const kwh = Number(item.kwh || 0);
        if (price > 0) {
            if (!tollByPeriod[period] || price < tollByPeriod[period].unitPriceKwh) {
                tollByPeriod[period] = { period, kwh, unitPriceKwh: price };
            }
        }
    });

    // Consolidar energía e inferir peajes cuando IA mezcla ambas en energyPeriodItems
    for (let period = 1; period <= 6; period++) {
        const candidates = energyInput
            .filter(item => Number(item.period) === period && Number(item.kwh || 0) > 0 && Number(item.unitPriceKwh || 0) > 0)
            .sort((a, b) => Number(b.unitPriceKwh || 0) - Number(a.unitPriceKwh || 0));

        if (candidates.length === 0) continue;

        const mainEnergy = candidates[0];
        energyByPeriod[period] = {
            period,
            kwh: Number(mainEnergy.kwh || 0),
            unitPriceKwh: Number(mainEnergy.unitPriceKwh || 0)
        };

        if (!tollByPeriod[period] && candidates.length > 1) {
            const inferredToll = candidates[candidates.length - 1];
            tollByPeriod[period] = {
                period,
                kwh: Number(inferredToll.kwh || 0),
                unitPriceKwh: Number(inferredToll.unitPriceKwh || 0)
            };
        }
    }

    inv.energyPeriodItems = Object.values(energyByPeriod).sort((a, b) => a.period - b.period);
    inv.tollPeriodItems = Object.values(tollByPeriod).sort((a, b) => a.period - b.period);
}

// ========================================================================
// 5. MOTOR DE PROCESAMIENTO DE ARCHIVOS (AUDITORÍA IA CON OPENAI)
// ========================================================================
async function processFiles(files) {
    const loading = document.getElementById('loading');
    if (loading) loading.classList.remove('hidden');

    let rejectedByMissingTolls = 0;

    for (const file of files) {
        try {
            console.log(`[Auditor] Analizando documento: ${file.name}`);
            window.pendingPdfFiles.set(file.name, file);
            
            const arrayBuffer = await file.arrayBuffer();
            const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
            
            let fullText = "";
            for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const textContent = await page.getTextContent();
                fullText += textContent.items.map(item => item.str).join(" ") + "\n";
            }

            const invoicePreviewPages = await generatePdfPagePreviews(pdf, 8);
            
            console.log(`[PDF] Texto extraído (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");

            // Extracción con IA (Configurado para tu OpenAI Key en el backend)
            let auditData = await runExtractionIA(fullText, file.name);
            if (!auditData) {
                console.warn('No hay datos IA para', file.name, '- aplicando fallback local.');
                auditData = fallbackParseInvoiceText(fullText, file.name);
            }

            // Regla de negocio obligatoria: no pasar facturas sin peajes por periodo
            const hasMandatoryTolls = validateMandatoryTolls(auditData);
            if (!hasMandatoryTolls) {
                const missingText = (auditData._missingTollPeriods || []).map(p => `P${p}`).join(', ') || 'todos';
                auditData._auditStatus = `RECHAZADA - faltan peajes (${missingText})`;
                rejectedByMissingTolls += 1;
                console.warn(`[REGLA] Factura rechazada por peajes faltantes: ${file.name} | ${missingText}`);
            }

            console.log(`[Result] Datos extraídos:`, auditData);
            auditData.invoicePreviewPages = invoicePreviewPages;
            auditData.invoicePreview = invoicePreviewPages[0] || null;
            auditData.invoicePreviewTotalPages = Number(pdf.numPages || 0);
            auditData.invoicePreviewRenderedPages = invoicePreviewPages.length;
            invoices.push(auditData);

            // Siempre guardar en historial local (incluidas rechazadas)
            saveToDatabase([auditData]);

            // Solo sincronizar cloud si cumple la regla de peajes obligatorios
            if (hasMandatoryTolls) {
                await cloudSync(auditData);
            }
        } catch (e) {
            console.error(`[Fatal] Error crítico en archivo ${file.name}:`, e);
        }
    }

    if (invoices.length > 0) {
        renderAuditDashboard();
        renderClients();
        switchView('audit-view');
        // Mostrar el dashboard después del procesamiento
        const dashboard = document.getElementById('dashboard');
        if (dashboard) dashboard.classList.remove('hidden');
    }

    if (rejectedByMissingTolls > 0) {
        alert(`Se rechazaron ${rejectedByMissingTolls} factura(s) por no incluir peajes por periodo. Ninguna factura puede pasar sin peajes.`);
    }

    if (loading) loading.classList.add('hidden');
}

async function runExtractionIA(text, fileName) {
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ 
                engine: 'openai',
                prompt: `Actúa como auditor energético. Extrae de este texto los siguientes campos en un JSON:
                invoiceNum, cups, period, clientName, supplyAddress, powerCost, energyCost, othersCost, alquiler, reactiveCost,
                comercializadora, tariffType (2.0, 3.0 o 6.1), electricityTax, igicTax, ivaTax, total,
                consumptionItems (array de 6 números P1..P6),
                energyPeriodItems (array [{period,kwh,unitPriceKwh}]),
                powerPeriodItems (array [{period,kw,unitPriceKw,days}]) donde days son los dias del periodo de facturacion,
                tollPeriodItems (array [{period,kwh,unitPriceKwh}]) del bloque "coste de peajes de transporte, distribución y cargos".
                Incluye only JSON válido, sin explicaciones extra.
                Texto: ${text.substring(0, 12000)}` 
            })
        });

        if (!response.ok) throw new Error("La pasarela IA de Vercel no ha respondido.");
        
        const data = await response.json();
        let content = data.choices ? data.choices[0].message.content : data;
        let inv = typeof content === 'string' ? JSON.parse(content.replace(/```json\n?|```/g, '').trim()) : content;

        // Completar campos adicionales del JSON IA
        inv.invoiceNum = inv.invoiceNum || inv.factura || inv.invoice || 'S/N';
        inv.clientName = inv.clientName || inv.customerName || inv.cliente || 'Desconocido';
        inv.comercializadora = inv.comercializadora || inv.provider || inv.vendedor || inv.company || inv.distribuidora || inv.operador || detectComercializadoraFromText(text);
        inv.tariffType = inv.tariffType || inv.tarifa || inv.tariff || inv.tipoTarifa || detectTariffTypeFromText(text);
        inv.supplyAddress = inv.supplyAddress || inv.address || inv.direccion || 'N/D';
        inv.cups = inv.cups || inv.CUPS || 'N/D';
        inv.period = inv.period || inv.periodo || 'N/D';

        // Si el modelo da items por periodo guardarlos
        inv.energyPeriodItems = (inv.energyPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kwh: firstPositiveNumber(item.kwh, item.consumption, item.consumo),
            unitPriceKwh: firstPositiveNumber(item.unitPriceKwh, item.unitPrice, item.priceKwh, item.price, item.precio)
        })).filter(item => item.period >= 1 && item.period <= 6);

        inv.powerPeriodItems = (inv.powerPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kw: firstPositiveNumber(item.kw, item.powerKw, item.potencia),
            unitPriceKw: firstPositiveNumber(item.unitPriceKw, item.unitPrice, item.priceKw, item.price, item.precio),
            days: item.days || item.dias || item.numDays || null
        })).filter(item => item.period >= 1 && item.period <= 6);

        const tollFromIA = (inv.tollPeriodItems || inv.tollsPeriodItems || inv.peajesPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kwh: firstPositiveNumber(item.kwh, item.consumption, item.consumo),
            unitPriceKwh: firstPositiveNumber(item.unitPriceKwh, item.unitPrice, item.priceKwh, item.price, item.peajePrice, item.precioPeaje, item.precio)
        })).filter(item => item.period >= 1 && item.period <= 6);

        if (inv.energyPeriodItems.length === 0) {
            inv.energyPeriodItems = extractEnergyPeriodItems(text);
            inv._energyPeriodsSource = inv.energyPeriodItems.length > 0 ? 'regex' : 'none';
        } else {
            inv._energyPeriodsSource = 'openai';
        }
        if (inv.powerPeriodItems.length === 0) {
            inv.powerPeriodItems = extractPowerPeriodItems(text);
            inv._powerPeriodsSource = inv.powerPeriodItems.length > 0 ? 'regex' : 'none';
        } else {
            inv._powerPeriodsSource = 'openai';
        }

        if (tollFromIA.length > 0) {
            inv.tollPeriodItems = tollFromIA;
            inv._tollPeriodsSource = 'openai';
        } else {
            inv.tollPeriodItems = extractTollPeriodItems(text);
            inv._tollPeriodsSource = inv.tollPeriodItems.length > 0 ? 'regex' : 'none';
        }

        normalizeEnergyAndTolls(inv);

        console.log('[Debug] Toll extraction', {
            source: inv._tollPeriodsSource,
            tollFromIA,
            tollFinal: inv.tollPeriodItems,
            energyPeriods: inv.energyPeriodItems
        });

        inv.consumptionItems = (inv.consumptionItems || inv.p1p6 || inv.periods || []).map(x => Number(x) || 0);
        if (inv.energyPeriodItems.length > 0) {
            const periods = [0, 0, 0, 0, 0, 0];
            inv.energyPeriodItems.forEach(item => {
                periods[item.period - 1] = item.kwh;
            });
            inv.consumptionItems = periods;
        }
        inv.consumption = (inv.consumptionItems || []).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        inv.energyUnitPriceAvg = inv.consumption > 0 ? ((parseFloat(inv.energyCost) || 0) / inv.consumption) : 0;

        // En caso de que IA entregue totales directos
        inv.electricityTax = parseFloat(inv.electricityTax || 0);
        inv.igicTax = parseFloat(inv.igicTax || 0);
        inv.ivaTax = parseFloat(inv.ivaTax || 0);

        const baseFromCosts = (parseFloat(inv.energyCost) || 0) + (parseFloat(inv.powerCost) || 0) + (parseFloat(inv.othersCost) || 0) + (parseFloat(inv.alquiler) || 0) + (parseFloat(inv.reactiveCost) || 0);

        // Si IA no entrega impuestos, calcular a partir de regla BOE
        const iee = inv.electricityTax || baseFromCosts * BOE.taxes.iee;
        const subtotalConIEE = baseFromCosts + iee;

        // Canarias: prioriza IGIC. Península: IVA.
        const isCanarias = inv.igicTax > 0 || /canarias/i.test(`${inv.supplyAddress || ''} ${inv.comercializadora || ''}`);
        const igic = inv.igicTax || 0;
        const iva = isCanarias ? 0 : (inv.ivaTax || subtotalConIEE * BOE.taxes.iva);
        const taxName = isCanarias ? 'IGIC' : 'IVA';
        const taxValue = isCanarias ? igic : iva;

        inv.total = parseFloat(inv.total || 0);
        inv.totalCalculated = inv.total > 0 ? inv.total : subtotalConIEE + taxValue;
        inv.taxName = taxName;
        inv.taxValue = taxValue;

        inv.breakdown = {
            energyCost: parseFloat(inv.energyCost) || 0,
            powerCost: parseFloat(inv.powerCost) || 0,
            othersCost: parseFloat(inv.othersCost) || 0,
            alquiler: parseFloat(inv.alquiler) || 0,
            reactiveCost: parseFloat(inv.reactiveCost) || 0,
            subtotalBase: baseFromCosts,
            iee: iee,
            subtotalConIEE: subtotalConIEE,
            taxName: taxName,
            taxAmount: taxValue,
            igic: igic,
            iva: iva,
            totalFinal: inv.totalCalculated,
            consumptionItems: inv.consumptionItems || []
        };

        console.log(`[Cálculo] Desglose para ${fileName}:`, inv.breakdown);

        inv.fileName = fileName;
        inv._auditStatus = 'OK';

        return inv;
    } catch (e) {
        console.error("Error IA:", e);
        return null;
    }
}

function fallbackParseInvoiceText(text, fileName) {
    const textLower = text.toLowerCase();
    const invoice = {
        fileName,
        invoiceNum: 'S/N',
        clientName: 'Desconocido',
        supplyAddress: 'N/D',
        comercializadora: 'N/D',
        tariffType: 'N/D',
        period: 'N/D',
        consumption: 0,
        energyCost: 0,
        powerCost: 0,
        othersCost: 0,
        totalCalculated: 0,
        _auditStatus: 'fallback'
    };

    invoice.energyPeriodItems = extractEnergyPeriodItems(text);
    invoice.powerPeriodItems = extractPowerPeriodItems(text);
    invoice.tollPeriodItems = extractTollPeriodItems(text);
    normalizeEnergyAndTolls(invoice);
    invoice._energyPeriodsSource = invoice.energyPeriodItems.length > 0 ? 'regex' : 'none';
    invoice._powerPeriodsSource = invoice.powerPeriodItems.length > 0 ? 'regex' : 'none';
    invoice._tollPeriodsSource = invoice.tollPeriodItems.length > 0 ? 'regex' : 'none';

    // Extraer número de factura
    const invoiceMatch = textLower.match(/factura\s*(?:n[º°]?|num|núm)?\s*[:\-]?\s*([a-z0-9\-]+)/i);
    if (invoiceMatch) {
        invoice.invoiceNum = invoiceMatch[1].toUpperCase();
    }

    // Extraer comercializadora
    const comercializadoraMatch = textLower.match(/(?:comercializadora|vendedor|empresa|compa(?:ñ|n)i?a|distribuidora)\s*[:\-]?\s*([a-z0-9áéíóúüñ\s\.,\-]+)/i);
    if (comercializadoraMatch) {
        invoice.comercializadora = comercializadoraMatch[1].trim();
    } else {
        invoice.comercializadora = detectComercializadoraFromText(text);
    }

    invoice.tariffType = detectTariffTypeFromText(text);

    // Extraer nombre de cliente
    const clienteMatch = textLower.match(/(?:cliente|titular|nombre)\s*[:\-]?\s*([a-z0-9áéíóúüñ\s\.,\-]+)/i);
    if (clienteMatch) {
        invoice.clientName = clienteMatch[1].trim();
    }

    // Extraer consumo (kWh) mediante todos los valores kWh detectables y 'consumo total'
    const kwhMatches = [...textLower.matchAll(/(\d+[\d\.,]*)\s*kwh/gi)].map(m => Number(m[1].replace(/\./g, '').replace(/,/g, '.')) || 0);
    const consumoTotalMatch = textLower.match(/consumo\s*(?:real\s*)?total\s*[:\-]?\s*(\d+[\d\.,]*)/i);

    if (invoice.energyPeriodItems.length > 0) {
        const periods = [0, 0, 0, 0, 0, 0];
        invoice.energyPeriodItems.forEach(item => {
            periods[item.period - 1] = item.kwh;
        });
        invoice.consumptionItems = periods;
        invoice.consumption = periods.reduce((a, b) => a + b, 0);
    } else if (consumoTotalMatch) {
        invoice.consumption = Number(consumoTotalMatch[1].replace(/\./g, '').replace(/,/g, '.')) || invoice.consumption;
    } else if (kwhMatches.length > 0) {
        // Sumar todos los kWh de los periodos (P1..P6) para mayor precisión
        invoice.consumptionItems = kwhMatches;
        invoice.consumption = kwhMatches.reduce((a, b) => a + b, 0);
    }

    // Extraer total factura con criterio de prioridad: TOTAL IMPORTE FACTURA > TOTAL FACTURA > A PAGAR
    const totalCandidates = [];
    const totalPatternLines = textLower.match(/(?:total\s+importe\s+factura|total\s+factura|total\s+a\s+pagar|importe\s+total|a\s+pagar)[^\n]*?(\d+[\d\.,]*)/gi) || [];
    totalPatternLines.forEach(line => {
        const m = line.match(/(\d+[\d\.,]*)/);
        if (m) totalCandidates.push(Number(m[1].replace(/\./g, '').replace(/,/g, '.')));
    });

    if (totalCandidates.length > 0) {
        invoice.totalCalculated = Math.max(...totalCandidates);
    } else {
        // Fallback de regex más general
        const totalPatterns = [
            /total\s*(?:factura|importe)?\s*[:\-]?\s*€?\s*(\d+[\d\.,]*)/i,
            /importe\s*total\s*[:\-]?\s*€?\s*(\d+[\d\.,]*)/i,
            /a\s*pagar\s*[:\-]?\s*€?\s*(\d+[\d\.,]*)/i,
            /total\s*a\s*pagar\s*[:\-]?\s*€?\s*(\d+[\d\.,]*)/i
        ];
        for (const pattern of totalPatterns) {
            const match = textLower.match(pattern);
            if (match) {
                invoice.totalCalculated = Number(match[1].replace(/\./g, '').replace(/,/g, '.')) || 0;
                break;
            }
        }
    }

    // Extraer periodo
    const periodMatch = textLower.match(/periodo\s*[:\-]?\s*([a-z0-9\s\-\/]+)/i);
    if (periodMatch) {
        invoice.period = periodMatch[1].trim();
    }

    const addressMatch = textLower.match(/direccion\s*de\s*suministro\s*[:\-]?\s*([a-z0-9\s\.,ºª\-]+)/i);
    if (addressMatch) {
        invoice.supplyAddress = addressMatch[1].trim();
    }

    const clientNameMatch = textLower.match(/(?:cliente|titular)\s*[:\-]?\s*([a-z\s\.,ñáéíóú]+)/i);
    if (clientNameMatch) {
        invoice.clientName = clientNameMatch[1].trim().replace(/\s+/g,' ');
    }

    const electricityTaxMatch = textLower.match(/impuesto\s*(?:de\s*electricidad|especial\s*eléctrico)\s*[:\-]?\s*€?\s*(\d+[\d\.,]+)/i);
    if (electricityTaxMatch) {
        invoice.electricityTax = Number(electricityTaxMatch[1].replace(/\./g, '').replace(/,/g, '.')) || invoice.electricityTax;
    }

    const igicTaxMatch = textLower.match(/(igic|impuesto\s*de\s*aplicación)\s*[:\-]?\s*€?\s*(\d+[\d\.,]+)/i);
    if (igicTaxMatch) {
        invoice.igicTax = Number(igicTaxMatch[2].replace(/\./g, '').replace(/,/g, '.')) || invoice.igicTax;
    }

    const ivaTaxMatch = textLower.match(/iva\s*[:\-]?\s*€?\s*(\d+[\d\.,]+)/i);
    if (ivaTaxMatch) {
        invoice.ivaTax = Number(ivaTaxMatch[1].replace(/\./g, '').replace(/,/g, '.')) || invoice.ivaTax;
    }

    // Si tenemos consumo y total, calcular precio medio y desglose fiscal
    if (invoice.consumption > 0 && invoice.totalCalculated > 0) {
        // Si el total no se ha extraído, estimar con precio medio
        if (invoice.totalCalculated === 0) {
            invoice.totalCalculated = invoice.consumption * 0.25;
        }

        // Quitar impuestos al total extraído para obtener la base aproximada
        const subtotalBase = invoice.totalCalculated / BOE.taxes.ivaFactor / (1 + BOE.taxes.iee);
        const iee = subtotalBase * BOE.taxes.iee;
        const subtotalConIEE = subtotalBase + iee;
        const isCanarias = invoice.igicTax > 0 || /canarias/i.test(`${invoice.supplyAddress || ''} ${invoice.comercializadora || ''}`);
        const igic = invoice.igicTax || 0;
        const iva = isCanarias ? 0 : subtotalConIEE * BOE.taxes.iva;
        const taxName = isCanarias ? 'IGIC' : 'IVA';
        const taxAmount = isCanarias ? igic : iva;

        invoice.breakdown = {
            energyCost: subtotalBase * 0.7,
            powerCost: subtotalBase * 0.2,
            othersCost: subtotalBase * 0.1,
            alquiler: 0,
            reactiveCost: 0,
            subtotalBase: subtotalBase,
            iee: iee,
            subtotalConIEE: subtotalConIEE,
            taxName: taxName,
            taxAmount: taxAmount,
            igic: igic,
            iva: iva,
            totalFinal: subtotalConIEE + taxAmount
        };

        invoice.energyCost = invoice.breakdown.energyCost;
        invoice.powerCost = invoice.breakdown.powerCost;
        invoice.othersCost = invoice.breakdown.othersCost;

        // Usar total calculado con coherencia fiscal
        invoice.totalCalculated = invoice.breakdown.totalFinal;
    }

    console.log(`[Fallback] Extraído de ${fileName}: consumo=${invoice.consumption}, total=${invoice.totalCalculated}`);

    return invoice;
}

// ========================================================================
// 6. MOTOR DE BASE DE DATOS Y PERSISTENCIA
// ========================================================================
function saveToDatabase(invoiceRecords) {
    try {
        dbInvoices = [...invoiceRecords, ...dbInvoices];
        localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
        renderHistory();
        renderClients();
    } catch (err) {
        console.error('Error guardando en database:', err);
    }
}

async function cloudSync(invoice) {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient.from('invoices').insert([invoice]);
        if (error) throw error;
        console.log("[Cloud] Sincronizado:", invoice.fileName);
    } catch (e) {
        console.warn("[Cloud] Error sync:", e.message);
    }
}

function loadLocalStore() {
    const stored = localStorage.getItem('audit_pro_db');
    if (stored) {
        dbInvoices = JSON.parse(stored);
        console.log("[LocalDB] Cargado:", dbInvoices.length, "registros");
    }
    renderClients();
}

function renderClients() {
    const clientsList = document.getElementById('clients-list');
    if (!clientsList) return;

    clientSupplyRows = [];

    const filterClientEl = document.getElementById('clients-filter-name');
    const filterSupplyEl = document.getElementById('clients-filter-supply');
    const filterTariffEl = document.getElementById('clients-filter-tariff');
    const filterCommercializerEl = document.getElementById('clients-filter-commercializer');

    const allInvoices = [...dbInvoices, ...invoices];
    if (allInvoices.length === 0) {
        clientsList.innerHTML = '<div class="card" style="padding:1rem;">No hay clientes todavía. Sube facturas para generarlos automáticamente.</div>';
        return;
    }

    const selectedClient = filterClientEl ? filterClientEl.value : '';
    const selectedTariff = filterTariffEl ? filterTariffEl.value : '';
    const selectedCommercializer = filterCommercializerEl ? filterCommercializerEl.value : '';
    const supplyQuery = String(filterSupplyEl?.value || '').trim().toLowerCase();

    // Cargar opciones de filtros dinamicos manteniendo seleccion actual
    const byClient = new Map();
    allInvoices.forEach(inv => {
        const clientName = String(inv.clientName || 'Desconocido').trim() || 'Desconocido';
        if (!byClient.has(clientName)) byClient.set(clientName, []);
        byClient.get(clientName).push(inv);
    });

    const clientOptions = [...byClient.keys()]
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
    const tariffOptions = [...new Set(allInvoices.map(inv => String(inv.tariffType || 'N/D').trim() || 'N/D'))]
        .filter(v => v && v !== 'N/D')
        .sort((a, b) => sortTariffValue(a) - sortTariffValue(b));
    const commercializerOptions = [...new Set(allInvoices.map(inv => String(inv.comercializadora || 'N/D').trim() || 'N/D'))]
        .filter(v => v && v !== 'N/D')
        .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));

    if (filterClientEl) {
        filterClientEl.innerHTML = '<option value="">Todos los clientes</option>' + clientOptions.map(v => `<option value="${v}">${v}</option>`).join('');
        filterClientEl.value = clientOptions.includes(selectedClient) ? selectedClient : '';
    }
    if (filterTariffEl) {
        filterTariffEl.innerHTML = '<option value="">Todas las tarifas</option>' + tariffOptions.map(v => `<option value="${v}">${v}</option>`).join('');
        filterTariffEl.value = tariffOptions.includes(selectedTariff) ? selectedTariff : '';
    }
    if (filterCommercializerEl) {
        filterCommercializerEl.innerHTML = '<option value="">Todas las comercializadoras</option>' + commercializerOptions.map(v => `<option value="${v}">${v}</option>`).join('');
        filterCommercializerEl.value = commercializerOptions.includes(selectedCommercializer) ? selectedCommercializer : '';
    }

    const activeClient = filterClientEl ? filterClientEl.value : '';
    const activeTariff = filterTariffEl ? filterTariffEl.value : '';
    const activeCommercializer = filterCommercializerEl ? filterCommercializerEl.value : '';

    const html = [...byClient.entries()]
        .sort((a, b) => a[0].localeCompare(b[0], 'es', { sensitivity: 'base' }))
        .map(([clientName, clientInvoices]) => {
            if (activeClient && clientName !== activeClient) return '';
            const supplyMap = new Map();
            clientInvoices.forEach(inv => {
                const address = String(inv.supplyAddress || 'N/D').trim() || 'N/D';
                const cups = String(inv.cups || 'N/D').trim() || 'N/D';
                const tariffType = String(inv.tariffType || 'N/D').trim() || 'N/D';
                const key = `${address}__${cups}__${tariffType}`;
                if (!supplyMap.has(key)) {
                    supplyMap.set(key, {
                        address,
                        cups,
                        tariffType,
                        comercializadora: inv.comercializadora || 'N/D',
                        invoice: inv
                    });
                }
            });

            const supplies = [...supplyMap.values()]
                .sort((a, b) => {
                    const byAddress = a.address.localeCompare(b.address, 'es', { sensitivity: 'base' });
                    if (byAddress !== 0) return byAddress;
                    return sortTariffValue(a.tariffType) - sortTariffValue(b.tariffType);
                })
                .filter(s => {
                    const matchSupply = !supplyQuery || `${s.address} ${s.cups}`.toLowerCase().includes(supplyQuery);
                    const matchTariff = !activeTariff || s.tariffType === activeTariff;
                    const matchCommercializer = !activeCommercializer || s.comercializadora === activeCommercializer;
                    return matchSupply && matchTariff && matchCommercializer;
                });

            if (supplies.length === 0) return '';

            const rows = supplies.map(s => {
                const rowIndex = clientSupplyRows.push({ supply: s, invoice: s.invoice }) - 1;
                return `
                    <tr>
                        <td>${s.address}</td>
                        <td>${s.cups}</td>
                        <td>${s.tariffType}</td>
                        <td>${s.comercializadora}</td>
                        <td>
                            <button class="btn primary btn-sm" onclick="openClientSupplyInvoice(${rowIndex})">Ver factura</button>
                        </td>
                    </tr>
                `;
            }).join('');

            return `
                <div class="card" style="margin-bottom: 1rem; padding: 1rem;">
                    <h3 style="margin-bottom:0.75rem;">${clientName}</h3>
                    <div style="overflow-x:auto;">
                        <table class="modal-table">
                            <thead>
                                <tr>
                                    <th>Direccion de suministro</th>
                                    <th>CUPS</th>
                                    <th>Tarifa</th>
                                    <th>Comercializadora</th>
                                    <th>Factura</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows || '<tr><td colspan="5">Sin suministros</td></tr>'}
                            </tbody>
                        </table>
                    </div>
                </div>
            `;
        }).join('');

    clientsList.innerHTML = html || '<div class="card" style="padding:1rem;">No hay suministros que cumplan los filtros.</div>';
}

// ========================================================================
// 7. MOTOR DE RENDERIZADO Y UI
// ========================================================================
function renderAuditDashboard() {
    console.log(`[UI] Renderizando dashboard con ${invoices.length} facturas`);
    if (invoices.length === 0) {
        console.log('[UI] No hay facturas para mostrar');
        return;
    }

    const last = invoices[0];
    const consumption = Number(last.consumption) || 0;
    const totalCalculated = Number(last.totalCalculated) || 0;

    console.log(`[UI] Actualizando métricas: consumo=${consumption}, total=${totalCalculated}`);

    // Verificar que los elementos existen
    const totalKwhEl = document.getElementById('total-kwh');
    const avgPriceEl = document.getElementById('avg-price');
    
    if (totalKwhEl) {
        totalKwhEl.innerText = `${consumption.toFixed(0)} kWh`;
        console.log(`[UI] Actualizado total-kwh: ${totalKwhEl.innerText}`);
    } else {
        console.error('[UI] Elemento total-kwh no encontrado');
    }
    
    if (avgPriceEl) {
        const avgEnergyUnitPrice = (consumption > 0)
            ? ((Number(last.energyCost) || 0) / consumption)
            : 0;
        avgPriceEl.innerText = `${avgEnergyUnitPrice.toFixed(6)} €/kWh`;
        console.log(`[UI] Actualizado avg-price: ${avgPriceEl.innerText}`);
    } else {
        console.error('[UI] Elemento avg-price no encontrado');
    }

    const tbody = document.querySelector('#results-table tbody');
    if (!tbody) {
        console.error('[UI] No se encontró tbody de la tabla de resultados');
        return;
    }

    tbody.innerHTML = invoices.map((inv, index) => `
        <tr>
            <td>
                <strong>${inv.invoiceNum || 'S/N'}</strong><br>
                <small>${inv.clientName || inv.fileName}</small><br>
                <small style="color: #64748b;">${inv.comercializadora ? 'Comercializadora: ' + inv.comercializadora : ''}</small>
                <small style="color: #64748b; display:block;">${inv.tariffType && inv.tariffType !== 'N/D' ? 'Tarifa: ' + inv.tariffType : ''}</small>
            </td>
            <td>${inv.period || 'N/D'}</td>
            <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
            <td class="text-right">
                 <button class="btn primary btn-sm" onclick="openDetailModalFromInvoices(${index})">Ver Detalle</button>
                 <button class="btn primary btn-sm" onclick="openCompareView(${index})" style="margin-left: 0.25rem;">Ver Comparativa</button>
                 <button class="btn secondary btn-sm" onclick="deleteCurrentInvoice(${index})" style="margin-left: 0.5rem; background-color: #ef4444; color: white;">Eliminar</button>
            </td>
        </tr>
    `).join('');
    
    console.log('[UI] Dashboard renderizado correctamente');
}

function renderHistory() {
    const historyList = document.getElementById('history-list');
    if (!historyList) return;

    if (!dbInvoices.length) {
        historyList.innerHTML = `
            <div style="text-align: center; padding: 2rem;">
                <p>No hay facturas procesadas aún.</p>
            </div>
        `;
        return;
    }

    // Agregar botón para vaciar todo el historial
    const clearAllButton = `
        <div style="text-align: center; margin-bottom: 1rem;">
            <button class="btn secondary" onclick="clearAllHistory()" style="background-color: #dc2626; color: white; border: none;">
                🗑️Vaciar Todo el Historial
            </button>
        </div>
    `;

    historyList.innerHTML = clearAllButton + dbInvoices.map((inv, index) => `
        <div class="card" style="position: relative; padding: 1rem; margin-bottom: 0.75rem;">
            <button class="btn" onclick="deleteHistoryItem(${index})" 
                    style="position: absolute; top: 0.5rem; right: 0.5rem; 
                           background-color: #ef4444; color: white; border: none; 
                           border-radius: 50%; width: 30px; height: 30px; 
                           cursor: pointer; font-size: 14px;" 
                    title="Eliminar esta factura">
                ×
            </button>
            <div style="display: grid; grid-template-columns: 1fr auto; gap: 6px; align-items: center;">
                <div>
                    <strong>${inv.fileName || inv.invoiceNum || 'N/A'}</strong> - ${inv.period || 'Periodo desconocido'}
                    <br>Total: ${formatCurrency(inv.totalCalculated)} - Consumo: ${inv.consumption?.toFixed(2) || 0} kWh
                    <br><small style="color: #64748b;">Estado: ${inv._auditStatus || 'Procesado'}</small>
                </div>
                <div>
                    <button class="btn primary" onclick="openDetailModalFromHistory(${index})" style="font-size: 0.8rem;">Ver Detalle</button>
                </div>
            </div>
        </div>
    `).join('');
}

// ========================================================================
// 8. UTILIDADES Y FORMATOS
// ========================================================================
function formatCurrency(a) { 
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0); 
}

function buildInvoiceDetailTable(inv) {
    const powerPeriodsText = (inv.powerPeriodItems && inv.powerPeriodItems.length > 0)
        ? inv.powerPeriodItems.map(item => `P${item.period}: ${item.kw.toFixed(2)} kW @ ${item.unitPriceKw.toFixed(6)} €/kW`).join(' | ')
        : 'N/D';

    const energyPeriodsWithConsumption = (inv.energyPeriodItems || [])
        .filter(item => Number(item.kwh || 0) > 0)
        .sort((a, b) => a.period - b.period);

    let totalEnergyCalc = 0;
    let totalTollsCalc = 0;
    const periodTableRows = energyPeriodsWithConsumption.map(e => {
        const t = (inv.tollPeriodItems || []).find(x => x.period === e.period);
        const tollUnitPrice = Number(t?.unitPriceKwh || 0);
        const energyAmount = Number(e.kwh || 0) * Number(e.unitPriceKwh || 0);
        const tollAmount = Number(e.kwh || 0) * tollUnitPrice;
        const periodTotal = energyAmount + tollAmount;
        totalEnergyCalc += energyAmount;
        totalTollsCalc += tollAmount;

        return `
            <tr>
                <td>P${e.period}</td>
                <td>${e.kwh.toFixed(2)} kWh</td>
                <td>${e.unitPriceKwh.toFixed(6)} €/kWh</td>
                <td>${formatCurrency(energyAmount)}</td>
                <td>${tollUnitPrice.toFixed(6)} €/kWh</td>
                <td>${formatCurrency(tollAmount)}</td>
                <td>${formatCurrency(periodTotal)}</td>
            </tr>
        `;
    }).join('');

    // Inferir días del periodo de facturación si los items no los traen
    const billingDays = (() => {
        // Intentar sacar de los propios items
        const fromItems = (inv.powerPeriodItems || []).map(i => Number(i.days || 0)).find(d => d > 0);
        if (fromItems) return fromItems;
        // Calcular desde el campo period de la factura (e.g. "01/01/2024 - 28/01/2024")
        if (inv.period && inv.period.includes('-')) {
            const parts = inv.period.split('-').map(s => s.trim());
            if (parts.length === 2) {
                const [d1, m1, y1] = (parts[0].includes('/') ? parts[0].split('/') : parts[0].split('.'));
                const [d2, m2, y2] = (parts[1].includes('/') ? parts[1].split('/') : parts[1].split('.'));
                const date1 = new Date(`${y1}-${m1}-${d1}`);
                const date2 = new Date(`${y2}-${m2}-${d2}`);
                const diff = Math.round((date2 - date1) / (1000 * 60 * 60 * 24));
                if (diff > 0 && diff <= 365) return diff;
            }
        }
        return null;
    })();

    const activePowerPeriods = (inv.powerPeriodItems || [])
        .filter(item => Number(item.kw || 0) > 0)
        .sort((a, b) => a.period - b.period);

    let totalPowerCalc = 0;
    const powerTableRows = activePowerPeriods.map(item => {
        const days = Number(item.days || billingDays || 0);
        const amount = Number(item.kw || 0) * Number(item.unitPriceKw || 0) * (days || 1);
        totalPowerCalc += amount;
        const daysLabel = days ? days.toString() : '?';
        return `
            <tr>
                <td>P${item.period}</td>
                <td>${Number(item.kw).toFixed(2)} kW</td>
                <td>${Number(item.unitPriceKw).toFixed(6)} €/kW</td>
                <td>${daysLabel}</td>
                <td>${formatCurrency(amount)}</td>
            </tr>
        `;
    }).join('');

    const powerNestedTable = activePowerPeriods.length > 0 ? `
        <table class="modal-table" style="margin-top:0;">
            <thead>
                <tr>
                    <th>Periodo</th>
                    <th>kW</th>
                    <th>€/kW</th>
                    <th>Dias</th>
                    <th>Importe</th>
                </tr>
            </thead>
            <tbody>
                ${powerTableRows}
                <tr style="font-weight:700; background:#f8fafc;">
                    <td colspan="4" style="text-align:right;">Total potencia</td>
                    <td>${formatCurrency(totalPowerCalc)}</td>
                </tr>
            </tbody>
        </table>
    ` : 'N/D';

    const nestedPeriodsTable = `
        <table class="modal-table" style="margin-top:0;">
            <thead>
                <tr>
                    <th>Periodo</th>
                    <th>Consumo</th>
                    <th>Precio energía</th>
                    <th>Importe energía</th>
                    <th>Precio peajes/cargos</th>
                    <th>Importe peajes/cargos</th>
                    <th>Total período</th>
                </tr>
            </thead>
            <tbody>
                ${periodTableRows || '<tr><td colspan="7">No hay periodos con consumo</td></tr>'}
                <tr style="font-weight: 700; background: #f8fafc;">
                    <td colspan="3" style="text-align:right;">Totales</td>
                    <td>${formatCurrency(totalEnergyCalc)}</td>
                    <td></td>
                    <td>${formatCurrency(totalTollsCalc)}</td>
                    <td>${formatCurrency(totalEnergyCalc + totalTollsCalc)}</td>
                </tr>
            </tbody>
        </table>
    `;

    const rows = [
        ['Factura', inv.invoiceNum || 'S/N'],
        ['Cliente', inv.clientName || 'N/D'],
        ['Comercializadora', inv.comercializadora || 'N/D'],
        ['Tarifa de acceso', inv.tariffType || 'N/D'],
        ['Dirección suministro', inv.supplyAddress || 'N/D'],
        ['CUPS', inv.cups || 'N/D'],
        ['Periodo', inv.period || 'N/D'],
        ['Consumo total (kWh)', inv.consumption?.toFixed(2) || '0'],
        ['Consumo por periodos (kWh)', (inv.consumptionItems && inv.consumptionItems.length > 0) ? inv.consumptionItems.map((v,o)=>`P${o+1}:${v.toFixed(2)}`).join(' | ') : 'N/D'],
        ['Detalle periodos (tabla)', nestedPeriodsTable],
        ['Detalle coste potencia por periodos', powerNestedTable],
        ['Otros costes', formatCurrency(inv.othersCost)],
        ['Alquiler', formatCurrency(inv.alquiler)],
        ['Reactiva', formatCurrency(inv.reactiveCost)],
        ['Subtotal base', formatCurrency(inv.breakdown?.subtotalBase || 0)],
        [inv.taxName || (inv.igicTax ? 'IGIC' : 'IVA'), formatCurrency(inv.taxValue || inv.breakdown?.taxAmount || 0)],
        ['Total calculado', formatCurrency(inv.totalCalculated)],
        ['Estado', inv._auditStatus || 'N/D']
    ];

    let html = '<table class="modal-table"><tbody>';
    rows.forEach(([label, value]) => {
        html += `<tr><th>${label}</th><td>${value}</td></tr>`;
    });
    html += '</tbody></table>';

    return html;
}

function openDetailModal(inv) {
    const modal = document.getElementById('invoice-detail-modal');
    const body = document.getElementById('modal-content-body');
    if (!modal || !body) return;

    body.innerHTML = buildInvoiceDetailTable(inv);
    modalGuardUntil.detail = Date.now() + 250;
    modal.classList.remove('hidden');
}

function openDetailModalFromInvoices(index) {
    if (!invoices[index]) return;
    openDetailModal(invoices[index]);
    renderInvoiceDetail(invoices[index]);
}

function openDetailModalFromHistory(index) {
    if (!dbInvoices[index]) {
        console.error('[History] Factura no encontrada en índice', index);
        return;
    }
    const inv = dbInvoices[index];
    const modal = document.getElementById('invoice-detail-modal');
    const body = document.getElementById('modal-content-body');
    if (!modal || !body) {
        console.error('[History] Modal o body no encontrados');
        return;
    }
    body.innerHTML = buildInvoiceDetailTable(inv);
    modalGuardUntil.detail = Date.now() + 250;
    modal.classList.remove('hidden');
    console.log('[History] Abierto detalle para', inv.invoiceNum);
}

function renderInvoiceDetail(inv) {
    const section = document.getElementById('detail-section');
    const content = document.getElementById('detail-content');
    if (!section || !content) return;

    section.classList.remove('hidden');
    content.innerHTML = buildInvoiceDetailTable(inv);

    console.log('[Detail] Mostrando detalle de factura', inv.invoiceNum);
}

function closeDetailModal() {
    const modal = document.getElementById('invoice-detail-modal');
    if (modal) modal.classList.add('hidden');
}

// Cerrar al clicar fuera
window.addEventListener('click', (event) => {
    const modal = document.getElementById('invoice-detail-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.detail) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeDetailModal();
    }
});

// Comparacion state
let compareCurrentInvoiceIndex = null;
let compareSelectedCommercializers = [];
let compareScope = 'single';

function openCompareView(index) {
    const inv = invoices[index];
    if (!inv) return;

    const compatible = commercializers.filter(c => !c.tariffType || c.tariffType === inv.tariffType);
    if (compatible.length === 0) {
        alert('No hay comercializadoras configuradas. Por favor crea una en la pestaña "Comercializadoras".');
        return;
    }

    compareCurrentInvoiceIndex = index;
    compareSelectedCommercializers = [];
    compareScope = 'single';
    const scopeEl = document.getElementById('compare-scope');
    if (scopeEl) scopeEl.value = 'single';
    renderCompareSelectorList();
    modalGuardUntil.compareSelector = Date.now() + 250;
    document.getElementById('compare-selector-modal').classList.remove('hidden');
}

function normalizeClientKey(name) {
    return String(name || '').trim().toLowerCase();
}

function getCompareInvoices(baseInvoice) {
    if (!baseInvoice) return [];
    const all = [...invoices, ...dbInvoices];
    const unique = [];
    const seen = new Set();

    all.forEach(inv => {
        const key = `${inv.invoiceNum || 'S/N'}|${inv.fileName || ''}|${inv.period || ''}|${inv.cups || ''}`;
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(inv);
        }
    });

    if (compareScope === 'client-tariff') {
        return unique.filter(inv =>
            normalizeClientKey(inv.clientName) === normalizeClientKey(baseInvoice.clientName) &&
            String(inv.tariffType || 'N/D') === String(baseInvoice.tariffType || 'N/D')
        );
    }

    return [baseInvoice];
}

function computeComparisonMetrics(compareInvoices, comm) {
    let totalConsumption = 0;
    let oldEnergyCost = 0;
    let newEnergyCost = 0;
    let oldTotalInvoice = 0;
    let newTotalInvoiceSim = 0;
    const invoiceRows = [];

    compareInvoices.forEach(inv => {
        const allowedPeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
        const energyItems = (inv.energyPeriodItems || []).filter(item => allowedPeriods.includes(Number(item.period)));

        const consumption = energyItems.reduce((sum, item) => sum + Number(item.kwh || 0), 0);
        const oldEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
        const proposedEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(comm.energyPrices?.[item.period] || 0)), 0);
        const baseTotal = Number(inv.totalCalculated || 0);
        const invEnergyReference = Number(inv.energyCost || 0) > 0 ? Number(inv.energyCost || 0) : oldEnergy;
        const simulatedTotal = baseTotal - invEnergyReference + proposedEnergy;

        totalConsumption += consumption;
        oldEnergyCost += oldEnergy;
        newEnergyCost += proposedEnergy;
        oldTotalInvoice += baseTotal;
        newTotalInvoiceSim += simulatedTotal;

        invoiceRows.push({
            invoiceNum: inv.invoiceNum || 'S/N',
            cups: inv.cups || 'N/D',
            period: inv.period || 'N/D',
            consumption,
            oldEnergy,
            proposedEnergy,
            energySaving: oldEnergy - proposedEnergy,
            oldTotal: baseTotal,
            simulatedTotal
        });
    });

    const oldAvgPrice = totalConsumption > 0 ? oldEnergyCost / totalConsumption : 0;
    const newAvgPrice = totalConsumption > 0 ? newEnergyCost / totalConsumption : 0;
    const energySaving = oldEnergyCost - newEnergyCost;
    const totalSaving = oldTotalInvoice - newTotalInvoiceSim;

    return {
        totalConsumption,
        oldEnergyCost,
        newEnergyCost,
        oldAvgPrice,
        newAvgPrice,
        energySaving,
        oldTotalInvoice,
        newTotalInvoiceSim,
        totalSaving,
        invoiceRows
    };
}

function renderCompareSelectorList() {
    const list = document.getElementById('compare-selector-list');
    if (!list) return;

    const baseInv = invoices[compareCurrentInvoiceIndex];
    if (!baseInv) {
        list.innerHTML = '<p style="color:#999;">No hay factura base para comparar.</p>';
        return;
    }

    const compatibleCommercializers = commercializers
        .map((c, idx) => ({ c, idx }))
        .filter(item => !item.c.tariffType || item.c.tariffType === baseInv.tariffType);

    const html = compatibleCommercializers.map(({ c, idx }) => {
        const pricesPreview = getConfiguredEnergyPeriodsByTariff(c.tariffType || baseInv.tariffType || '2.0')
            .map(p => `P${p}: ${(c.energyPrices[p] || 0).toFixed(4)}`)
            .join(' | ');
        return `
            <div style="display: flex; align-items: center; gap: 1rem; padding: 0.75rem; border: 1px solid #e5e7eb; border-radius: 4px; margin-bottom: 0.5rem;">
                <input type="checkbox" id="compare-check-${idx}" value="${idx}" style="width: 18px; height: 18px; cursor: pointer;">
                <div style="flex: 1;">
                    <strong>${c.name}</strong> <small style="color:#64748b;">(Tarifa ${c.tariffType || baseInv.tariffType || 'N/D'})</small>
                    <div style="font-size: 0.85rem; color: #666; margin-top: 0.25rem;">€/kWh: ${pricesPreview}</div>
                </div>
            </div>
        `;
    }).join('');

    list.innerHTML = html || '<p style="color: #999;">No hay comercializadoras compatibles con la tarifa de esta factura.</p>';
}

function doSingleComparison() {
    const selected = [];
    commercializers.forEach((c, idx) => {
        const checkbox = document.getElementById(`compare-check-${idx}`);
        if (checkbox && checkbox.checked) selected.push(idx);
    });

    if (selected.length === 0) {
        alert('Por favor selecciona al menos una comercializadora.');
        return;
    }

    if (selected.length > 1) {
        alert('Para comparativa individual, selecciona solo una comercializadora.');
        return;
    }

    const scopeEl = document.getElementById('compare-scope');
    compareScope = scopeEl ? scopeEl.value : 'single';

    closeCompareSelectorModal();
    renderSingleComparison(compareCurrentInvoiceIndex, selected[0]);
}

function doMultipleComparison() {
    const selected = [];
    commercializers.forEach((c, idx) => {
        const checkbox = document.getElementById(`compare-check-${idx}`);
        if (checkbox && checkbox.checked) selected.push(idx);
    });

    if (selected.length === 0) {
        alert('Por favor selecciona al menos una comercializadora.');
        return;
    }

    const scopeEl = document.getElementById('compare-scope');
    compareScope = scopeEl ? scopeEl.value : 'single';

    closeCompareSelectorModal();
    renderMultipleComparison(compareCurrentInvoiceIndex, selected);
}

function renderSingleComparison(invoiceIdx, commercializerIdx) {
    const inv = invoices[invoiceIdx];
    const comm = commercializers[commercializerIdx];
    if (!inv || !comm) return;

    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

    const compareInvoices = getCompareInvoices(inv);
    const metrics = computeComparisonMetrics(compareInvoices, comm);
    const scopeLabel = compareScope === 'client-tariff'
        ? `Multi-suministro (${inv.clientName || 'Cliente'} | Tarifa ${inv.tariffType || 'N/D'})`
        : 'Suministro individual';

    const rowsHtml = metrics.invoiceRows.map(r => `
        <tr>
            <td>${r.invoiceNum}</td>
            <td>${r.cups}</td>
            <td>${r.period}</td>
            <td>${r.consumption.toFixed(2)} kWh</td>
            <td>${formatCurrency(r.oldEnergy)}</td>
            <td>${formatCurrency(r.proposedEnergy)}</td>
            <td style="font-weight:600; color:${r.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.energySaving)}</td>
            <td>${formatCurrency(r.oldTotal)}</td>
            <td>${formatCurrency(r.simulatedTotal)}</td>
        </tr>
    `).join('');

    const html = `
        <h3>Comparativa con ${comm.name}</h3>
        <p><strong>Cliente:</strong> ${inv.clientName || 'Desconocido'} | <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'} | <strong>Alcance:</strong> ${scopeLabel}</p>
        <div style="display:grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap:0.75rem; margin:0.75rem 0 1rem;">
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Precio energia actual</div><div style="font-size:1.1rem; font-weight:700;">${metrics.oldAvgPrice.toFixed(6)} €/kWh</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Precio energia propuesta</div><div style="font-size:1.1rem; font-weight:700;">${metrics.newAvgPrice.toFixed(6)} €/kWh</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Ahorro energia</div><div style="font-size:1.1rem; font-weight:700; color:${metrics.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.energySaving)}</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Factura simulada</div><div style="font-size:1.1rem; font-weight:700;">${formatCurrency(metrics.newTotalInvoiceSim)}</div></div>
        </div>
        <p style="color:#64748b; margin:0 0 0.75rem;">La potencia se mantiene en la simulacion; el cambio aplicado es sobre energia para estimar ahorro.</p>
        <div style="overflow-x:auto;">
            <table class="modal-table">
                <thead><tr><th>Factura</th><th>CUPS</th><th>Periodo factura</th><th>Consumo</th><th>Energia antes</th><th>Energia despues</th><th>Ahorro energia</th><th>Total antes</th><th>Total simulado</th></tr></thead>
                <tbody>
                    ${rowsHtml || '<tr><td colspan="9">No hay datos de energia para comparar.</td></tr>'}
                    <tr class="mirror-row-total"><td colspan="4" style="text-align:right;">Totales</td><td>${formatCurrency(metrics.oldEnergyCost)}</td><td>${formatCurrency(metrics.newEnergyCost)}</td><td style="font-weight:700; color:${metrics.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.energySaving)}</td><td>${formatCurrency(metrics.oldTotalInvoice)}</td><td>${formatCurrency(metrics.newTotalInvoiceSim)}</td></tr>
                </tbody>
            </table>
        </div>
    `;

    compareSection.innerHTML = html;
    switchView('compare-view');
}

function renderMultipleComparison(invoiceIdx, commercializerIndices) {
    const inv = invoices[invoiceIdx];
    if (!inv) return;

    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

    const compareInvoices = getCompareInvoices(inv);
    const scopeLabel = compareScope === 'client-tariff'
        ? `Multi-suministro (${inv.clientName || 'Cliente'} | Tarifa ${inv.tariffType || 'N/D'})`
        : 'Suministro individual';
    const comms = commercializerIndices.map(idx => commercializers[idx]).filter(Boolean);

    const rankingRows = comms.map(c => {
        const m = computeComparisonMetrics(compareInvoices, c);
        return { comm: c, metrics: m };
    }).sort((a, b) => b.metrics.energySaving - a.metrics.energySaving);

    const rowsHtml = rankingRows.map(({ comm, metrics }) => `
        <tr>
            <td><strong>${comm.name}</strong></td>
            <td>${(comm.tariffType || inv.tariffType || 'N/D')}</td>
            <td>${metrics.oldAvgPrice.toFixed(6)} €/kWh</td>
            <td>${metrics.newAvgPrice.toFixed(6)} €/kWh</td>
            <td style="font-weight:700; color:${metrics.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.energySaving)}</td>
            <td>${formatCurrency(metrics.oldTotalInvoice)}</td>
            <td>${formatCurrency(metrics.newTotalInvoiceSim)}</td>
            <td style="font-weight:700; color:${metrics.totalSaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.totalSaving)}</td>
        </tr>
    `).join('');

    const html = `
        <h3>Comparativa Multiple de Comercializadoras</h3>
        <p><strong>Cliente:</strong> ${inv.clientName || 'Desconocido'} | <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'} | <strong>Alcance:</strong> ${scopeLabel}</p>
        <p><strong>Ranking de propuesta de ahorro</strong> (basado en energia y simulacion de total)</p>
        <div style="overflow-x: auto;">
            <table class="modal-table">
                <thead>
                    <tr>
                        <th>Comercializadora</th>
                        <th>Tarifa</th>
                        <th>Precio actual</th>
                        <th>Precio propuesto</th>
                        <th>Ahorro energia</th>
                        <th>Total antes</th>
                        <th>Total simulado</th>
                        <th>Ahorro total</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml || '<tr><td colspan="8">No hay datos para comparar.</td></tr>'}
                </tbody>
            </table>
        </div>
        <p style="color:#64748b; margin-top:0.75rem;">La potencia no se destaca en las cards; la propuesta centra el ahorro en energia y su impacto en factura simulada.</p>
    `;

    compareSection.innerHTML = html;
    switchView('compare-view');
}

// ========================================================================
// 9. FUNCIONES DE GESTIÓN DE HISTORIAL
// ========================================================================
function deleteHistoryItem(index) {
    if (confirm('¿Estás seguro de que quieres eliminar esta factura del historial?')) {
        dbInvoices.splice(index, 1);
        localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
        renderHistory();
        renderClients();
        console.log(`[History] Eliminada factura en índice ${index}`);
    }
}

function clearAllHistory() {
    if (confirm('¿Estás seguro de que quieres vaciar TODO el historial? Esta acción no se puede deshacer.')) {
        dbInvoices = [];
        localStorage.removeItem('audit_pro_db');
        renderHistory();
        renderClients();
        console.log('[History] Historial vaciado completamente');
    }
}

function deleteCurrentInvoice(index) {
    if (confirm('¿Estás seguro de que quieres eliminar esta factura del dashboard actual?')) {
        invoices.splice(index, 1);
        if (invoices.length === 0) {
            // Si no quedan facturas, ocultar dashboard y volver a vista inicial
            const dashboard = document.getElementById('dashboard');
            if (dashboard) dashboard.classList.add('hidden');
            switchView('audit-view');
        } else {
            renderAuditDashboard();
        }
        renderClients();
        console.log(`[Dashboard] Eliminada factura en índice ${index}`);
    }
}

function clearCurrentInvoices() {
    if (confirm('¿Quieres limpiar todas las facturas del dashboard actual?')) {
        invoices = [];
        const dashboard = document.getElementById('dashboard');
        if (dashboard) dashboard.classList.add('hidden');
        switchView('audit-view');
        renderClients();
        console.log('[Dashboard] Dashboard limpiado');
    }
}

function openClientSupplyInvoice(rowIndex) {
    console.log('[Clients] openClientSupplyInvoice', rowIndex, clientSupplyRows.length);
    const row = clientSupplyRows[rowIndex];
    if (!row || !row.invoice) {
        alert('No hay factura asociada disponible para este suministro.');
        return;
    }

    const modal = document.getElementById('client-supply-invoice-modal');
    const body = document.getElementById('client-supply-invoice-modal-body');
    if (!modal || !body) return;

    const inv = row.invoice;
    const file = window.pendingPdfFiles.get(inv.fileName);
    let viewerHtml = '';

    if (file) {
        viewerHtml = '<div id="client-pdf-pages" class="card" style="padding:0.75rem; min-height: 280px;">Cargando PDF completo...</div>';
    } else if (Array.isArray(inv.invoicePreviewPages) && inv.invoicePreviewPages.length > 0) {
        const pagesHtml = inv.invoicePreviewPages.map((img, idx) => `
            <div style="margin-bottom: 1rem;">
                <div style="font-size:0.85rem; color:#64748b; margin-bottom:0.25rem;">Pagina ${idx + 1}</div>
                <img src="${img}" alt="Preview factura pagina ${idx + 1}" style="width:100%; max-width:980px; border:1px solid #e2e8f0; border-radius:8px; display:block;">
            </div>
        `).join('');
        const total = Number(inv.invoicePreviewTotalPages || inv.invoicePreviewPages.length);
        const rendered = Number(inv.invoicePreviewRenderedPages || inv.invoicePreviewPages.length);
        const note = rendered < total
            ? `<div class="card" style="padding:0.75rem; margin-bottom:0.75rem;">Mostrando ${rendered} de ${total} paginas en previsualizacion.</div>`
            : '';
        viewerHtml = `${note}${pagesHtml}`;
    } else if (inv.invoicePreview) {
        viewerHtml = `<img src="${inv.invoicePreview}" alt="Preview factura" style="width:100%; max-width:980px; border:1px solid #e2e8f0; border-radius:8px; display:block;">`;
    } else {
        viewerHtml = '<div class="card" style="padding:1rem;">No hay PDF/preview disponible para esta factura en este navegador.</div>';
    }

    body.innerHTML = `
        <div style="display:grid; grid-template-columns: 1fr; gap: 1rem;">
            <div class="card" style="padding:0.85rem;">
                <strong>Factura:</strong> ${inv.invoiceNum || 'S/N'} | 
                <strong>Cliente:</strong> ${inv.clientName || 'N/D'} | 
                <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'} | 
                <strong>CUPS:</strong> ${inv.cups || 'N/D'}
                <div style="margin-top:0.35rem;"><strong>Direccion:</strong> ${inv.supplyAddress || 'N/D'}</div>
            </div>
            <div>${viewerHtml}</div>
        </div>
    `;

    modalGuardUntil.clientSupply = Date.now() + 250;
    modal.classList.remove('hidden');

    if (file) {
        const pagesContainer = document.getElementById('client-pdf-pages');
        if (pagesContainer) {
            renderPdfFileAllPages(file, pagesContainer).catch(err => {
                console.error('[Clients] Error renderizando PDF completo:', err);
                pagesContainer.innerHTML = '<div class="card" style="padding:1rem;">No se pudo renderizar el PDF completo.</div>';
            });
        }
    }
}

function closeClientSupplyInvoiceModal() {
    const modal = document.getElementById('client-supply-invoice-modal');
    if (modal) modal.classList.add('hidden');
}

// ========================================================================
// 10. INICIALIZACIÓN Y EVENTOS
// ========================================================================
document.addEventListener('DOMContentLoaded', () => {
    initApp();

    // Botones de navegación
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => switchView(btn.getAttribute('data-view'));
    });

    // Inputs de archivos
    const fileInput = document.getElementById('file-input');
    const selectBtn = document.getElementById('select-files-btn');
    if (selectBtn && fileInput) {
        selectBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => processFiles(e.target.files);
    }

    // Cargar Historial
    renderHistory();
    renderClients();

    // Cargar Comercializadoras
    loadCommercializers();
});

// ========================================================================
// 11. GESTIÓN DE COMERCIALIZADORAS
// ========================================================================

let commercializers = [];
let editingCommercializerId = null;

function loadCommercializers() {
    const stored = localStorage.getItem('audit_pro_commercializers');
    commercializers = stored ? JSON.parse(stored) : [];
    console.log('[Commercializers] Cargadas', commercializers.length, 'comercializadoras');
    renderCommercializersList();
}

function saveCommercializersToStorage() {
    localStorage.setItem('audit_pro_commercializers', JSON.stringify(commercializers));
    console.log('[Commercializers] Guardadas en localStorage');
}

function renderCommercializersList() {
    const list = document.getElementById('commercializers-list');
    if (!list) return;

    if (commercializers.length === 0) {
        list.innerHTML = '<p style="text-align: center; color: #999; padding: 2rem;">No hay comercializadoras. Crea una nueva.</p>';
        return;
    }

    const html = commercializers.map((c, idx) => `
        <div class="card" style="margin-bottom: 1rem; padding: 1rem; border: 1px solid #e5e7eb; border-radius: 6px;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem;">
                <div>
                    <h3 style="margin: 0; font-size: 1.1rem;">${c.name}</h3>
                    <small style="color: #666;">ID: ${c.id} | Tarifa: ${c.tariffType || '2.0'}</small>
                </div>
                <div style="display: flex; gap: 0.5rem;">
                    <button class="btn primary" onclick="editCommercializer(${idx})" style="font-size: 0.8rem; padding: 0.4rem 0.8rem;">Editar</button>
                    <button class="btn secondary" onclick="deleteCommercializer(${idx})" style="font-size: 0.8rem; padding: 0.4rem 0.8rem; background-color: #ef4444; color: white; border: none;">Eliminar</button>
                </div>
            </div>
            
            <div style="display: grid; grid-template-columns: 1fr auto; gap: 2rem;">
                <div>
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.9rem; text-decoration: underline;">Precios de Energía (€/kWh)</h4>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; font-size: 0.85rem;">
                        ${getConfiguredEnergyPeriodsByTariff(c.tariffType || '2.0').map(p => `
                            <div>P${p}: <strong>${(c.energyPrices[p] || 0).toFixed(6)}</strong></div>
                        `).join('')}
                    </div>
                </div>
                <div>
                    <h4 style="margin: 0 0 0.5rem 0; font-size: 0.9rem; text-decoration: underline;">Precios de Potencia (€/kW)</h4>
                    <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; font-size: 0.85rem;">
                        ${getConfiguredPowerPeriodsByTariff(c.tariffType || '2.0').map(p => `
                            <div>P${p}: <strong>${(c.powerPrices[p] || 0).toFixed(6)}</strong></div>
                        `).join('')}
                    </div>
                </div>
            </div>
        </div>
    `).join('');

    list.innerHTML = html;
}

function openCommercializerModal(indexToEdit = null) {
    const modal = document.getElementById('commercializer-modal');
    const title = document.getElementById('commercializer-modal-title');
    if (!modal) { console.error('[Shop] Modal no encontrado'); return; }
    if (!title) { console.error('[Shop] Title no encontrado'); return; }

    editingCommercializerId = indexToEdit !== null ? indexToEdit : null;
    
    if (indexToEdit !== null && commercializers[indexToEdit]) {
        const c = commercializers[indexToEdit];
        title.innerText = `Editar: ${c.name}`;
        
        document.getElementById('commercializer-name').value = c.name;
        document.getElementById('commercializer-tariff-type').value = c.tariffType || '2.0';
        [1, 2, 3, 4, 5, 6].forEach(p => {
            document.getElementById(`energy-p${p}`).value = c.energyPrices[p] || '';
            document.getElementById(`power-p${p}`).value = c.powerPrices[p] || '';
        });
    } else {
        title.innerText = 'Nueva Comercializadora';
        document.getElementById('commercializer-name').value = '';
        document.getElementById('commercializer-tariff-type').value = '2.0';
        [1, 2, 3, 4, 5, 6].forEach(p => {
            document.getElementById(`energy-p${p}`).value = '';
            document.getElementById(`power-p${p}`).value = '';
        });
    }

    updateCommercializerPeriodFields();

    modalGuardUntil.commercializer = Date.now() + 250;
    modal.classList.remove('hidden');
}

function closeCommercializerModal() {
    const modal = document.getElementById('commercializer-modal');
    if (modal) modal.classList.add('hidden');
    editingCommercializerId = null;
}

function saveCommercializer() {
    const name = document.getElementById('commercializer-name').value.trim();
    const tariffType = document.getElementById('commercializer-tariff-type').value || '2.0';
    if (!name) {
        alert('Por favor ingresa un nombre de comercializadora.');
        return;
    }

    const energyPrices = {};
    const powerPrices = {};
    [1, 2, 3, 4, 5, 6].forEach(p => {
        energyPrices[p] = 0;
        powerPrices[p] = 0;
    });
    getConfiguredEnergyPeriodsByTariff(tariffType).forEach(p => {
        energyPrices[p] = parseFloat(document.getElementById(`energy-p${p}`).value) || 0;
    });
    getConfiguredPowerPeriodsByTariff(tariffType).forEach(p => {
        powerPrices[p] = parseFloat(document.getElementById(`power-p${p}`).value) || 0;
    });

    if (editingCommercializerId !== null) {
        // Editar existente
        commercializers[editingCommercializerId] = {
            id: commercializers[editingCommercializerId].id,
            name,
            tariffType,
            energyPrices,
            powerPrices
        };
        console.log(`[Commercializers] Actualizada comercializadora: ${name}`);
    } else {
        // Crear nueva
        const newCommercializer = {
            id: `comm_${Date.now()}`,
            name,
            tariffType,
            energyPrices,
            powerPrices
        };
        commercializers.push(newCommercializer);
        console.log(`[Commercializers] Creada nueva comercializadora: ${name}`);
    }

    saveCommercializersToStorage();
    renderCommercializersList();
    closeCommercializerModal();
}

function updateCommercializerPeriodFields() {
    const tariffTypeEl = document.getElementById('commercializer-tariff-type');
    if (!tariffTypeEl) return;
    const allowedEnergy = new Set(getConfiguredEnergyPeriodsByTariff(tariffTypeEl.value));
    const allowedPower = new Set(getConfiguredPowerPeriodsByTariff(tariffTypeEl.value));
    [1, 2, 3, 4, 5, 6].forEach(p => {
        const energyInput = document.getElementById(`energy-p${p}`);
        const powerInput = document.getElementById(`power-p${p}`);
        if (energyInput && energyInput.parentElement) {
            const visibleEnergy = allowedEnergy.has(p);
            energyInput.parentElement.style.display = visibleEnergy ? 'block' : 'none';
            if (!visibleEnergy) energyInput.value = '';
        }
        if (powerInput && powerInput.parentElement) {
            const visiblePower = allowedPower.has(p);
            powerInput.parentElement.style.display = visiblePower ? 'block' : 'none';
            if (!visiblePower) powerInput.value = '';
        }
    });
}

function editCommercializer(index) {
    openCommercializerModal(index);
}

function deleteCommercializer(index) {
    const name = commercializers[index]?.name || 'Comercializadora';
    if (confirm(`¿Estás seguro de que quieres eliminar "${name}"?`)) {
        commercializers.splice(index, 1);
        saveCommercializersToStorage();
        renderCommercializersList();
        console.log(`[Commercializers] Eliminada: ${name}`);
    }
}

// Cerrar modal al clicar fuera
window.addEventListener('click', (event) => {
    const modal = document.getElementById('commercializer-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.commercializer) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeCommercializerModal();
    }
});

function closeCompareSelectorModal() {
    const modal = document.getElementById('compare-selector-modal');
    if (modal) modal.classList.add('hidden');
    compareCurrentInvoiceIndex = null;
    compareSelectedCommercializers = [];
}

window.addEventListener('click', (event) => {
    const modal = document.getElementById('compare-selector-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.compareSelector) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeCompareSelectorModal();
    }
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('client-supply-invoice-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.clientSupply) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeClientSupplyInvoiceModal();
    }
});

// Exponer funciones globales para onclick handlers
window.openDetailModalFromHistory = openDetailModalFromHistory;
window.openClientSupplyInvoice = openClientSupplyInvoice;
window.closeClientSupplyInvoiceModal = closeClientSupplyInvoiceModal;
window.openCommercializerModal = openCommercializerModal;
window.closeCommercializerModal = closeCommercializerModal;
window.saveCommercializer = saveCommercializer;
window.updateCommercializerPeriodFields = updateCommercializerPeriodFields;
window.editCommercializer = editCommercializer;
window.deleteCommercializer = deleteCommercializer;

// Inicializar
console.log('[Init] Cargando comercializadoras...');
loadCommercializers();
renderCommercializersList();