
// --- GOOGLE DRIVE CONFIGURATION ---
// CREDENCIALES CONFIGURADAS
const DEVELOPER_KEY = 'AIzaSyACZ4t052cFJU_Nw1rJ0c5w-MjOkQ538n8'; // API Key
const CLIENT_ID = '401814876123-0h2kp6oj36p1oiugodc8vgacohmf8ibo.apps.googleusercontent.com'; // Client ID
const APP_ID = '401814876123'; // Project ID extracted from Client ID

// Scopes
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly'

let tokenClient;
let gapiInited = false;
let gisInited = false;
let invoices = []; // Global Store for CURRENTLY parsed invoices
let dbInvoices = []; // Global Store for ALL invoices (Database)
let pendingInvoices = []; // Global Store for anomalous invoices awaiting manual review (REMOVED logic)
window.pendingPdfFiles = new Map(); // In-memory map of dropped PDF File objects for viewing

let savedComparisons = []; // Global Store for Multi-Supply Saved Comparisons

// BOE Constants for Calculations (Global Scope)
const boePeajesExtPower = [0.063851, 0.003157, 0.002016, 0.001716, 0.001601, 0.001509];
const boeCargosExtPower = [0.004124, 0.000431, 0.000287, 0.000227, 0.000192, 0.000183];
const boePeajesExtEnergy = [0.030588, 0.024765, 0.015031, 0.010178, 0.008434, 0.006256];
const boeCargosExtEnergy = [0.028766, 0.019432, 0.009021, 0.004561, 0.003412, 0.002134];
let customLogoData = ""; // Logo is now handled server-side via LOGO_PLACEHOLDER injection in server.js

// Market Prices Configuration (Will be merged with LocalStorage)
const DEFAULT_MARKET_PRICES = {
    "fenie": { name: "Fenie Energía", p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, pp1: 0, pp2: 0, pp3: 0, pp4: 0, pp5: 0, pp6: 0 },
    "repsol": { name: "Repsol", p1: 0.138, p2: 0.115, p3: 0.105, p4: 0, p5: 0, p6: 0, pp1: 0.038, pp2: 0.005, pp3: 0, pp4: 0, pp5: 0, pp6: 0 },
    "iberdrola": { name: "Iberdrola", p1: 0.150, p2: 0.130, p3: 0.120, p4: 0, p5: 0, p6: 0, pp1: 0.040, pp2: 0.006, pp3: 0, pp4: 0, pp5: 0, pp6: 0 },
    "endesa": { name: "Endesa", p1: 0.148, p2: 0.128, p3: 0.118, p4: 0, p5: 0, p6: 0, pp1: 0.039, pp2: 0.005, pp3: 0, pp4: 0, pp5: 0, pp6: 0 }
};

let MARKET_PRICES = { ...DEFAULT_MARKET_PRICES };

function loadCustomProviders() {
    let stored = localStorage.getItem('custom_providers');
    if (!stored) {
        localStorage.setItem('custom_providers', JSON.stringify(DEFAULT_MARKET_PRICES));
        stored = JSON.stringify(DEFAULT_MARKET_PRICES);
    }
    MARKET_PRICES = JSON.parse(stored);
    
    // Migración: Asegurar que existen los campos de potencia
    Object.keys(MARKET_PRICES).forEach(id => {
        if (MARKET_PRICES[id].pp1 === undefined) {
            MARKET_PRICES[id].pp1 = 0; MARKET_PRICES[id].pp2 = 0; MARKET_PRICES[id].pp3 = 0;
            MARKET_PRICES[id].pp4 = 0; MARKET_PRICES[id].pp5 = 0; MARKET_PRICES[id].pp6 = 0;
        }
    });
}

function switchView(viewId) {
    console.log(`[Navigation] Switching to ${viewId}`);
    
    // 1. Hide all views
    document.querySelectorAll('.view').forEach(v => {
        v.classList.add('hidden');
    });
    
    // 2. Show the target view
    const target = document.getElementById(viewId);
    if (target) {
        target.classList.remove('hidden');
    } else {
        console.warn(`[Navigation] View with id "${viewId}" not found.`);
    }

    // 3. Update active state on nav-items
    document.querySelectorAll('.nav-item').forEach(btn => {
        if (btn.getAttribute('data-view') === viewId) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Event Listeners are initialized in DOMContentLoaded at the end of the file

// --- GOOGLE DRIVE LOGIC ---

// Load Google Libraries
function gapiLoaded() {
    gapi.load('client:picker', initializeGapiClient);
}

async function initializeGapiClient() {
    await gapi.client.init({
        apiKey: DEVELOPER_KEY,
        discoveryDocs: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    });
    gapiInited = true;
}

function gisLoaded() {
    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID,
        scope: SCOPES,
        callback: '', // Defined later
    });
    gisInited = true;
}

function handleAuthClick() {
    const gapiStatus = window.gapi ? "Cargado" : "NO CARGADO";
    const googleStatus = window.google ? "Cargado" : "NO CARGADO";

    if (!window.gapi || !window.google) {
        alert(`Error de carga:\nGAPI: ${gapiStatus}\nGoogle Identity: ${googleStatus}\n\nPor favor, verifica si tienes un bloqueador de anuncios (AdBlock) activado o problemas de conexión.`);
        return;
    }

    if (DEVELOPER_KEY === 'YOUR_API_KEY' || CLIENT_ID === 'YOUR_CLIENT_ID') {
        alert("Falta configuración: Por favor, edita el archivo script.js y añade tu API KEY y CLIENT ID.");
        return;
    }

    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) {
            throw (resp);
        }
        createPicker(resp.access_token);
    };

    if (gapi.client.getToken() === null) {
        tokenClient.requestAccessToken({ prompt: 'consent' });
    } else {
        tokenClient.requestAccessToken({ prompt: '' });
    }
}

function createPicker(accessToken) {
    const view = new google.picker.View(google.picker.ViewId.DOCS);
    view.setMimeTypes("application/pdf");

    const picker = new google.picker.PickerBuilder()
        .enableFeature(google.picker.Feature.NAV_HIDDEN)
        .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
        .setAppId(APP_ID)
        .setOAuthToken(accessToken)
        .addView(view)
        .addView(new google.picker.DocsUploadView())
        .setDeveloperKey(DEVELOPER_KEY)
        .setCallback(pickerCallback)
        .build();
    picker.setVisible(true);
}

async function pickerCallback(data) {
    if (data.action === google.picker.Action.PICKED) {
        const documents = data[google.picker.Document];
        const loadingIndicator = document.getElementById('loading');
        const dashboard = document.getElementById('dashboard');

        loadingIndicator.classList.remove('hidden');
        dashboard.classList.add('hidden');
        invoices = [];

        try {
            for (const doc of documents) {
                const fileId = doc[google.picker.Document.ID];
                const fileName = doc[google.picker.Document.NAME];
                const accessToken = gapi.client.getToken().access_token;

                const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
                    headers: { 'Authorization': `Bearer ${accessToken}` }
                });
                const blob = await response.blob();
                const file = new File([blob], fileName, { type: 'application/pdf' });
                const invoiceData = await parsePDF(file);
                if (invoiceData) invoices.push(invoiceData);
            }
            renderDashboard();
        } catch (err) {
            console.error("Error downloading from Drive:", err);
            alert("Error al descargar archivos desde Drive.");
        } finally {
            if (loadingIndicator) loadingIndicator.classList.add('hidden');
            if (dashboard) dashboard.classList.remove('hidden');
        }
    }
}

let gapiLoading = false;
let gisLoading = false;

function tryInitGoogle() {
    if (!gapiInited && !gapiLoading && window.gapi) {
        gapiLoading = true;
        gapi.load('client:picker', initializeGapiClient);
    }
    if (!gisInited && !gisLoading && window.google) {
        gisLoading = true;
        gisLoaded();
    }
    if (!gapiInited || !gisInited) {
        setTimeout(tryInitGoogle, 500);
    }
}

function handleDrop(e) {
    e.preventDefault();
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (files.length > 0) processFiles(files);
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files).filter(f => f.type === 'application/pdf');
    if (files.length > 0) processFiles(files);
}

async function processFiles(files) {
    const loadingIndicator = document.getElementById('loading');
    const dashboard = document.getElementById('dashboard');
    const resultsTableBody = document.querySelector('#results-table tbody');

    if (loadingIndicator) loadingIndicator.classList.remove('hidden');
    if (dashboard) dashboard.classList.add('hidden');
    if (resultsTableBody) resultsTableBody.innerHTML = '';
    invoices = [];

    let processedCount = 0;
    const totalFiles = files.length;

    const updateProgress = () => {
        const loadingText = document.querySelector('.loading-spinner p');
        if (loadingText) loadingText.textContent = `Procesando facturas... (${processedCount}/${totalFiles})`;
    };

    try {
        for (const file of files) {
            try {
                if (processedCount > 0) await new Promise(r => setTimeout(r, 1000));
                window.pendingPdfFiles.set(file.name, file);
                const data = await parsePDF(file);
                if (data) {
                    data._sourceFileName = file.name;
                    invoices.push(data);
                }
            } catch (fileError) {
                console.error(`Error processing file ${file.name}:`, fileError);
            } finally {
                processedCount++;
                updateProgress();
            }
        }

        if (invoices.length > 0) {
            let passedInvoices = [];
            for (const inv of invoices) {
                passedInvoices.push(inv);
            }

            // Guardar todas directamente como espejo
            if (passedInvoices.length > 0) {
                saveToDatabase(passedInvoices);
            }

            switchView('dashboard');
            renderDashboard();
        } else {
            alert("No se pudo extraer información de ninguna factura.");
        }
    } catch (error) {
        console.error("Critical Error:", error);
        alert("Hubo un error crítico al iniciar el proceso: " + error.message);
    } finally {
        if (loadingIndicator) loadingIndicator.classList.add('hidden');
        const loadingText = document.querySelector('.loading-spinner p');
        if (loadingText) loadingText.textContent = 'Analizando facturas con IA...';
    }
}

async function parsePDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const linesMap = new Map();

        for (const item of textContent.items) {
            const y = Math.round(item.transform[5]);
            if (!linesMap.has(y)) {
                linesMap.set(y, []);
            }
            linesMap.get(y).push({
                x: item.transform[4],
                str: item.str
            });
        }

        const sortedYs = Array.from(linesMap.keys()).sort((a, b) => b - a);

        for (const y of sortedYs) {
            const rowItems = linesMap.get(y);
            rowItems.sort((a, b) => a.x - b.x);
            const lineText = rowItems.map(item => item.str).join(" ");
            fullText += lineText + "\n";
        }
    }

    return await extractInvoiceDataWithAI(fullText, file.name);
}

const AI_MODEL = 'openai';

async function extractInvoiceDataWithAI(text, fileName) {
    const prompt = `Extrae los datos de esta factura de luz española. Devuelve un JSON estricto:
{
  "invoiceNum": "string",
  "period": "fecha inicio - fecha fin",
  "billingDays": number,
  "clientName": "Nombre completo del TITULAR/CLIENTE (quien paga)",
  "comercializadoraName": "Nombre de la empresa eléctrica emisor de la factura",
  "cups": "string",
  "supplyAddress": "Dirección completa del punto de suministro (donde se recibe el servicio)",
  "tariffType": "2.0TD/3.0TD/etc",
  "contractedPower": [P1_kW_exacto, P2_kW_exacto, P3_kW_exacto, P4_kW_exacto, P5_kW_exacto, P6_kW_exacto],
  "consumptionItems": [P1_kWh_exacto, P2_kWh_exacto, P3_kWh_exacto, P4_kWh_exacto, P5_kWh_exacto, P6_kWh_exacto],
  "energyMarketRates": [precios mercado unitarios EXACTOS 6 decimales],
  "energyPeajeRates": [precios peajes unitarios EXACTOS 6 decimales],
  "energyCargoRates": [precios cargos unitarios EXACTOS 6 decimales],
  "powerPeajeRates": [precios potencia peaje EXACTOS 6 decimales],
  "powerCargoRates": [precios potencia cargo EXACTOS 6 decimales],
  "powerFenieRates": [precios potencia margen EXACTOS 6 decimales],
  "energyTotalVariable_PDF": number,
  "powerTotalFixed_PDF": number,
  "rentCost": number,
  "socialBond": number,
  "electricTax": number,
  "otherSpecificCost": number,
  "adjustments": [{"description": "otros conceptos extras NO capturados en campos específicos", "amount": number}],
  "vatAmount_PDF": number,
  "totalInvoice_PDF": number,

  "hasTollBreakdown": boolean
}
IMPORTANTE: 
1. CLIENTE vs COMERCIALIZADORA: No los confundas. El 'clientName' debe ser el TITULAR de la cuenta (normalmente aparece al lado de la dirección de suministro). La 'comercializadoraName' es la compañía que envía la factura (ej. Atenco, Iberdrola, etc.).
2. CAPTURA CANTIDADES EXACTAS CON DECIMALES (ej. 480,17 kWh o 4,6 kW) si figuran así en el papel.
3. CAPTURA PRECIOS UNITARIOS CON TODOS SUS DECIMALES (mínimo 6 si existen, ej. 0,230000).
4. REGLA DE ORO DE FÓRMULAS (POTENCIA): Cada periodo (P1, P2... P6) es INDEPENDIENTE. Si la factura tiene dos fórmulas (ej. P1: 11,5 kW * 0,086 && P2: 11,5 kW * 0,045), DEBES extraer una para P1 y otra para P2. NUNCA las mezcles ni las sumes en una sola línea. Pon el valor de cada fórmula en el índice correspondiente (0 para P1, 1 para P2, etc.) de "powerFenieRates" (y rP=0, rC=0 si no hay desglose).
5. NO INCLUYAS en "adjustments" ningún concepto que ya hayas capturado en "rentCost" (Contador), "socialBond" (Bono Social) o "electricTax" (Impuesto Eléctrico).
6. CRITICO - 'Coste de Gestion': La factura puede mostrar "Otros conceptos" con un TOTAL a la derecha (ej. 6,14 EUR) y debajo los sub-items: "Coste de gestion: 5,60 EUR" y "Bono Social: 0,54 EUR". Captura el sub-item "Coste de gestion" (5,60 EUR) en "otherSpecificCost" y el "Bono Social" en "socialBond". NUNCA pongas el total de la seccion (6,14 EUR) en "otherSpecificCost".
7. Captura el TOTAL DE SECCIÓN si viene resaltado (ej. "Total energía: 282,65" va a 'energyTotalVariable_PDF'). NO REALICES SUMAS POR TU CUENTA. Si una línea dice 282,65€, úsala.
8. Captura el IVA/IGIC exacto en "vatAmount_PDF". NUNCA lo sumes al Impuesto Eléctrico. Si la factura dice "Impuesto de Aplicación: [valor]", captura ese valor exacto.
9. El campo "totalInvoice_PDF" es el TOTAL ABSOLUTO A PAGAR (Importe Total Factura). NO CONFUNDAS con la "Base Imponible". Si hay duda, busca el número más grande al final de la hoja.
10. El campo "electricTax" es el importe del 'Impuesto sobre la electricidad' (ej. 4,75€).
11. El campo "socialBond" es el importe de 'Financiación del Bono Social' (ej. 0,54€).
12. LÍMITES DE SANIDAD (ENERGÍA): Los peajes/cargos unitarios para 2.0TD suelen ser < 0.10€. Si ves un número mayor a 0.15€/kWh en "Peajes", es PROBABLEMENTE el precio total. NO lo sumes dos veces con el mercado.
13. POTENCIA P1-P6: Captura TODOS los periodos existentes. Si hay P1 y P2 (muy común en 2.0TD), RELLENA AMBOS ÍNDICES [i=0 e i=1]. NO ignores la segunda línea de potencia.
14. CRITICO - CAMPO "powerTotalFixed_PDF": Captura el total de la sección de potencia (ej. "Facturación por potencia: 42,72 €"). ES OBLIGATORIO para validar los desgloses.
15. PRECIO TOTAL vs COMPONENTES: Si la factura da el "Precio Total" (ej. 0.23€) y también desglosa peaje/cargos, úsalos solo si SUMAN ese total. Si no suman, confía en el Precio Total y pon 0 en los desgloses para evitar duplicidad.
16. TOTALES DE SECCIÓN: Captura el importe final resaltado a la derecha de cada bloque (ej. 81,55€ en Energía, 19,32€ en Potencia) en "energyTotalVariable_PDF" y "powerTotalFixed_PDF".
17. REGLA DE ORO DE IMPORTES: Si ves un importe total pero no los precios unitarios, intenta calcularlos: precio = importe / (consumo o (potencia*días)). LO IMPORTANTE ES NO DEJARLO EN 0 si hay importe.
18. UBICACIÓN: Captura la dirección exacta del suministro que suele figurar junto al CUPS o el nombre del titular.

TEXTO DE LA FACTURA:
${text.substring(0, 15000)}
`;

    try {
        let jsonStr = "";
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                prompt: prompt
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Server Error: ${response.status} - ${errorText}`);
        }

        const data = await response.json();
        if (data.error) throw new Error("Error OpenAI: " + data.error);
        jsonStr = data.choices[0].message.content;

        if (!jsonStr) throw new Error("La IA no devolvió un JSON válido.");
        
        // Limpiar posibles bloques Markdown
        jsonStr = jsonStr.replace(/```json\n?|```/g, '').trim();
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
        }

        let inv;
        try {
            inv = JSON.parse(jsonStr);
        } catch (parseError) {
            console.error("Malformed JSON from AI:", jsonStr);
            throw new Error("Error al interpretar los datos: Formato JSON no válido.");
        }

        // --- INICIALIZACIÓN DE VARIABLES PARA CÁLCULOS ---
        const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [0,0,0,0,0,0];
        const days = inv.billingDays || 0;
        const pwr = Array.isArray(inv.contractedPower) ? inv.contractedPower : [inv.power || 0, 0, 0, 0, 0, 0];
        
        inv.fileName = fileName;
        inv.clientAddress = inv.supplyAddress || inv.clientAddress || 'N/D';

        // --- FALLBACK DE POTENCIA INTELIGENTE (RECUPERACIÓN DE PERIODOS FALTANTES) ---
        // Si el total del papel es mayor que lo calculado y hay periodos con kW pero sin precio (ej. solo pilló P1)
        const paperPowerTotal = inv.powerTotalFixed_PDF || (inv.powerTotalFixed ? inv.powerTotalFixed : 0);
        let currentCalcPower = (pwr || []).reduce((sum, kw, i) => {
            const rP = (inv.powerPeajeRates && inv.powerPeajeRates[i]) || 0;
            const rC = (inv.powerCargoRates && inv.powerCargoRates[i]) || 0;
            const rF = (inv.powerFenieRates && inv.powerFenieRates[i]) || 0;
            return sum + (kw * (days || 30) * (rP + rC + rF));
        }, 0);

        if (paperPowerTotal > 0 && (paperPowerTotal - currentCalcPower) > 0.01) {
            const missingIndices = (pwr || []).map((kw, i) => {
                const rP = (inv.powerPeajeRates && inv.powerPeajeRates[i]) || 0;
                const rC = (inv.powerCargoRates && inv.powerCargoRates[i]) || 0;
                const rF = (inv.powerFenieRates && inv.powerFenieRates[i]) || 0;
                return (kw > 0 && (rP + rC + rF) === 0) ? i : -1;
            }).filter(idx => idx !== -1);

            if (missingIndices.length > 0) {
                const gap = paperPowerTotal - currentCalcPower;
                const totalMissingUnits = missingIndices.reduce((sum, idx) => sum + (pwr[idx] * (days || 30)), 0);
                if (totalMissingUnits > 0) {
                    const estimatedRate = Math.round((gap / totalMissingUnits) * 1000000) / 1000000;
                    console.warn(`[Auditoria] Recuperando Power P2+: Llenando GAP de ${gap.toFixed(2)}€ con rate ${estimatedRate}`);
                    missingIndices.forEach(idx => {
                        if (!inv.powerFenieRates) inv.powerFenieRates = [0,0,0,0,0,0];
                        inv.powerFenieRates[idx] = estimatedRate;
                    });
                }
            }
        }

        // --- VARIABLES DE CHEQUEO (GLOBALES AL SCOPE DE AUDITORÍA) ---
        const paperT_check = inv.totalInvoice_PDF || 0;
        const paperEnergyTotal = inv.energyTotalVariable_PDF || (inv.energyTotalVariable ? inv.energyTotalVariable : 0);


        // 1. Energía Mercado (Suma PRODUCTO sin redondear antes del total)
        const marketLinesRaw = c.map((kwh, i) => {
            if (!kwh) return 0;
            let rate = (inv.energyMarketRates && inv.energyMarketRates[i]) || 0;
            if (rate > 1.0) rate = Math.round((rate / kwh) * 1000000) / 1000000;
            return kwh * rate;
        });
        inv.energyMarketItems = marketLinesRaw.map(v => Math.round(v * 100) / 100);
        inv.energyMarketTotal = Math.round(inv.energyMarketItems.reduce((a,b)=>a+b, 0) * 100) / 100;

        // 2. Peajes y Cargos (Suma PRODUCTO sin redondear antes del total)
        const energyTollsLinesRaw = c.map((kwh, i) => {
            if (!kwh) return 0;
            let rP = (inv.energyPeajeRates && inv.energyPeajeRates[i]) || 0;
            let rC = (inv.energyCargoRates && inv.energyCargoRates[i]) || 0;
            if (rP > 1.0) rP = Math.round((rP / kwh) * 1000000) / 1000000;
            if (rC > 1.0) rC = Math.round((rC / kwh) * 1000000) / 1000000;
            
            // FRENO DE SEGURIDAD: Si el peaje parece el total (> 0.15 para 2.0TD) y ya tenemos mercado, ignorarlo o tratarlo con precaución
            if (rP > 0.15 && inv.energyMarketRates && inv.energyMarketRates[i] > 0) {
                 rP = 0; // Evitamos duplicidad explosiva
            }
            return kwh * (rP + rC);
        });
        inv.energyTollsItems = energyTollsLinesRaw.map(v => Math.round(v * 100) / 100);
        inv.energyTollsTotal = Math.round(inv.energyTollsItems.reduce((a,b)=>a+b, 0) * 100) / 100;
        
        // --- ANCLAJE DE ENERGÍA (ESPEJO 1:1) ---
        // BLINDAJE ANTI-DISPARATES: Si el total del papel es mayor que lo calculado y no hay desgloses claros
        let finalTollsTotal = inv.energyTollsTotal;
        let finalMarketTotal = inv.energyMarketTotal;
        let calcEnergyTotal = Math.round((finalMarketTotal + finalTollsTotal) * 100) / 100;
        
        if (paperEnergyTotal > 0 && (calcEnergyTotal === 0 || Math.abs(calcEnergyTotal - paperEnergyTotal) > 0.05)) {
            inv.energyCost = paperEnergyTotal;
            // Si el desglose de mercado dio 0 pero tenemos un total en papel, back-calculamos el rate para la UI
            if (finalMarketTotal === 0 || inv.energyMarketItems.every(v => v === 0)) {
                const marketGap = Math.round((paperEnergyTotal - finalTollsTotal) * 100) / 100;
                const totalConsumption = c.reduce((a,b) => a+b, 0);
                if (totalConsumption > 0) {
                    const effectiveRate = Math.round((marketGap / totalConsumption) * 1000000) / 1000000;
                    if (!inv.energyMarketRates) inv.energyMarketRates = [0,0,0,0,0,0];
                    c.forEach((kwh, i) => {
                        if (kwh > 0 && (inv.energyMarketRates[i] || 0) === 0) {
                            inv.energyMarketRates[i] = effectiveRate;
                        }
                    });
                    // Recalculamos items para consistencia interna
                    inv.energyMarketItems = c.map((kwh, i) => Math.round(kwh * (inv.energyMarketRates[i]||0) * 100) / 100);
                    inv.energyMarketTotal = Math.round(inv.energyMarketItems.reduce((a,b)=>a+b, 0) * 100) / 100;
                }
            }
        } else {
            inv.energyCost = calcEnergyTotal;
        }

        // 3. Potencia
        let powerLinesRaw = pwr.map((kw, i) => {
            if (!kw || !days) return 0;
            let rP = (inv.powerPeajeRates && inv.powerPeajeRates[i]) || 0;
            let rC = (inv.powerCargoRates && inv.powerCargoRates[i]) || 0;
            let rF = (inv.powerFenieRates && inv.powerFenieRates[i]) || 0;
            return kw * days * (rP + rC + rF);
        });

        // Guardamos los ratios reales usados para que la UI pueda mostrarlos (FÓRMULA)
        inv.currentPowerRates = [0,1,2,3,4,5].map(i => {
            let rP = (inv.powerPeajeRates && inv.powerPeajeRates[i]) || 0;
            let rC = (inv.powerCargoRates && inv.powerCargoRates[i]) || 0;
            let rF = (inv.powerFenieRates && inv.powerFenieRates[i]) || 0;
            return rP + rC + rF;
        });

        inv.powerCostItems = powerLinesRaw.map(v => Math.round(v * 100) / 100);
        let calcPowerTotal = Math.round(powerLinesRaw.reduce((a,b)=>a+b, 0) * 100) / 100;

        // --- ANCLAJE DE POTENCIA (ESPEJO 1:1) ---
        if (paperPowerTotal > 0 && (calcPowerTotal === 0 || Math.abs(calcPowerTotal - paperPowerTotal) > 0.05)) {
            inv.powerCost = paperPowerTotal;
            // Si el desglose dio 0 pero tenemos un total en papel, back-calculamos el rate para la UI
            if (calcPowerTotal === 0 || inv.powerCostItems.every(v => v === 0)) {
                const totalMissingUnits = pwr.reduce((sum, kw, i) => sum + (kw * (days || 30)), 0);
                if (totalMissingUnits > 0) {
                    const effectiveRate = Math.round((paperPowerTotal / totalMissingUnits) * 1000000) / 1000000;
                    if (!inv.powerFenieRates) inv.powerFenieRates = [0,0,0,0,0,0];
                    pwr.forEach((kw, i) => {
                        if (kw > 0 && (inv.powerFenieRates[i] || 0) === 0) {
                            inv.powerFenieRates[i] = effectiveRate;
                        }
                    });
                    // Recalculamos para consistencia
                    inv.powerCostItems = pwr.map((kw, i) => Math.round(kw * days * (inv.powerFenieRates[i]||0) * 100) / 100);
                    inv.powerCost = Math.round(inv.powerCostItems.reduce((a,b)=>a+b, 0) * 100) / 100;
                    // También actualizamos los ratios de auditoría UI
                    inv.currentPowerRates = [0,1,2,3,4,5].map(i => {
                        let rP = (inv.powerPeajeRates && inv.powerPeajeRates[i]) || 0;
                        let rC = (inv.powerCargoRates && inv.powerCargoRates[i]) || 0;
                        let rF = (inv.powerFenieRates && inv.powerFenieRates[i]) || 0;
                        return rP + rC + rF;
                    });
                }
            }
        } else {
            inv.powerCost = calcPowerTotal;
        }

        console.log("DEBUG - AI Extraction Result:", inv);

        inv.vat = Math.round((inv.vatAmount_PDF || 0) * 100) / 100;

        // 3. Corrección de "Doble Contado" en Otros Conceptos (Caso Canaluz/Fenie)
        // Si el total de la sección (ej. 6.14) se extrajo en otherSpecificCost 
        // y el bono social (0.54) también se extrajo aparte, el total sobrará 0.54.
        const rawOSC = inv.otherSpecificCost || 0;
        const rawSB = inv.socialBond || 0;
        if (rawOSC > 0 && rawSB > 0) {
            const corrected = Math.round((rawOSC - rawSB) * 100) / 100;
            
            // Calculamos el total con y sin la corrección
            const baseCalcWithoutOthers = (inv.energyCost||0) + (inv.powerCost||0) + (inv.rentCost||0) + (inv.electricTax||0) + rawSB + (inv.vatAmount_PDF||0);
            const totalWithOriginal = Math.round((baseCalcWithoutOthers + rawOSC) * 100) / 100;
            const totalWithCorrection = Math.round((baseCalcWithoutOthers + corrected) * 100) / 100;

            // Solo aplicamos la corrección si es la ÚNICA forma de que el total cuadre perfectamente (Tolerancia 0)
            if (paperT_check > 0 && Math.abs(totalWithCorrection - paperT_check) < 0.01 && Math.abs(totalWithOriginal - paperT_check) >= 0.01) {
                console.warn('[Auditoria] Auto-corrección: Se detectó que otherSpecificCost incluía el socialBond. Ajustado a ' + corrected);
                inv.otherSpecificCost = corrected;
            }
        }

        // Error 2: Transposición de dígitos (ej. 5,60 → 5,06, o 6,14 → 6,41)
        // Si el valor tiene dos dígitos decimales y parece una transposición, verificamos contra el total del PDF
        const oscAfterFix1 = inv.otherSpecificCost || 0;
        if (oscAfterFix1 > 0) {
            // Construimos la versión con dígitos intercambiados
            const s = oscAfterFix1.toFixed(2);  // ej. "5.06"
            const parts = s.split('.');
            if (parts.length === 2 && parts[1].length === 2) {
                const swapped = parseFloat(parts[0] + '.' + parts[1][1] + parts[1][0]);  // ej. "5.60"
                // Si el valor con dígitos intercambiados hace que el total cuadre mejor con el PDF total, usar el corregido
                if (paperT_check > 0 && swapped !== oscAfterFix1) {
                    const calcWithOriginal = (inv.energyCost||0) + (inv.powerCost||0) + (inv.rentCost||0) + (inv.electricTax||0) + rawSB + oscAfterFix1 + (inv.vatAmount_PDF||0);
                    const calcWithSwapped  = (inv.energyCost||0) + (inv.powerCost||0) + (inv.rentCost||0) + (inv.electricTax||0) + rawSB + swapped  + (inv.vatAmount_PDF||0);
                    // Solo corregimos si la transposición hace que el total cuadre PERFECTAMENTE (Tolerancia 0)
                    if (Math.abs(calcWithSwapped - paperT_check) < 0.01 && Math.abs(calcWithOriginal - paperT_check) >= 0.01) {
                        console.warn('[Auditoria] Transposición detectada y corregida en otherSpecificCost: ' + oscAfterFix1 + ' → ' + swapped);
                        inv.otherSpecificCost = swapped;
                    }
                }
            }
        }

        // 4. Limpieza de Duplicados en Otros Conceptos (BLINDAJE AGRESIVO)
        const bond = inv.socialBond || 0;
        let specCost = inv.otherSpecificCost || 0;
        if (specCost > 0 && Math.abs(specCost - inv.vat) < 0.01) specCost = 0;
        inv.otherSpecificCost = specCost;

        const baseOthersSum = (inv.rentCost||0) + (inv.electricTax||0) + (inv.socialBond||0) + (inv.otherSpecificCost||0);
        
        // Vaciamos adjustments si sus valores ya están en los campos específicos (ej. 6,14€)
        let finalAdjustments = (inv.adjustments || []).filter(adj => {
            const desc = adj.description.toLowerCase();
            const val = adj.amount || 0;
            const isDuplicate = (inv.rentCost > 0 && desc.includes('contador')) || 
                                (inv.socialBond > 0 && desc.includes('bono social')) || 
                                (inv.electricTax > 0 && desc.includes('eléctrico')) || 
                                (inv.otherSpecificCost > 0 && desc.includes('gestión')) ||
                                (inv.vat > 0 && (desc.includes('aplicación') || desc.includes('igic') || desc.includes('iva'))) ||
                                (Math.abs(val - (inv.otherSpecificCost + inv.socialBond)) < 0.01); // Anti-duplicado 6,14€
            return !isDuplicate && val !== 0;
        });

        inv.adjustments = finalAdjustments;
        const adjTotal = inv.adjustments.reduce((a, b) => a + (b.amount || 0), 0);

        inv.othersCost = Math.round((baseOthersSum + inv.vat + adjTotal) * 100) / 100;
        
        // TOTAL FINAL - AUDITORIA OBLIGATORIA
        // Calculamos siempre el total desde los componentes (fuente de verdad interna)
        // othersCost ya incluye adjustments y vat, por lo que la suma es: energia + potencia + otros
        const calcTotal = Math.round(((inv.energyCost||0) + (inv.powerCost||0) + (inv.othersCost||0)) * 100) / 100;
        const paperTotal = inv.totalInvoice_PDF || inv.totalInvoice || 0;
        
        // Guardamos ambos valores: el calculado por nosotros y el del PDF
        inv.totalCalculated = calcTotal;         // Lo que calculamos nosotros
        inv.totalInvoice_PDF = paperTotal;       // Lo que dice el papel
        
        // AUDITORIA AUTOMATICA: comparamos ambos
        const discrepancy = Math.round((calcTotal - paperTotal) * 100) / 100;
        if (paperTotal > 0 && Math.abs(discrepancy) >= 0.01) {
            // HAY DISCREPANCIA - guardamos el flag para mostrar alerta
            inv._auditDiscrepancy = discrepancy;
            inv._auditStatus = 'ERROR';
            
            // Blindaje final: Si el error es EXACTAMENTE igual al IVA (IA confusión Base Imponible), avisamos
            if (Math.abs(discrepancy - (inv.vatAmount_PDF || 0)) < 0.01) {
                console.warn('[Auditoria] Discrepancia por IVA detectada en ' + (inv.invoiceNum || '?') + '. La IA capturó Base Imponible como Total.');
            } else {
                console.warn('[AUDITORIA] Discrepancia detectada en factura ' + (inv.invoiceNum || '?') + 
                    ': Calculado=' + calcTotal + ' EUR, PDF=' + paperTotal + ' EUR, Diferencia=' + discrepancy + ' EUR');
            }
        } else if (paperTotal === 0) {
            // No se pudo extraer el total del PDF — también es un problema
            inv._auditDiscrepancy = null;
            inv._auditStatus = 'NO_PDF_TOTAL';
        } else {
            // TODO OK
            inv._auditDiscrepancy = 0;
            inv._auditStatus = 'OK';
        }
        
        // Mapeo de nombres para la UI
        inv.providerName = inv.comercializadoraName || inv.providerName || 'N/D';
        
        const sumArr = (arr) => Array.isArray(arr) ? arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0) : 0;
        inv.consumption = sumArr(inv.consumptionItems);

        return inv;

    } catch (e) {
        console.error("AI Error", e);
        alert("Error al procesar factura con IA.");
        return null;
    }
}

window.isInvoiceInHistory = function(inv) {
    if (!inv || !dbInvoices) return false;
    const cleanNum = (inv.invoiceNum || "").trim().toUpperCase();
    return dbInvoices.some(dbInv => {
        const dbCleanNum = (dbInv.invoiceNum || "").trim().toUpperCase();
        if (cleanNum && dbCleanNum && cleanNum === dbCleanNum) return true;
        return (dbInv.cups === inv.cups && dbInv.period === inv.period);
    });
};

window.isInvoiceAlreadyCompared = function(inv) {
    if (!inv || !savedComparisons) return false;
    // Un suministro se considera comparado si su CUPS ya existe en la lista de comparativas guardadas
    return savedComparisons.some(comp => comp.cups === inv.cups);
};

window.toggleAllInvoicesSelections = function(checked, source = 'dashboard') {
    const className = source === 'history' ? '.history-checkbox' : '.invoice-checkbox';
    const checkboxes = document.querySelectorAll(className);
    checkboxes.forEach(cb => cb.checked = checked);
    window.handleInvoiceSelectionChange(source);
};

window.handleInvoiceSelectionChange = function(source = 'dashboard') {
    const className = source === 'history' ? '.history-checkbox' : '.invoice-checkbox';
    const btnId = source === 'history' ? 'batch-compare-history-btn' : 'batch-compare-btn';
    const selectAllId = source === 'history' ? 'select-all-history-checkbox' : 'select-all-checkbox';
    
    const selectedCount = document.querySelectorAll(`${className}:checked`).length;
    const batchBtn = document.getElementById(btnId);
    if (batchBtn) {
        batchBtn.textContent = `⚖️ Comparar Selección (${selectedCount})`;
        batchBtn.style.display = selectedCount > 0 ? 'inline-block' : 'none';
    }

    const selectAllCb = document.getElementById(selectAllId);
    if (selectAllCb) {
        const totalChecked = document.querySelectorAll(`${className}:checked`).length;
        const totalCheckboxes = document.querySelectorAll(className).length;
        selectAllCb.checked = totalCheckboxes > 0 && totalChecked === totalCheckboxes;
        selectAllCb.indeterminate = totalChecked > 0 && totalChecked < totalCheckboxes;
    }
};

window.addSelectedToComparison = function(source = 'dashboard') {
    const className = source === 'history' ? '.history-checkbox' : '.invoice-checkbox';
    const selectedIndices = Array.from(document.querySelectorAll(`${className}:checked`)).map(cb => parseInt(cb.dataset.index));
    if (selectedIndices.length === 0) return;

    let targetId;
    if (source === 'history') {
        targetId = document.getElementById('history-target-provider-select').value;
    } else {
        const dashboardSelect = document.getElementById('dashboard-target-provider-select');
        targetId = (dashboardSelect && dashboardSelect.value) ? dashboardSelect.value : document.getElementById('target-provider-select').value;
    }
    
    const target = MARKET_PRICES[targetId];
    if (!target) {
        alert("Por favor, selecciona una comercializadora de destino primero.");
        if (source !== 'history') switchView('compare-view');
        return;
    }

    let addedCount = 0;
    let skippedCount = 0;

    selectedIndices.forEach(idx => {
        let inv;
        if (source === 'history') {
            // Re-evaluamos DisplayInvoices para el historial (misma lógica que renderHistory)
            const clientFilter = document.getElementById('history-client-filter');
            const cupsFilter = document.getElementById('history-cups-filter');
            const tariffFilter = document.getElementById('history-tariff-filter');
            
            let displayInvoices = [...dbInvoices];
            displayInvoices.sort((a, b) => {
                const getDate = (str) => {
                    if (!str) return 0;
                    const match = str.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
                    return match ? new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime() : 0;
                };
                return getDate(b.period) - getDate(a.period);
            });
            if (clientFilter && clientFilter.value !== 'ALL') displayInvoices = displayInvoices.filter(i => (i.clientName || 'N/D') === clientFilter.value);
            if (cupsFilter && cupsFilter.value !== 'ALL') displayInvoices = displayInvoices.filter(i => (i.cups || 'N/D') === cupsFilter.value);
            if (tariffFilter && tariffFilter.value !== 'ALL') displayInvoices = displayInvoices.filter(i => (i.tariffType || '').includes(tariffFilter.value));
            
            inv = displayInvoices[idx];
        } else {
            inv = invoices[idx];
        }

        if (!inv) return;

        if (savedComparisons.find(c => c.cups === inv.cups)) {
            skippedCount++;
            return;
        }

        const compData = window.calculateInvoiceComparison(inv, target);
        if (compData) {
            savedComparisons.push(compData);
            addedCount++;
        }
    });

    if (addedCount > 0) {
        localStorage.setItem('audit_pro_comparisons', JSON.stringify(savedComparisons));
        renderSavedComparisons();
        if (source === 'history') renderHistory(); else renderDashboard();
        
        alert(`${addedCount} suministros añadidos al reporte comercial.${skippedCount > 0 ? ` (${skippedCount} ya estaban en el reporte)` : ''}`);
        switchView('compare-view');
        
        // Reset selection
        const selectAllId = source === 'history' ? 'select-all-history-checkbox' : 'select-all-checkbox';
        const selectAllCb = document.getElementById(selectAllId);
        if (selectAllCb) selectAllCb.checked = false;
        document.querySelectorAll(className).forEach(cb => cb.checked = false);
        window.handleInvoiceSelectionChange(source);
    } else if (skippedCount > 0) {
        alert("Todos los suministros seleccionados ya están incluidos en el reporte comercial.");
    }
};

// Función auxiliar para calcular comparativa sin tocar UI (Extraída de runComparison)
window.calculateInvoiceComparison = function(ref, target) {
    if (!ref || !target) return null;

    // Obtener todas las facturas del mismo CUPS (del historial o de la subida actual)
    // Combinamos ambas fuentes para un reporte más completo
    const allAvailable = [...dbInvoices, ...invoices];
    const relatedInvoices = allAvailable.filter(inv => inv.cups === ref.cups);
    
    // Eliminar duplicados locales por periodo
    const uniqueByPeriod = [];
    const seenPeriods = new Set();
    relatedInvoices.forEach(inv => {
        if (!seenPeriods.has(inv.period)) {
            uniqueByPeriod.push(inv);
            seenPeriods.add(inv.period);
        }
    });

    uniqueByPeriod.sort((a, b) => {
        const getDate = (str) => {
            const m = (str || "").match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
            return m ? new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime() : 0;
        };
        return getDate(a.period) - getDate(b.period);
    });

    let totalCurrent = 0, totalProposed = 0, totalKWh = 0;
    let totalCurrentEnergy = 0, totalProposedEnergy = 0;
    let totalCurrentPower = 0, totalProposedPower = 0;
    let totalCurrentTolls = 0, totalProposedTolls = 0;
    let totalCurrentMarket = 0, totalProposedMarket = 0;
    let totalCurrentElectricTax = 0, totalProposedElectricTax = 0;
    let totalCurrentRentCost = 0, totalProposedRentCost = 0;
    let totalCurrentOtherSpecific = 0, totalProposedOtherSpecific = 0;
    let totalCurrentVat = 0, totalProposedVat = 0;

    const detailedData = uniqueByPeriod.map((inv) => {
        const is20 = (inv.tariffType || "").includes("2.0");
        const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [inv.consumption, 0, 0, 0, 0, 0];
        const billingDays = inv.billingDays || 0;
        const pwr = Array.isArray(inv.contractedPower) ? inv.contractedPower : [0,0,0,0,0,0];

        totalCurrent += (inv.totalCalculated || 0);
        totalKWh += (inv.consumption || 0);
        totalCurrentEnergy += (inv.energyCost || 0);
        totalCurrentPower += (inv.powerCost || 0);

        // PROPUESTA
        let propMarket = 0;
        for(let i=0; i<6; i++) propMarket += (c[i]||0) * (target[`p${i+1}`] || 0);
        
        let propTolls = 0;
        if (is20) {
            propTolls = (c[0]*0.097553) + (c[1]*0.029267) + (c[2]*0.003292);
        } else {
            // Si no tenemos desglose de peajes, usamos la suma de los arrays cargados
            const invTolls = (inv.energyPeajeItems || []).reduce((a,b)=>a+b,0) + (inv.energyCargoItems || []).reduce((a,b)=>a+b,0);
            propTolls = inv.energyTollsTotal || invTolls || 0;
            // Si sigue siendo 0 y hay consumo, estimamos por BOE base para 3.0TD (puntos de suministro profesionales)
            if (propTolls === 0 && inv.consumption > 0) {
                 for(let i=0; i<6; i++) propTolls += (c[i]||0) * ((boePeajesExtEnergy[i]||0) + (boeCargosExtEnergy[i]||0));
            }
        }

        const propEnergy = Math.round((propMarket + propTolls) * 100) / 100;
        
        let propPower = 0;
        if (is20) {
            propPower = ((pwr[0]*billingDays*(0.075903+(target.pp1||0))) + (pwr[1]*billingDays*(0.001988+(target.pp2||0))));
        } else {
            for(let i=0; i<6; i++) {
                if(pwr[i]>0) propPower += (pwr[i] * ((boePeajesExtPower[i]||0)+(boeCargosExtPower[i]||0)+(target[`pp${i+1}`]||0)) * billingDays);
            }
        }
        propPower = Math.round(propPower * 100) / 100;

        const subtotal = propEnergy + propPower;
        const currentSubtotal = (inv.energyCost||0) + (inv.powerCost||0);
        const eTaxRate = currentSubtotal > 0 ? (inv.electricTax / currentSubtotal) : 0.051127;
        const eTax = Math.round(subtotal * eTaxRate * 100) / 100;
        
        const adjTotal = (inv.adjustments || []).reduce((a,b)=>a+(b.amount||0), 0) + (inv.rentCost||0) + (inv.socialBond||0);
        const base = subtotal + eTax + adjTotal;
        const vat = Math.round(base * (inv.vat / (inv.totalCalculated - inv.vat || 1)) * 100) / 100;
        const total = Math.round((base + vat) * 100) / 100;

        totalProposed += total;
        totalProposedEnergy += propEnergy;
        totalProposedPower += propPower;
        totalProposedMarket += propMarket;
        totalProposedTolls += propTolls;
        totalProposedElectricTax += eTax;
        totalProposedVat += vat;

        return {
            period: inv.period,
            consumptions: c,
            currentEnergyCost: inv.energyCost || 0,
            currentEnergyMarketRates: inv.energyMarketRates || Array(6).fill(0),
            currentEnergyPeajeRates: inv.energyPeajeRates || Array(6).fill(0),
            currentEnergyCargoRates: inv.energyCargoRates || Array(6).fill(0),
            currentMarket: inv.energyMarketTotal || 0,
            currentTolls: inv.energyTollsTotal || 0,
            currentPowerCost: inv.powerCost || 0,
            currentPowerRates: inv.currentPowerRates || Array(6).fill(0),
            currentElectricTax: inv.electricTax || 0,
            currentVat: inv.vat || 0,
            currentTotal: inv.totalCalculated,

            proposedEnergyCost: propEnergy,
            proposedMarket: propMarket,
            proposedTolls: propTolls,
            proposedPowerCost: propPower,
            proposedElectricTax: eTax,
            proposedVat: vat,
            proposedTotal: total,

            targetPrices: [target.p1, target.p2, target.p3, target.p4, target.p5, target.p6],
            targetPowerPrices: [target.pp1, target.pp2, target.pp3, target.pp4, target.pp5, target.pp6],
            contractedPower: pwr,
            billingDays: billingDays,
            adjustments: inv.adjustments || [],
            rentCost: inv.rentCost || 0,
            socialBond: inv.socialBond || 0,
            is20: is20
        };
    });

    return {
        cups: ref.cups,
        clientName: ref.clientName || 'N/D',
        clientAddress: ref.clientAddress || 'Dirección N/D',
        providerName: ref.providerName || 'Actual',
        targetProvider: target.name,
        tariffType: ref.tariffType || 'N/D',
        totalKWh: totalKWh,
        currentAvgPrice: totalKWh > 0 ? (totalCurrentEnergy / totalKWh) : 0,
        proposedAvgPrice: totalKWh > 0 ? (totalProposedEnergy / totalKWh) : 0,
        totalCurrent: totalCurrent,
        totalProposed: totalProposed,
        totalSavings: totalCurrent - totalProposed,
        savingsPercent: totalCurrent > 0 ? ((totalCurrent - totalProposed) / totalCurrent) * 100 : 0,
        detailedData: detailedData,
        auditStatus: ref._auditStatus,
        invoiceCount: uniqueByPeriod.length
    };
};

window.renderDashboard = function() {
    let totalKWh = 0;
    let totalEnergy = 0;
    let totalPower = 0;
    let totalOthers = 0;
    let totalInvoice = 0;
    const resultsTableBody = document.querySelector('#results-table tbody');

    const distinctCups = [...new Set(invoices.map(inv => inv.cups).filter(c => c !== "N/D"))];
    const globalCups = distinctCups.length > 0 ? distinctCups[0] : "No detectado";

    const cupsContainer = document.getElementById('global-cups-display');
    if (cupsContainer) {
        cupsContainer.textContent = `CUPS: ${globalCups}`;
        cupsContainer.classList.remove('hidden');
    }

    const clientName = invoices.length > 0 && invoices[0].clientName ? invoices[0].clientName : "Cliente No Detectado";
    const clientAddress = invoices.length > 0 && invoices[0].clientAddress ? invoices[0].clientAddress : "Dirección No Detectada";

    const clientContainer = document.getElementById('client-info-display');
    if (clientContainer) {
        clientContainer.innerHTML = `<strong>Titular:</strong> ${clientName} <br> <strong>Dirección:</strong> ${clientAddress}`;
        clientContainer.classList.remove('hidden');
    }

    const providerName = invoices.length > 0 && invoices[0].providerName ? invoices[0].providerName : "Comercializadora";
    const providerBadge = document.getElementById('provider-badge');
    const providerBadgeSidebar = document.getElementById('provider-badge-sidebar');
    if (providerBadge) providerBadge.textContent = providerName;
    if (providerBadgeSidebar) providerBadgeSidebar.textContent = providerName;

    invoices.sort((a, b) => {
        const getDate = (str) => {
            const match = str.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
            if (!match) return 0;
            return new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime();
        };
        return getDate(a.period) - getDate(b.period);
    });

    invoices.forEach(inv => {
        totalKWh += inv.consumption;
        totalEnergy += inv.energyCost;
        totalPower += inv.powerCost;
        totalOthers += inv.othersCost + inv.adjustments.reduce((sum, adj) => sum + adj.amount, 0);
        totalInvoice += inv.totalCalculated;
    });

    const avgPrice = totalKWh > 0 ? (totalEnergy / totalKWh) : 0;

    document.getElementById('total-kwh').textContent = formatNumber(totalKWh, 0) + " kWh";
    document.getElementById('total-energy-cost').textContent = formatCurrency(totalEnergy);
    document.getElementById('avg-price').textContent = formatCurrency(avgPrice, 4) + "/kWh";
    document.getElementById('total-power-cost').textContent = formatCurrency(totalPower);

    if (resultsTableBody) {
        resultsTableBody.innerHTML = invoices.map((inv, idx) => {
            const adjTotal = (inv.adjustments || []).reduce((a, b) => a + (b.amount || 0), 0);
            const adjRow = (inv.adjustments || []).length > 0 ?
                `<tr class="adjustment-row">
                    <td class="checkbox-cell"></td>
                    <td colspan="6">Ajustes: ${inv.adjustments.map(a => `${a.description} (${formatCurrency(a.amount)})`).join(', ')}</td>
                    <td class="text-right">${formatCurrency(adjTotal)}</td>
                 </tr>` : '';

            // AUDITORIA: Comparar total calculado vs total del PDF
            const paperT = inv.totalInvoice_PDF || 0;
            const calcT = inv.totalCalculated || 0;
            const discrepancy = inv._auditDiscrepancy;
            const auditStatus = inv._auditStatus;
            
            // NUEVO: Estados de base de datos y comparativa
            const isDuplicate = window.isInvoiceInHistory(inv);
            const isCompared = window.isInvoiceAlreadyCompared(inv);

            let auditBadge = '';
            let totalCellClass = 'text-right';
            
            if (auditStatus === 'OK') {
                auditBadge = `<br><span style="color:#22c55e;font-size:0.75em;font-weight:700;">✓ Verificado: ${formatCurrency(paperT)}</span>`;
            } else if (auditStatus === 'ERROR') {
                const sign = discrepancy > 0 ? '+' : '';
                totalCellClass = 'text-right audit-error';
                
                const suspects = [];
                const gapAbs = Math.abs(discrepancy);
                if ((inv.powerCost || 0) < 0.5 && gapAbs > 5) suspects.push('Potencia no extraída');
                if ((inv.energyCost || 0) < 0.5 && gapAbs > 5) suspects.push('Energía no extraída');
                if (Math.abs((inv.othersCost || 0) - gapAbs) < 1.5) suspects.push('Posible duplicado Otros');

                const tooltip = `Calculado: ${formatCurrency(calcT)} | En factura: ${formatCurrency(paperT)} | Diferencia: ${sign}${formatCurrency(discrepancy)}`;
                auditBadge = `<br><span class="audit-discrepancy-badge" title="${tooltip}">
                    ⚠️ PDF: ${formatCurrency(paperT)} | Δ ${sign}${formatCurrency(discrepancy)}
                </span>`;
            } else if (auditStatus === 'NO_PDF_TOTAL') {
                totalCellClass = 'text-right audit-warning';
                auditBadge = `<br><span style="color:#f59e0b;font-size:0.75em;font-weight:700;" title="No se pudo extraer el total del PDF para verificar">⚠️ Total PDF no extraído</span>`;
            }

            // Badges de estado extra
            const dbBadge = isDuplicate ? `<span class="badge warning" title="Esta factura ya existe en el historial (DB)">HAY DUPLICADO</span>` : '';
            const compBadge = isCompared ? `<span class="badge info" title="Este suministro ya está incluido en el reporte consolidado">YA COMPARADO</span>` : '';

            return `
                <tr class="${auditStatus === 'ERROR' ? 'row-audit-error' : (auditStatus === 'NO_PDF_TOTAL' ? 'row-audit-warning' : '')}">
                    <td class="checkbox-cell">
                        <input type="checkbox" class="invoice-checkbox" data-index="${idx}" onchange="handleInvoiceSelectionChange()">
                    </td>
                    <td>${inv.invoiceNum}</td>
                    <td>${formatDateToNumeric(inv.period)}</td>
                    <td>${(inv.cups || '').slice(-5)}</td>
                    <td style="font-size: 13px;">
                        ${inv.clientAddress || 'N/D'}
                        <div class="status-badge-container">
                            ${dbBadge} ${compBadge}
                        </div>
                    </td>
                    <td class="text-right">${formatNumber(inv.consumption, 2)}</td>
                    <td class="text-right">${formatCurrency(inv.energyCost)}</td>
                    <td class="text-right">${formatCurrency(inv.powerCost)}</td>
                    <td class="text-right">${formatCurrency(inv.othersCost)}</td>
                    <td class="${totalCellClass}">
                        ${formatCurrency(calcT)}
                        ${auditBadge}
                    </td>
                    <td class="text-right">
                        <button class="btn btn-sm btn-pdf" onclick="viewOriginalPDF('${inv._sourceFileName || inv.fileName || ''}')" title="Ver Factura Original">📄 PDF</button>
                        <button class="btn primary btn-sm" onclick="selectForComparison('${inv.invoiceNum || ''}', '${inv.cups || ''}', '${inv.period || ''}')">Comparar</button>
                    </td>
                </tr>
                ${adjRow}
            `;
        }).join('');
    }

    // Reset checkboxes labels
    const batchBtn = document.getElementById('batch-compare-btn');
    if (batchBtn) {
        batchBtn.style.display = 'none';
        batchBtn.textContent = '⚖️ Comparar Selección (0)';
    }
    const selectAllCb = document.getElementById('select-all-checkbox');
    if (selectAllCb) {
        selectAllCb.checked = false;
        selectAllCb.indeterminate = false;
    }

    document.getElementById('table-total-kwh').textContent = formatNumber(totalKWh, 2);
    document.getElementById('table-total-energy').textContent = formatCurrency(totalEnergy);
    document.getElementById('table-total-power').textContent = formatCurrency(totalPower);
    document.getElementById('table-total-others').textContent = formatCurrency(totalOthers);
    document.getElementById('table-total-invoice').textContent = formatCurrency(totalInvoice);
}


window.saveToDatabase = function(newInvoices) {
    const stored = localStorage.getItem('audit_pro_db');
    let currentDb = stored ? JSON.parse(stored) : [];

    newInvoices.forEach(inv => {
        if (inv.clientName) inv.clientName = normalizeClientName(inv.clientName);
        
        // Match by invoice number (cleaned) OR by CUPS + exact period (same supply, same month)
        const invNumClean = (inv.invoiceNum || '').replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase();

        const existingIdx = currentDb.findIndex(d => {
            const dNumClean = (d.invoiceNum || '').replace(/[^a-zA-Z0-9\-]/g, '').toLowerCase();
            const sameNum = invNumClean && dNumClean && invNumClean === dNumClean;
            const sameCupsPeriod = d.cups && inv.cups && d.cups === inv.cups && d.period === inv.period;
            return sameNum || sameCupsPeriod;
        });

        if (existingIdx >= 0) {
            // Overwrite with updated extraction
            currentDb[existingIdx] = inv;
        } else {
            currentDb.push(inv);
        }
    });


    localStorage.setItem('audit_pro_db', JSON.stringify(currentDb));
    dbInvoices = currentDb;
    renderHistory();
    renderClients();
    renderPricing();
}

window.initHistoryFilters = function() {
    const clientSelect = document.getElementById('history-client-filter');
    if (!clientSelect) return;
    
    const clients = [...new Set(dbInvoices.map(inv => inv.clientName || 'N/D'))].sort();
    const currentClient = clientSelect.value;
    
    clientSelect.innerHTML = '<option value="ALL">Todos los Clientes</option>' + 
        clients.map(c => `<option value="${c}">${c}</option>`).join('');
        
    if (clients.includes(currentClient)) {
        clientSelect.value = currentClient;
    } else {
        clientSelect.value = "ALL";
    }
    
    updateCupsFilter();
}

window.updateCupsFilter = function() {
    const clientSelect = document.getElementById('history-client-filter');
    const cupsSelect = document.getElementById('history-cups-filter');
    if (!clientSelect || !cupsSelect) return;
    
    const selectedClient = clientSelect.value;
    let filteredInvoices = dbInvoices;
    
    if (selectedClient !== "ALL") {
        filteredInvoices = dbInvoices.filter(inv => (inv.clientName || 'N/D') === selectedClient);
    }
    
    const cupsList = [...new Set(filteredInvoices.map(inv => inv.cups || 'N/D'))].sort();
    const currentCups = cupsSelect.value;
    
    cupsSelect.innerHTML = '<option value="ALL">Todos los CUPS</option>' + 
        cupsList.map(c => `<option value="${c}">${c}</option>`).join('');
        
    if (cupsList.includes(currentCups)) {
        cupsSelect.value = currentCups;
    } else {
        cupsSelect.value = "ALL";
    }
}

window.renderHistory = function() {
    initHistoryFilters();
    
    const historyContainer = document.getElementById('history-list');
    const tariffFilter = document.getElementById('history-tariff-filter');
    const clientFilter = document.getElementById('history-client-filter');
    const cupsFilter = document.getElementById('history-cups-filter');
    
    if (!historyContainer) return;

    if (dbInvoices.length === 0) {
        historyContainer.innerHTML = '<p>No hay facturas guardadas en la base de datos.</p>';
        historyContainer.className = 'empty-state';
        return;
    }

    let displayInvoices = [...dbInvoices];
    
    // Sort by period date (descending - newest first)
    displayInvoices.sort((a, b) => {
        const getDate = (str) => {
            if (!str) return 0;
            const match = str.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
            if (!match) return 0;
            return new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime();
        };
        return getDate(b.period) - getDate(a.period);
    });

    if (clientFilter && clientFilter.value !== 'ALL') {
        displayInvoices = displayInvoices.filter(inv => (inv.clientName || 'N/D') === clientFilter.value);
    }
    
    if (cupsFilter && cupsFilter.value !== 'ALL') {
        displayInvoices = displayInvoices.filter(inv => (inv.cups || 'N/D') === cupsFilter.value);
    }

    if (tariffFilter && tariffFilter.value !== 'ALL') {
        const filterVal = tariffFilter.value;
        displayInvoices = displayInvoices.filter(inv => {
            if (!inv.tariffType) return false;
            return inv.tariffType.includes(filterVal);
        });
    }

    if (displayInvoices.length === 0) {
        historyContainer.innerHTML = '<p>No hay facturas que coincidan con los filtros aplicados.</p>';
        historyContainer.className = 'empty-state';
        return;
    }

    historyContainer.className = 'table-container';
    historyContainer.innerHTML = `
        <table class="history-table">
            <thead>
                <tr>
                    <th class="checkbox-cell"><input type="checkbox" id="select-all-history-checkbox" onclick="toggleAllInvoicesSelections(this.checked, 'history')"></th>
                    <th>Ubicación</th>
                    <th>Comercializadora</th>
                    <th>CUPS</th>
                    <th>Tarifa</th>
                    <th>Periodo</th>
                    <th class="text-right">Consumo</th>
                    <th class="text-center">Estado Audit</th>
                    <th class="text-right">Total</th>
                    <th class="text-right">Acciones</th>
                </tr>
            </thead>
            <tbody>
                ${displayInvoices.map((inv, idx) => `
                    <tr>
                        <td class="checkbox-cell">
                            <input type="checkbox" class="history-checkbox" data-index="${idx}" data-source="history" onchange="handleInvoiceSelectionChange('history')">
                        </td>
                        <td>
                            <div style="font-size: 0.9rem; color: #1e293b; font-weight: 500;">${inv.clientAddress || 'Dirección N/D'}</div>
                        </td>
                        <td style="font-size: 0.9rem;">${inv.providerName || 'N/D'}</td>
                        <td style="font-size: 0.9rem; font-family: monospace; font-weight: 600;">...${(inv.cups || '').slice(-5)}</td>
                        <td><span class="badge secondary">${inv.tariffType || 'N/D'}</span></td>
                        <td>${formatDateToNumeric(inv.period)}</td>
                        <td class="text-right">${formatNumber(inv.consumption, 2)} kWh</td>
                        <td class="text-center">
                            ${inv._auditStatus === 'OK' ? 
                                '<span class="badge success" style="padding: 2px 8px; font-size: 0.75rem;">✓ OK</span>' : 
                                (inv._auditStatus === 'ERROR' ? 
                                    `<span class="badge danger" style="padding: 2px 8px; font-size: 0.75rem;" title="Diferencia: ${formatCurrency(inv._auditDiscrepancy)}">⚠️ Discrepancia</span>` : 
                                    (inv._auditStatus === 'NO_PDF_TOTAL' ? 
                                        '<span class="badge warning" style="padding: 2px 8px; font-size: 0.75rem;">❓ Sin Total PDF</span>' : 
                                        '<span class="badge secondary" style="padding: 2px 8px; font-size: 0.75rem;">N/A</span>'
                                    )
                                )
                            }
                        </td>
                        <td class="text-right" style="font-weight: 600;">${formatCurrency(inv.totalCalculated)}</td>
                        <td class="text-right" style="display:flex;gap:0.4rem;justify-content:flex-end;align-items:center;">
                            <button class="btn btn-sm btn-pdf" onclick="viewOriginalPDF('${inv._sourceFileName || inv.fileName || ''}')" title="Ver Factura Original">📄 PDF</button>
                            <button class="btn btn-sm" style="background:#f1f5f9; border:1px solid #cbd5e1;" onclick="showHistoryAudit('${inv.invoiceNum || ''}', '${inv.cups || ''}', '${inv.period || ''}')" title="Ver Desglose Matemático">🔍 Ver Detalle</button>
                            <button class="btn primary btn-sm" onclick="selectForComparison('${inv.invoiceNum || ''}', '${inv.cups || ''}', '${inv.period || ''}')">⚖️ Comparar</button>
                            <button class="btn btn-sm" style="background:#fee2e2;color:#dc2626;border:1px solid #fca5a5;" onclick="deleteInvoice('${inv.cups}', '${inv.period}')">🗑️ Borrar</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `;
}

window.deleteInvoice = function(cups, period) {
    if (!confirm('¿Estás seguro de que deseas borrar esta factura del historial?')) return;
    dbInvoices = dbInvoices.filter(inv => !(inv.cups === cups && inv.period === period));
    localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
    renderHistory();
    renderClients();
}

window.renderClients = function() {
    const clientsContainer = document.getElementById('clients-list');
    const badge = document.getElementById('clients-count-badge');
    if (!clientsContainer) return;

    if (dbInvoices.length === 0) {
        clientsContainer.innerHTML = '<p>No hay clientes detectados en la base de datos.</p>';
        clientsContainer.className = 'empty-state';
        if (badge) badge.textContent = "0 Clientes";
        return;
    }

    // Agrupar por CLIENTE para identificar la empresa y sus múltiples suministros
    const clientsMap = new Map();
    dbInvoices.forEach(inv => {
        const cName = normalizeClientName(inv.clientName || 'N/D');
        if (!clientsMap.has(cName)) {
            clientsMap.set(cName, {
                name: cName,
                supplies: new Map() // Sub-map para agrupar por CUPS dentro del cliente
            });
        }
        const client = clientsMap.get(cName);
        
        if (!client.supplies.has(inv.cups)) {
            client.supplies.set(inv.cups, {
                cups: inv.cups,
                address: inv.supplyAddress || inv.clientAddress || 'N/D', // Preferir supplyAddress
                lastProvider: inv.providerName || 'N/D'
            });
        } else {
            const supply = client.supplies.get(inv.cups);
            supply.lastProvider = inv.providerName || supply.lastProvider;
        }
    });

    const uniqueClients = Array.from(clientsMap.values());
    if (badge) badge.textContent = `${uniqueClients.length} Clientes`;

    clientsContainer.innerHTML = uniqueClients.map(client => {
        const supplies = Array.from(client.supplies.values());
        return `
            <details style="margin-bottom: 1rem; background: white; border: 1px solid #e2e8f0; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <summary style="padding: 1.25rem; font-weight: bold; font-size: 1.05rem; cursor: pointer; display: flex; justify-content: space-between; align-items: center; background: #f8fafc; color: #1e293b;">
                    <div style="display:flex; align-items:center; gap:0.75rem;">
                        <i class="fa-solid fa-hotel" style="color:var(--accent-blue);"></i> 
                        ${client.name}
                    </div>
                    <span class="badge secondary" style="font-size: 0.8rem; background:#e0f2fe; color:#0369a1; border:1px solid #bae6fd;">
                        ${supplies.length} Suministro${supplies.length > 1 ? 's' : ''}
                    </span>
                </summary>
                <div style="padding: 1rem; border-top: 1px solid #e2e8f0;">
                    <table style="width: 100%; border-collapse: collapse; text-align: left; font-size: 0.9rem;">
                        <thead style="background: #f1f5f9; color: #475569; font-weight: 600;">
                            <tr>
                                <th style="padding: 0.75rem;">CUPS</th>
                                <th style="padding: 0.75rem;">Comercializadora</th>
                                <th style="padding: 0.75rem;">Ubicación del Suministro</th>
                                <th style="padding: 0.75rem;">Acciones</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${supplies.map(sup => `
                                <tr style="border-bottom: 1px solid #f1f5f9;">
                                    <td style="padding: 0.75rem;">${sup.cups.slice(-5)}</td>
                                    <td style="padding: 0.75rem;"><span class="badge secondary">${sup.lastProvider}</span></td>
                                    <td style="padding: 0.75rem;">${sup.address}</td>
                                    <td style="padding: 0.75rem;">
                                        <button class="btn secondary btn-sm" onclick="filterHistoryByCups('${sup.cups}')" style="padding: 2px 8px; font-size: 0.75rem;">Ver Facturas</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </details>
        `;
    }).join('');
}

window.filterHistoryByCups = function(cups) {
    const inv = dbInvoices.find(i => i.cups === cups);
    if (!inv) return;

    const clientSelect = document.getElementById('history-client-filter');
    const cupsSelect = document.getElementById('history-cups-filter');
    
    if (clientSelect) {
        clientSelect.value = normalizeClientName(inv.clientName);
        updateCupsFilter(); // Actualizar las opciones del select de CUPS para este cliente
    }

    if (cupsSelect) {
        cupsSelect.value = cups;
    }

    renderHistory();
    switchView('history-view');
}

window.renderPricing = function() {
    const pricingTableBody = document.querySelector('#pricing-table tbody');
    if (!pricingTableBody) return;

    loadCustomProviders();

    pricingTableBody.innerHTML = Object.entries(MARKET_PRICES).map(([id, data]) => {
        const editBtn = `<button class="btn btn-sm secondary" onclick="window.editProvider('${id}')">Editar</button>`;
        const deleteBtn = `<button class="btn btn-sm" style="color: #ef4444; border: 1px solid #ef4444;" onclick="deleteProvider('${id}')">Borrar</button>`;

        return `
            <tr>
                <td><strong>${data.name}</strong></td>
                <td>${data.p1} €</td>
                <td>${data.p2} €</td>
                <td>${data.p3} €</td>
                <td style="color: #94a3b8;">${data.p4 || 0} €</td>
                <td style="color: #94a3b8;">${data.p5 || 0} €</td>
                <td style="color: #94a3b8;">${data.p6 || 0} €</td>
                <td style="background: #f0fdf4;">${data.pp1 || 0} €</td>
                <td style="background: #f0fdf4;">${data.pp2 || 0} €</td>
                <td style="display:flex;gap:0.5rem;align-items:center;">${editBtn} ${deleteBtn}</td>
            </tr>
        `;
    }).join('');

    // Update the comparison selects
    const selects = [
        document.getElementById('target-provider-select'),
        document.getElementById('dashboard-target-provider-select'),
        document.getElementById('history-target-provider-select')
    ];
    
    selects.forEach(sel => {
        if (sel) {
            sel.innerHTML = Object.entries(MARKET_PRICES).map(([id, data]) => 
                `<option value="${id}">${data.name}</option>`
            ).join('');
        }
    });
}

window.deleteProvider = function(id) {
    if (!confirm('¿Borrar esta comercializadora?')) return;
    const stored = localStorage.getItem('custom_providers');
    if (stored) {
        let custom = JSON.parse(stored);
        delete custom[id];
        localStorage.setItem('custom_providers', JSON.stringify(custom));
        renderPricing();
    }
}

window.toggleFormPeriods = function() {
    const select = document.getElementById('new-tariff-type');
    if (!select) return;
    const val = select.value;
    const p4 = document.getElementById('new-p4') ? document.getElementById('new-p4').parentElement : null;
    const p5 = document.getElementById('new-p5') ? document.getElementById('new-p5').parentElement : null;
    const p6 = document.getElementById('new-p6') ? document.getElementById('new-p6').parentElement : null;
    
    if (val === '2.0') {
        if (p4) p4.style.display = 'none';
        if (p5) p5.style.display = 'none';
        if (p6) p6.style.display = 'none';
    } else {
        if (p4) p4.style.display = 'block';
        if (p5) p5.style.display = 'block';
        if (p6) p6.style.display = 'block';
    }
}

window.editProvider = function(id) {
    const data = MARKET_PRICES[id];
    if (!data) return;
    document.getElementById('new-provider-name').value = data.name;
    document.getElementById('new-p1').value = data.p1 || 0;
    document.getElementById('new-p2').value = data.p2 || 0;
    document.getElementById('new-p3').value = data.p3 || 0;
    document.getElementById('new-p4').value = data.p4 || 0;
    document.getElementById('new-p5').value = data.p5 || 0;
    document.getElementById('new-p6').value = data.p6 || 0;
    
    document.getElementById('new-pp1').value = data.pp1 || 0;
    document.getElementById('new-pp2').value = data.pp2 || 0;
    document.getElementById('new-pp3').value = data.pp3 || 0;
    document.getElementById('new-pp4').value = data.pp4 || 0;
    document.getElementById('new-pp5').value = data.pp5 || 0;
    document.getElementById('new-pp6').value = data.pp6 || 0;
    
    const select = document.getElementById('new-tariff-type');
    if (select) {
        // Auto-detect tariff if P4-P6 (energy & power) are zero
        const is20 = (data.p4 === 0 || data.p4 === "0") && (data.p5 === 0 || data.p5 === "0") && (data.p6 === 0 || data.p6 === "0") &&
                     (data.pp4 === 0 || data.pp4 === "0") && (data.pp5 === 0 || data.pp5 === "0") && (data.pp6 === 0 || data.pp6 === "0");
        select.value = is20 ? '2.0' : '3.0';
        window.toggleFormPeriods();
    }

    window.editingProviderId = id;
    
    const formBtn = document.querySelector('#provider-form button[type="submit"]');
    if (formBtn) formBtn.textContent = 'Actualizar Comercializadora';
    
    const providerCard = document.getElementById('new-provider-card');
    if (providerCard) providerCard.classList.remove('hidden');
};

window.updateCupsFilter = function() {
    const clientSelect = document.getElementById('history-client-filter');
    const cupsSelect = document.getElementById('history-cups-filter');
    if (!clientSelect || !cupsSelect) return;

    const selectedClient = clientSelect.value;
    const currentCUPS = cupsSelect.value;

    cupsSelect.innerHTML = '<option value="ALL">Todos los CUPS</option>';

    let relevantInvoices = dbInvoices;
    if (selectedClient !== 'ALL') {
        relevantInvoices = dbInvoices.filter(inv => normalizeClientName(inv.clientName || 'N/D') === selectedClient);
    }

    const uniqueCups = [...new Set(relevantInvoices.map(inv => inv.cups))];
    uniqueCups.forEach(cups => {
        if (!cups) return;
        const option = document.createElement('option');
        option.value = cups;
        option.textContent = cups;
        cupsSelect.appendChild(option);
    });

    if (currentCUPS && [...cupsSelect.options].some(opt => opt.value === currentCUPS)) {
        cupsSelect.value = currentCUPS;
    } else {
        cupsSelect.value = 'ALL';
    }
}

window.runComparison = function() {
    const ref = window.selectedRefInvoice;
    const targetId = document.getElementById('target-provider-select').value;
    const target = MARKET_PRICES[targetId];

    if (!ref || !target) return;

    // Obtener todas las facturas del mismo CUPS para el reporte completo
    const relatedInvoices = dbInvoices.filter(inv => inv.cups === ref.cups);
    relatedInvoices.sort((a, b) => {
        const getDate = (str) => {
            const m = str.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
            return m ? new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime() : 0;
        };
        return getDate(a.period) - getDate(b.period);
    });

    let totalCurrent = 0, totalProposed = 0, totalSavings = 0, totalKWh = 0;
    let totalCurrentEnergy = 0, totalProposedEnergy = 0;
    let totalCurrentPower = 0, totalProposedPower = 0;
    let totalCurrentElectricTax = 0, totalProposedElectricTax = 0;
    let totalCurrentRentCost = 0, totalProposedRentCost = 0;
    let totalCurrentOtherSpecific = 0, totalProposedOtherSpecific = 0;
    let totalCurrentVat = 0, totalProposedVat = 0;
    let totalCurrentTolls = 0, totalProposedTolls = 0;
    let totalCurrentMarket = 0, totalProposedMarket = 0;
    
    // Totales de consumo por periodo para el pie de tabla
    let globalKWhs = [0,0,0,0,0,0];
    relatedInvoices.forEach(inv => {
        const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [inv.consumption, 0, 0, 0, 0, 0];
        for(let i=0; i<6; i++) globalKWhs[i] += (c[i] || 0);
    });

    const hasP4 = relatedInvoices.some(inv => (inv.consumptionItems?.[3] > 0));
    const hasP5 = relatedInvoices.some(inv => (inv.consumptionItems?.[4] > 0));
    const hasP6 = relatedInvoices.some(inv => (inv.consumptionItems?.[5] > 0));

    // 1. PROCESAR FACTURAS ACTUALES Y PREPARAR DATOS
    const currentResults = relatedInvoices.map((inv) => {
        const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [inv.consumption, 0, 0, 0, 0, 0];
        totalKWh += (inv.consumption || 0);
        
        // Extraemos componentes base
        const c_pwr = inv.powerCost || 0;
        const c_energy = inv.energyCost || 0;
        const c_elecTax = inv.electricTax || 0;
        const c_vat = inv.vat || 0;

        // Construimos un array de ajustes limpio (sin duplicar conceptos)
        let cleanAdj = Array.isArray(inv.adjustments) ? [...inv.adjustments] : [];
        
        // Si el coste de gestión/otros no está en ajustes, lo añadimos si es > 0
        const hasSpecific = cleanAdj.some(a => (a.concept||"").toLowerCase().includes("gestión") || (a.concept||"").toLowerCase().includes("otros"));
        if (inv.otherSpecificCost > 0 && !hasSpecific) {
            cleanAdj.push({ concept: 'Coste de Gestión', amount: inv.otherSpecificCost });
        }
        
        const hasRent = cleanAdj.some(a => (a.concept||"").toLowerCase().includes("alquiler"));
        if (inv.rentCost > 0 && !hasRent) {
            cleanAdj.push({ concept: 'Alquiler de Contador', amount: inv.rentCost });
        }

        const hasSocial = cleanAdj.some(a => (a.concept||"").toLowerCase().includes("social"));
        if (inv.socialBond > 0 && !hasSocial) {
            cleanAdj.push({ concept: 'Financiación Bono Social', amount: inv.socialBond });
        }

        // El sumatorio de ajustes incluye TODO (Alquiler, Social, Gestión)
        const adjSum = cleanAdj.reduce((sum, a) => sum + (a.amount || 0), 0);
        
        // El total recalculado es la suma exacta de sus partes visibles (adjSum ya tiene gestión)
        const reconciledTotal = Math.round((c_energy + c_pwr + c_elecTax + adjSum + c_vat) * 100) / 100;
        
        const c_eMarketTotal = inv.energyMarketTotal || (Array.isArray(inv.energyMarketItems) ? inv.energyMarketItems.reduce((a,b)=>a+b,0) : 0);
        const c_eTollsTotal = inv.energyTollsTotal || (Array.isArray(inv.energyTollsItems) ? inv.energyTollsItems.reduce((a,b)=>a+b,0) : 0);

        totalCurrent += reconciledTotal;
        totalCurrentPower += c_pwr;
        totalCurrentEnergy += c_energy;
        totalCurrentElectricTax += c_elecTax;
        totalCurrentVat += c_vat;
        totalCurrentOtherSpecific += adjSum;
        totalCurrentTolls += c_eTollsTotal;
        totalCurrentMarket += c_eMarketTotal;

        const c_avgEnergyRate = (inv.consumption || 0) > 0 ? (c_energy / inv.consumption) : 0;

        return {
            period: inv.period,
            invoiceNum: inv.invoiceNum,
            c: c,
            consumption: inv.consumption || 0,
            energyOnly: c_energy,
            powerOnly: c_pwr,
            othersOnly: c_elecTax + adjSum + c_vat,
            avgEnergyRate: c_avgEnergyRate,
            total: reconciledTotal,
            
            // Datos para el Modal Lupa
            currentEnergyCost: c_energy,
            currentMarket: inv.energyMarketTotal || 0,
            currentTolls: inv.energyTollsTotal || 0,
            currentPowerCost: c_pwr,
            currentEnergyMarketRates: inv.energyMarketRates || Array(6).fill(0),
            currentPowerRates: inv.currentPowerRates || Array(6).fill(0),
            currentElectricTax: c_elecTax,
            currentVat: c_vat,
            currentTotal: reconciledTotal,
            adjustments: cleanAdj,
            rentCost: inv.rentCost,
            socialBond: inv.socialBond,
            otherSpecificCost: inv.otherSpecificCost
        };
    });

    const currentRowsHtml = currentResults.map(r => `
        <tr>
            <td>${r.period ? r.period.split(' - ')[0] : 'N/D'}</td>
            <td class="text-right">${formatNumber(r.consumption, 0)} kWh</td>
            <td class="text-right">${formatCurrency(r.energyOnly)}</td>
            <td class="text-right">${formatCurrency(r.powerOnly)}</td>
            <td class="text-right">${formatCurrency(r.othersOnly)}</td>
            <td class="text-right" style="color:#64748b; font-weight:bold;">${formatCurrency(r.avgEnergyRate, 6)}/kWh</td>
            <td class="text-right">${formatCurrency(r.total)}</td>
        </tr>
    `).join('');

    // 2. PROCESAR PROPUESTA (Using Global BOE Constants)

    let rowHtmlProposed = "";
    const detailedData = relatedInvoices.map((inv) => {
        const is20 = (inv.tariffType || "").includes("2.0");
        const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [inv.consumption, 0, 0, 0, 0, 0];
        const billingDays = inv.billingDays || 0;
        const pwr = Array.isArray(inv.contractedPower) ? inv.contractedPower : [0,0,0,0,0,0];

        // 1. Energía Propuesta (Mercado + Peajes BOE)
        let proposedMarketCost = 0;
        for(let i=0; i<6; i++) proposedMarketCost += (c[i]||0) * (target[`p${i+1}`] || 0);
        
        let legalEnergyReg = 0;
        if (is20) {
            legalEnergyReg = Math.round(((c[0] * 0.097553) + (c[1] * 0.029267) + (c[2] * 0.003292)) * 100) / 100;
        } else {
            legalEnergyReg = inv.energyTollsTotal || (Array.isArray(inv.energyTollsItems) ? inv.energyTollsItems.reduce((a,b)=>a+b,0) : 0);
        }

        const proposedEnergyTotal = Math.round((proposedMarketCost + legalEnergyReg) * 100) / 100;
        totalProposedEnergy += proposedEnergyTotal;
        totalProposedMarket += proposedMarketCost;
        totalProposedTolls += legalEnergyReg;

        // 2. Potencia Propuesta
        let proposedPowerCost = 0;
        if (is20) {
            const p1_price = 0.075903 + (target.pp1 || 0);
            const p2_price = 0.001988 + (target.pp2 || 0);
            proposedPowerCost = Math.round(((pwr[0] * billingDays * p1_price) + (pwr[1] * billingDays * p2_price)) * 100) / 100;
        } else {
            let sidePower = 0;
            for(let i=0; i<6; i++) {
                if(pwr[i] > 0) {
                    const margin = target[`pp${i+1}`] || 0;
                    const boeRate = (boePeajesExtPower[i]||0) + (boeCargosExtPower[i]||0);
                    sidePower += (pwr[i] * (boeRate + margin) * billingDays);
                }
            }
            proposedPowerCost = Math.round(sidePower * 100) / 100;
            if (proposedPowerCost === 0 && (inv.powerCost || 0) > 0) proposedPowerCost = inv.powerCost;
        }
        totalProposedPower += proposedPowerCost;

        const proposedSubtotal = proposedEnergyTotal + proposedPowerCost;

        // 3. Otros Ajustes e Impuestos (Propuesta)
        const currentData = currentResults[index];
        const p_othersBase = currentData.adjustments.reduce((sum, a) => {
            const desc = (a.concept || "").toLowerCase();
            if (desc.includes("alquiler") || desc.includes("social")) return sum + (a.amount || 0);
            return sum;
        }, 0);
        
        const currentSubtotalItems = (inv.energyCost || 0) + (inv.powerCost || 0);
        const electricTaxRate = currentSubtotalItems > 0 ? (inv.electricTax / currentSubtotalItems) : 0.051127;
        const p_elecTax = Math.round(proposedSubtotal * electricTaxRate * 100) / 100;
        totalProposedElectricTax += p_elecTax;

        totalProposedRentCost += (inv.rentCost || 0);
        totalProposedOtherSpecific += (p_othersBase - (inv.rentCost || 0));

        const c_vatTotal = (inv.vatItems || []).reduce((a,b)=>a+b, 0) || inv.vat || 0;
        const c_baseImponible = currentSubtotalItems + (inv.electricTax || 0) + currentData.othersOnly - (inv.vat || 0); // Simplified
        const vatRate = c_baseImponible > 0 ? (c_vatTotal / c_baseImponible) : 0.21;

        const p_baseImponible = proposedSubtotal + p_elecTax + p_othersBase; // NO arrastramos el managementFee
        const p_vat = Math.round(p_baseImponible * vatRate * 100) / 100;
        totalProposedVat += p_vat;

        const proposedTotalCalculated = Math.round((p_baseImponible + p_vat) * 100) / 100;
        totalProposed += proposedTotalCalculated;

        const p_othersOnly = p_elecTax + p_vat + p_othersBase;
        const p_avgEnergyRate = (inv.consumption || 0) > 0 ? (proposedEnergyTotal / inv.consumption) : 0;

        // 4. HTML para el resumen
        rowHtmlProposed += `
            <tr>
                <td>${inv.period ? inv.period.split(' - ')[0] : 'N/D'}</td>
                <td class="text-right">${formatNumber(inv.consumption, 0)} kWh</td>
                <td class="text-right">${formatCurrency(proposedEnergyTotal)}</td>
                <td class="text-right">${formatCurrency(proposedPowerCost)}</td>
                <td class="text-right">${formatCurrency(p_othersOnly)}</td>
                <td class="text-right" style="color:#16a34a; font-weight:bold;">${formatCurrency(p_avgEnergyRate, 6)}/kWh</td>
                <td class="text-right">${formatCurrency(proposedTotalCalculated)}</td>
            </tr>
        `;

        const getEnergyRates = () => {
            const rates = [0,0,0,0,0,0];
            for (let i=0; i<6; i++) {
                rates[i] = ((inv.energyPeajeRates?.[i]||0) + (inv.energyCargoRates?.[i]||0) + (inv.energyMarketRates?.[i]||0));
            }
            if (rates.reduce((a,b)=>a+b, 0) === 0 && (inv.energyCost || 0) > 0 && inv.consumption > 0) {
                return Array(6).fill(inv.energyCost / inv.consumption);
            }
            return rates;
        };

        const getPowerRates = () => {
            const rates = [0,0,0,0,0,0];
            for (let i=0; i<6; i++) {
                rates[i] = ((inv.powerPeajeRates?.[i]||0) + (inv.powerCargoRates?.[i]||0) + (inv.powerFenieRates?.[i]||0));
            }
            return rates;
        };

        return {
            period: inv.period,
            billingDays: billingDays,
            consumptions: c,
            contractedPower: pwr,
            // Reutilizamos exactamente lo calculado arriba para la parte ORIGINAL
            currentEnergyCost: currentData.currentEnergyCost,
            currentMarket: currentData.currentMarket,
            currentTolls: currentData.currentTolls,
            currentPowerCost: currentData.currentPowerCost,
            currentPowerRates: currentData.currentPowerRates,
            currentElectricTax: currentData.currentElectricTax,
            currentVat: currentData.currentVat,
            currentTotal: currentData.currentTotal,
            adjustments: currentData.adjustments || [],
            rentCost: currentData.rentCost,
            socialBond: currentData.socialBond,
            otherSpecificCost: currentData.otherSpecificCost,

            proposedEnergyCost: proposedEnergyTotal,
            proposedMarket: proposedMarketCost,
            proposedTolls: legalEnergyReg,
            proposedPowerCost: proposedPowerCost,
            proposedOthers: p_othersOnly - p_elecTax - p_vat, 
            proposedTotal: proposedTotalCalculated,
            proposedElectricTax: p_elecTax,
            proposedVat: p_vat,
            
            targetPrices: [target.p1, target.p2, target.p3, target.p4, target.p5, target.p6],
            targetPowerPrices: [target.pp1, target.pp2, target.pp3, target.pp4, target.pp5, target.pp6],
            billingDays: billingDays
        };
    });

    const proposedRowsHtml = rowHtmlProposed;
    totalSavings = Math.round((totalCurrent - totalProposed) * 100) / 100;
    const savingsPercent = totalCurrent > 0 ? (totalSavings / totalCurrent) * 100 : 0;
    const currentAvgPrice = totalKWh > 0 ? (totalCurrentEnergy / totalKWh) : 0;
    const proposedAvgPrice = totalKWh > 0 ? (totalProposedEnergy / totalKWh) : 0;

    const is20Global = ref.tariffType && ref.tariffType.includes('2.0');
    
    let ratesHtmlCurrent = "";
    if (ref.energyMarketRates && ref.energyMarketRates.length > 0) {
        ratesHtmlCurrent = ref.energyMarketRates.map((r, i) => `P${i+1}: <strong>${formatCurrency(r, 6)}</strong>`).join(' | ');
    } else {
        ratesHtmlCurrent = `Precio Medio Activa: <strong>${formatCurrency(currentAvgPrice, 6)}</strong>`;
    }
    ratesHtmlCurrent += ' /kWh';

    let ratesHtmlProposed = "";
    if (is20Global) {
        ratesHtmlProposed = `P1: <strong>${formatCurrency(target.p1, 6)}</strong> | P2: <strong>${formatCurrency(target.p2, 6)}</strong> | P3: <strong>${formatCurrency(target.p3, 6)}</strong> /kWh`;
    } else {
        ratesHtmlProposed = `P1: <strong>${formatCurrency(target.p1, 6)}</strong> | P2: <strong>${formatCurrency(target.p2, 6)}</strong> | P3: <strong>${formatCurrency(target.p3, 6)}</strong> | P4: <strong>${formatCurrency(target.p4, 6)}</strong> | P5: <strong>${formatCurrency(target.p5, 6)}</strong> | P6: <strong>${formatCurrency(target.p6, 6)}</strong> /kWh`;
    }

    // Totales agregados para la tabla de auditoría granular en el PDF
    const auditTotals = {
        currentPeajes: totalCurrentTolls, // En 2.0TD esto ya incluye Cargos según lógica actual, pero lo desglosaremos si es necesario
        currentMarket: totalCurrentMarket,
        currentPower: totalCurrentPower,
        currentOthers: totalCurrentOtherSpecific + totalCurrentRentCost + totalCurrentElectricTax + totalCurrentVat,
        currentTotal: totalCurrent,
        
        proposedPeajes: totalProposedTolls,
        proposedMarket: totalProposedMarket,
        proposedPower: totalProposedPower,
        proposedOthers: totalProposedOtherSpecific + totalProposedRentCost + totalProposedElectricTax + totalProposedVat,
        proposedTotal: totalProposed,

        totalKWh: totalKWh
    };

    window.currentComparisonData = {
        cups: ref.cups,
        clientName: ref.clientName || 'N/D',
        clientAddress: ref.clientAddress || 'Dirección No Detectada',
        providerName: ref.providerName || 'Comercializadora Original',
        targetProvider: target.name,
        tariffType: ref.tariffType || 'N/D', // Added for PDF
        totalKWh: totalKWh,
        currentAvgPrice: currentAvgPrice,
        proposedAvgPrice: proposedAvgPrice,
        totalCurrent: totalCurrent,
        totalProposed: totalProposed,
        totalSavings: totalSavings,
        savingsPercent: savingsPercent,
        totalCurrentEnergy: totalCurrentEnergy,
        totalProposedEnergy: totalProposedEnergy,
        totalCurrentPower: totalCurrentPower,
        totalProposedPower: totalProposedPower,
        currentRowsHtml: currentRowsHtml,
        proposedRowsHtml: proposedRowsHtml,
        invoiceCount: relatedInvoices.length,
        detailedData: detailedData,
        auditTotals: auditTotals
    };


    const resultsContainer = document.getElementById('comparison-results');
    resultsContainer.innerHTML = `
        <div class="stats-grid" style="margin-top: 1rem;">
            <div class="card stat-card" style="border-left: 4px solid #f87171;">
                <h3>COSTE ACTUAL TOTAL</h3>
                <div class="value">${formatCurrency(totalCurrent)}</div>
                <div class="subtext">Precio Medio Energía: <strong>${formatCurrency(currentAvgPrice, 4)}/kWh</strong></div>
            </div>
            <div class="card stat-card" style="border-left: 4px solid #10b981;">
                <h3>COSTE CON PROPUESTA</h3>
                <div class="value">${formatCurrency(totalProposed)}</div>
                <div class="subtext">Precio Medio Energía: <strong>${formatCurrency(proposedAvgPrice, 4)}/kWh</strong></div>
            </div>
            <div class="card stat-card highlight" style="background: #1e293b; color: white;">
                <h3 style="color: #94a3b8;">AHORRO NETO PERIODO</h3>
                <div class="value" style="color: white;">${formatCurrency(totalSavings)}</div>
                <span class="badge success">${savingsPercent.toFixed(1)}% de mejora</span>
            </div>
        </div>

        <div style="margin-top: 3rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
                <span class="badge" style="background: #e2e8f0; color: #475569;">DESGLOSE GLOBAL</span>
                <h2 style="margin:0;">Tabla de Desglose por Conceptos</h2>
            </div>
            <div class="table-container card" style="padding:0;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.95rem;">
                    <thead>
                        <tr>
                            <th style="padding-left: 2rem; text-align:left;">Concepto Facturado</th>
                            <th class="text-right">Factura Actual</th>
                            <th class="text-right">Factura Propuesta</th>
                            <th class="text-right">Ahorro Neto</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="padding-left: 2rem;"><strong>1. Coste Energía (Mercado)</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentMarket)}</td>
                            <td class="text-right">${formatCurrency(totalProposedMarket)}</td>
                            <td class="text-right" style="color: ${totalCurrentMarket - totalProposedMarket > 0 ? '#16a34a' : '#dc2626'}">${formatCurrency(totalCurrentMarket - totalProposedMarket)}</td>
                        </tr>
                        <tr>
                            <td style="padding-left: 2rem; border-bottom: 2px solid #e2e8f0;"><strong>2. Peajes de Energía</strong></td>
                            <td class="text-right" style="border-bottom: 2px solid #e2e8f0;">${formatCurrency(totalCurrentTolls)}</td>
                            <td class="text-right" style="border-bottom: 2px solid #e2e8f0;">${formatCurrency(totalProposedTolls)}</td>
                            <td class="text-right" style="border-bottom: 2px solid #e2e8f0; color: ${totalCurrentTolls - totalProposedTolls > 0 ? '#16a34a' : '#dc2626'}">${formatCurrency(totalCurrentTolls - totalProposedTolls)}</td>
                        </tr>
                        <tr style="background-color: #f8fafc;">
                            <td><strong>Total Energía Activa (1+2)</strong></td>
                            <td class="text-right"><strong>${formatCurrency(totalCurrentEnergy)}</strong></td>
                            <td class="text-right"><strong>${formatCurrency(totalProposedEnergy)}</strong></td>
                            <td class="text-right" style="color: ${totalCurrentEnergy - totalProposedEnergy > 0 ? '#16a34a' : '#dc2626'}"><strong>${formatCurrency(totalCurrentEnergy - totalProposedEnergy)}</strong></td>
                        </tr>
                        <tr>
                            <td><strong>Término de Potencia</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentPower)}</td>
                            <td class="text-right">${formatCurrency(totalProposedPower)}</td>
                            <td class="text-right" style="color: ${totalCurrentPower - totalProposedPower > 0 ? '#16a34a' : '#dc2626'}">${formatCurrency(totalCurrentPower - totalProposedPower)}</td>
                        </tr>
                        <tr>
                            <td><strong>Impuesto Eléctrico</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentElectricTax)}</td>
                            <td class="text-right">${formatCurrency(totalProposedElectricTax)}</td>
                            <td class="text-right" style="color: ${totalCurrentElectricTax - totalProposedElectricTax > 0 ? '#16a34a' : '#dc2626'}">${formatCurrency(totalCurrentElectricTax - totalProposedElectricTax)}</td>
                        </tr>
                        <tr>
                            <td><strong>Alquiler de Equipos</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentRentCost)}</td>
                            <td class="text-right">${formatCurrency(totalProposedRentCost)}</td>
                            <td class="text-right" style="color: #64748b;">${formatCurrency(0)}</td>
                        </tr>
                        <tr>
                            <td><strong>Otros (Bono Social, Extras)</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentOtherSpecific)}</td>
                            <td class="text-right">${formatCurrency(totalProposedOtherSpecific)}</td>
                            <td class="text-right" style="color: #64748b;">${formatCurrency(0)}</td>
                        </tr>
                        <tr>
                            <td><strong>Impuestos (IVA / IGIC)</strong></td>
                            <td class="text-right">${formatCurrency(totalCurrentVat)}</td>
                            <td class="text-right">${formatCurrency(totalProposedVat)}</td>
                            <td class="text-right" style="color: ${totalCurrentVat - totalProposedVat > 0 ? '#16a34a' : '#dc2626'}">${formatCurrency(totalCurrentVat - totalProposedVat)}</td>
                        </tr>
                    </tbody>
                    <tfoot>
                        <tr>
                            <td style="font-size: 1.1rem;"><strong>TOTALES</strong></td>
                            <td class="text-right" style="font-size: 1.1rem; color: #ffffff;"><strong>${formatCurrency(totalCurrent)}</strong></td>
                            <td class="text-right" style="font-size: 1.1rem; color: #10b981;"><strong>${formatCurrency(totalProposed)}</strong></td>
                            <td class="text-right" style="font-size: 1.1rem; color: #16a34a;"><strong>${formatCurrency(totalSavings)}</strong></td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>

        ${buildTableHtml("FACTURA ACTUAL", `Desglose Mensual Real - ${ref.providerName || 'Original'}`, ratesHtmlCurrent, currentRowsHtml, {kwh: totalKWh, energy: totalCurrentEnergy, power: totalCurrentPower, others: totalCurrentOtherSpecific + totalCurrentRentCost + totalCurrentElectricTax + totalCurrentVat, total: totalCurrent}, "danger")}
        ${buildTableHtml("FACTURA PROPUESTA", `Optimización con Tarifa de ${target.name}`, ratesHtmlProposed, proposedRowsHtml, {kwh: totalKWh, energy: totalProposedEnergy, power: totalProposedPower, others: totalProposedOtherSpecific + totalProposedRentCost + totalProposedElectricTax + totalProposedVat, total: totalProposed}, "success")}
        
        <div style="display: flex; justify-content: flex-end; margin-bottom: 3rem;">
            <button class="btn primary" onclick="saveComparison()" style="font-size: 1.1rem; padding: 0.75rem 1.5rem;">💾 Guardar Comparativa en Reporte Múltiple</button>
        </div>
    `;
    const container = document.getElementById('comparison-results');
    if (container) {
        container.classList.remove('hidden');
        container.scrollIntoView({ behavior: 'smooth' });
    }
}

function buildTableHtml(title, subtitle, ratesHtml, rows, totals, variant) {
    const isDanger = variant === 'danger';
    const badgeStyle = isDanger ? 'background: #fef2f2; color: #ef4444; border: 1px solid #fecaca;' : 'background: #f0fdf4; color: #10b981; border: 1px solid #bbf7d0;';

    return `
        <div style="margin-top: 3rem;">
            <div style="display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem;">
                <span class="badge" style="${badgeStyle}">${title}</span>
                <h2 style="margin:0;">${subtitle}</h2>
            </div>
            ${ratesHtml}
            <div class="table-container card" style="padding:0; margin-top:1rem;">
                <table style="width: 100%; border-collapse: collapse; font-size: 0.9rem;">
                    <thead>
                        <tr style="background: #f8fafc;">
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: left;">Mes</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">Consumo</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">Energía (€)</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">Potencia (€)</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">Otros + Imp (€)</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">P. Medio E</th>
                            <th style="padding: 10px; border-bottom: 1px solid #e2e8f0; text-align: right;">Total (€)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows}
                    </tbody>
                    <tfoot style="background: #1e293b; color: white; font-weight: bold;">
                        <tr>
                            <td style="padding: 10px;">TOTALES</td>
                            <td class="text-right" style="padding: 10px;">${formatNumber(totals.kwh, 0)} kWh</td>
                            <td class="text-right" style="padding: 10px;">${formatCurrency(totals.energy)}</td>
                            <td class="text-right" style="padding: 10px;">${formatCurrency(totals.power)}</td>
                            <td class="text-right" style="padding: 10px;">${formatCurrency(totals.others)}</td>
                            <td class="text-right" style="padding: 10px;">-</td>
                            <td class="text-right" style="padding: 10px; color: ${isDanger ? '#f87171' : '#34d399'}; font-size: 1.1rem;">${formatCurrency(totals.total)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
        </div>
    `;
}

function parseDate(periodStr) {

    if (!periodStr) return 0;
    const match = periodStr.match(/(\d{2})[\/.-](\d{2})[\/.-](\d{4})/);
    if (!match) return 0;
    return new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime();
}

function switchView(viewId) {
    const v = document.getElementById(viewId);
    if (!v) return;
    
    document.querySelectorAll('.view').forEach(view => view.classList.add('hidden'));
    v.classList.remove('hidden');

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === viewId);
    });
}

// --- SAVED COMPARISONS LOGIC ---

window.saveComparison = function() {
    if (!window.currentComparisonData) return;
    const data = window.currentComparisonData;
    
    // Check if a comparison for this CUPS already exists
    const duplicate = savedComparisons.find(c => c.cups === data.cups);
    if (duplicate) {
        alert('Este punto de suministro (CUPS) ya está incluido en el reporte comercial.');
        return;
    }
    
    savedComparisons.push(data);
    localStorage.setItem('audit_pro_comparisons', JSON.stringify(savedComparisons));
    renderSavedComparisons();
    alert('Comparativa guardada correctamente.');
}

window.clearSavedComparisons = function() {
    if (confirm('¿Estás seguro de que deseas vaciar el reporte de comparativas guardadas?')) {
        savedComparisons = [];
        localStorage.removeItem('audit_pro_comparisons');
        renderSavedComparisons();
    }
}

window.removeComparison = function(idx) {
    if (confirm('¿Deseas eliminar esta comparativa del reporte?')) {
        savedComparisons.splice(idx, 1);
        localStorage.setItem('audit_pro_comparisons', JSON.stringify(savedComparisons));
        renderSavedComparisons();
    }
}

// --- PDF REPORT HELPERS ---

function getReportHeader(title) {
    const today = new Date().toLocaleDateString('es-ES');
    return `
        <div class="report-header" style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 30px; border-bottom: 2px solid #2563eb; padding-bottom: 20px;">
            <div>
                <h1 style="color: #1e293b; margin: 0; font-size: 24px;">${title}</h1>
                <p style="color: #64748b; margin: 5px 0 0; font-size: 14px;">ECE Consultores - Consultoría Energética</p>
                <p style="color: #94a3b8; margin: 2px 0 0; font-size: 12px;">Fecha del informe: ${today}</p>
            </div>
            <div style="text-align: right;">
                ${customLogoData ? 
                    `<img src="${customLogoData}" style="max-height: 70px; max-width: 200px; object-fit: contain;">` : 
                    `<div style="font-size: 24px; font-weight: bold; color: #2563eb;">ECE Consultores</div>`
                }
            </div>
        </div>
    `;
}

function getReportFooter() {
    return ``;
}

function getConceptBreakdownTemplate(item) {
    const rent = (item.adjustments || []).filter(a => a.concept.toLowerCase().includes('alquiler') || a.concept.toLowerCase().includes('medidor')).reduce((a, b) => a + (b.amount || 0), 0);
    const others = (item.adjustments || []).filter(a => !a.concept.toLowerCase().includes('alquiler') && !a.concept.toLowerCase().includes('medidor')).reduce((a, b) => a + (b.amount || 0), 0);
    
    const diff = (val1, val2) => {
        const d = val1 - val2;
        const color = d > 0.01 ? '#10b981' : (d < -0.01 ? '#ef4444' : '#64748b');
        return `<span style="color: ${color}; font-weight: 700;">${formatCurrency(d)}</span>`;
    };

    const providerDisplay = item.providerName || 'Actual';

    return `
        <div class="pdf-card">
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 25px;">
                <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #2563eb;">
                    <div style="font-size: 9px; text-transform: uppercase; color: #64748b; margin-bottom: 4px;">Ahorro en Energía</div>
                    <div style="font-size: 18px; font-weight: 700; color: #1e293b;">${formatCurrency(item.currentEnergyCost - item.proposedEnergyCost)}</div>
                </div>
                <div style="background: #f8fafc; padding: 15px; border-radius: 8px; border-left: 4px solid #2563eb;">
                    <div style="font-size: 9px; text-transform: uppercase; color: #64748b; margin-bottom: 4px;">Ahorro en Potencia</div>
                    <div style="font-size: 18px; font-weight: 700; color: #1e293b;">${formatCurrency(item.currentPowerCost - item.proposedPowerCost)}</div>
                </div>
            </div>

            <table class="pdf-table">
                <thead>
                    <tr>
                        <th style="text-align: left;">Concepto de Facturación</th>
                        <th>Factura Actual (${providerDisplay})</th>
                        <th>Factura Propuesta</th>
                        <th>Ahorro Neto</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td><strong>Coste Energía (Mercado)</strong><br><small style="color: #94a3b8;">Margen Comercialización</small></td>
                        <td class="text-right">${formatCurrency(item.currentMarket)}</td>
                        <td class="text-right">${formatCurrency(item.proposedMarket)}</td>
                        <td class="text-right">${diff(item.currentMarket, item.proposedMarket)}</td>
                    </tr>
                    <tr>
                        <td><strong>Peajes de Energía</strong><br><small style="color: #94a3b8;">Cargos y Peajes Regulados</small></td>
                        <td class="text-right">${formatCurrency(item.currentTolls)}</td>
                        <td class="text-right">${formatCurrency(item.proposedTolls)}</td>
                        <td class="text-right">${diff(item.currentTolls, item.proposedTolls)}</td>
                    </tr>
                    <tr>
                        <td><strong>Término de Potencia</strong><br><small style="color: #94a3b8;">Capacidad Contratada</small></td>
                        <td class="text-right">${formatCurrency(item.currentPowerCost)}</td>
                        <td class="text-right">${formatCurrency(item.proposedPowerCost)}</td>
                        <td class="text-right">${diff(item.currentPowerCost, item.proposedPowerCost)}</td>
                    </tr>
                    <tr>
                        <td>Impuesto Eléctrico</td>
                        <td class="text-right">${formatCurrency(item.currentElectricTax)}</td>
                        <td class="text-right">${formatCurrency(item.proposedElectricTax)}</td>
                        <td class="text-right">${diff(item.currentElectricTax, item.proposedElectricTax)}</td>
                    </tr>
                    <tr>
                        <td>Alquiler y Otros Conceptos</td>
                        <td class="text-right">${formatCurrency(rent + others)}</td>
                        <td class="text-right">${formatCurrency(rent + others)}</td>
                        <td class="text-right">0,00 €</td>
                    </tr>
                    <tr>
                        <td>IVA / Impuestos Indirectos</td>
                        <td class="text-right">${formatCurrency(item.currentVat)}</td>
                        <td class="text-right">${formatCurrency(item.proposedVat)}</td>
                        <td class="text-right">${diff(item.currentVat, item.proposedVat)}</td>
                    </tr>
                </tbody>
                <tfoot style="background: #1e293b; color: white;">
                    <tr>
                        <td style="padding: 12px 16px;">TOTAL FACTURACIÓN ANUAL (PROYECTADA)</td>
                        <td class="text-right" style="padding: 12px 16px;">${formatCurrency(item.currentTotal)}</td>
                        <td class="text-right" style="padding: 12px 16px;">${formatCurrency(item.proposedTotal)}</td>
                        <td class="text-right" style="padding: 12px 16px; color: #10b981; font-size: 14px;">${formatCurrency(item.currentTotal - item.proposedTotal)}</td>
                    </tr>
                </tfoot>
            </table>
        </div>
    `;
}

window.renderSavedComparisons = function() {
    const container = document.getElementById('saved-comparisons-list');
    const btn = document.getElementById('download-saved-comparisons-btn');
    if (!container) return;

    if (savedComparisons.length === 0) {
        container.innerHTML = '<p>No hay comparativas guardadas. Calcula una comparativa arriba y pulsa "Guardar Comparativa" para añadirla al reporte.</p>';
        container.className = 'empty-state';
        if (btn) btn.style.display = 'none';
        return;
    }

    const titleElement = document.getElementById('saved-comparisons-title');
    if (titleElement && savedComparisons.length > 0) {
        titleElement.textContent = `Reporte Consolidado ${savedComparisons[0].clientName || ''}`;
    } else if (titleElement) {
        titleElement.textContent = "Reporte Consolidado Guardado";
    }

    container.className = 'table-container card';
    container.style.padding = '0';
    if (btn) btn.style.display = 'inline-block';

    let totalGlobalKWh = 0;
    let totalGlobalCurrent = 0;
    let totalGlobalProposed = 0;

    const rows = savedComparisons.map((comp, idx) => {
        totalGlobalKWh += comp.totalKWh;
        totalGlobalCurrent += comp.totalCurrent;
        totalGlobalProposed += comp.totalProposed;
        
        return `
            <tr>
                <td>${comp.clientAddress || 'Dirección N/D'}</td>
                <td>${(comp.cups || '').slice(-5)}</td>
                <td class="text-right">${formatNumber(comp.totalKWh, 0)}</td>
                <td class="text-right">${formatCurrency(comp.currentAvgPrice, 4)}</td>
                <td class="text-right">${formatCurrency(comp.totalCurrent)}</td>
                <td class="text-right">${formatCurrency(comp.proposedAvgPrice, 4)}</td>
                <td class="text-right">${formatCurrency(comp.totalProposed)}</td>
                <td class="text-right" style="color: #16a34a; font-weight:bold;">
                    ${formatCurrency(comp.totalSavings)}
                    <br><span style="font-size: 10px; color: ${comp.auditStatus === 'OK' ? '#16a34a' : (comp.auditStatus === 'ERROR' ? '#be123c' : '#f59e0b')}; font-weight: 700;">
                        ${comp.auditStatus === 'OK' ? '✓ Auditado OK' : (comp.auditStatus === 'ERROR' ? '⚠️ Discrepancia' : '⚠️ Sin Total PDF')}
                    </span>
                </td>
                <td class="text-right">
                    <button class="btn secondary small" onclick="viewComparisonDetails(${idx})">🔍</button>
                    <button class="btn danger small" onclick="removeComparison(${idx})">✕</button>
                </td>
            </tr>
        `;
    }).join('');

    const globalSavings = totalGlobalCurrent - totalGlobalProposed;
    const globalSavingsPercent = totalGlobalCurrent > 0 ? (globalSavings / totalGlobalCurrent) * 100 : 0;

    container.innerHTML = `
        <table id="saved-comparisons-table" style="width: 100%; border-collapse: collapse;">
            <thead>
                <tr>
                    <th>Ubicación</th>
                    <th>CUPS</th>
                    <th>kWh</th>
                    <th>Precio Act.</th>
                    <th>Total Act.</th>
                    <th>Precio Prop.</th>
                    <th>Total Prop.</th>
                    <th>Ahorro</th>
                    <th>Acciones</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
            <tfoot>
                <tr style="background-color: #1e293b; color: white; font-weight: bold;">
                    <td colspan="2" class="text-right">TOTAL CARTERA (${savedComparisons.length} puntos)</td>
                    <td class="text-right">${formatNumber(totalGlobalKWh, 0)}</td>
                    <td colspan="2" class="text-right">${formatCurrency(totalGlobalCurrent)}</td>
                    <td colspan="2" class="text-right">${formatCurrency(totalGlobalProposed)}</td>
                    <td class="text-right" style="color: #4ade80;">${formatCurrency(globalSavings)} (${globalSavingsPercent.toFixed(1)}%)</td>
                </tr>
            </tfoot>
        </table>
    `;
}

const PDF_STYLES = `
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        .pdf-container { font-family: 'Inter', sans-serif; color: #1e293b; background: white; line-height: 1.3; }
        .pdf-page { width: 210mm; padding: 25px 30px; box-sizing: border-box; page-break-after: always; position: relative; background: white; }
        .pdf-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; border-bottom: 2px solid #f1f5f9; padding-bottom: 15px; }
        .pdf-logo { max-height: 50px; max-width: 220px; object-fit: contain; }
        .pdf-title-box { text-align: right; }
        .pdf-title-box h1 { margin: 0; font-size: 16px; color: #2563eb; font-weight: 800; text-transform: uppercase; }
        .pdf-title-box p { margin: 2px 0 0 0; font-size: 9px; color: #64748b; font-weight: 500; }
        
        .kpi-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-bottom: 25px; }
        .kpi-card { background: #f8fafc; padding: 12px; border-radius: 8px; border: 1px solid #e2e8f0; }
        .kpi-card.highlight { background: #1e293b; color: white; border: none; }
        .kpi-label { font-size: 8px; text-transform: uppercase; color: #64748b; margin-bottom: 4px; font-weight: 600; }
        .kpi-card.highlight .kpi-label { color: #94a3b8; }
        .kpi-value { font-size: 16px; font-weight: 700; }
        
        .pdf-table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 9px; }
        .pdf-table th { background: #f8fafc; color: #475569; font-weight: 700; padding: 8px 10px; border-bottom: 2px solid #e2e8f0; text-align: right; text-transform: uppercase; font-size: 7px; letter-spacing: 0.05em; }
        .pdf-table th:first-child { text-align: left; }
        .pdf-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; text-align: right; }
        .pdf-table td:first-child { text-align: left; font-weight: 600; color: #334155; }
        .pdf-table tfoot { background: #f8fafc; font-weight: 800; border-top: 2px solid #e2e8f0; }
        
        .pdf-card { background: white; border: 1px solid #e2e8f0; border-radius: 12px; padding: 12px; margin-bottom: 12px; }
        .section-title { font-size: 13px; font-weight: 800; color: #1e293b; margin: 15px 0 8px 0; display: flex; align-items: center; border-left: 4px solid #2563eb; padding-left: 10px; }
        
        .text-right { text-align: right; }
        .text-success { color: #10b981 !important; }
    </style>
`;

function getPDFHeader(title, subtitle) {
    return `
        <div class="pdf-header">
            ${customLogoData ? `<img src="${customLogoData}" class="pdf-logo">` : `<div style="font-size: 20px; font-weight: 800; color: #2563eb;">ECE Consultores</div>`}
            <div class="pdf-title-box">
                <h1>${title}</h1>
                <p>${subtitle}</p>
            </div>
        </div>
    `;
}

window.viewComparisonDetails = function(idx) {
    const comp = savedComparisons[idx];
    if (!comp) return;

    // Detect if tariff is 2.0TD to apply correct regulatory rates
    const is20 = comp.is20 || (comp.cups && (comp.cups.length > 0)) && (comp.detailedData?.[0]?.contractedPower?.[2] === 0);
    
    const titleModal = document.getElementById('modal-comp-title');
    if (titleModal) titleModal.innerText = `Comparativa Detallada: ${comp.clientName} (${comp.cups})`;
    
    let html = '';
    
    if (!comp.detailedData || comp.detailedData.length === 0) {
        html = '<p style="padding:20px; text-align:center; color:#64748b;">Este suministro carece de desglose detallado. Vuelva a generar la comparativa.</p>';
    } else {
        comp.detailedData.forEach((item, index) => {
            let currentSum = 0;
            let proposedSum = 0;

            const renderRow = (label, currentVal, proposedVal, diffVal, isSubtotal = false, isEnergy = false, pIdx = null) => {
                const subClass = isSubtotal ? 'mirror-row-subtotal' : 'mirror-row-details';
                let extraCell = '';
                let extraCellProp = '';
                if (pIdx !== null) {
                    const c = (item.consumptions && item.consumptions[pIdx]) || 0;
                    if (isEnergy) {
                        const curR = (item.currentEnergyMarketRates && item.currentEnergyMarketRates[pIdx]) || 0;
                        const propR = (item.targetPrices && item.targetPrices[pIdx]) || 0;
                        extraCell = (curR > 0) ? `<span style="font-size:0.7rem; color:#64748b;">${formatNumber(c,2)}kWh * ${formatNumber(curR,4)}€</span><br>` : '';
                        extraCellProp = `<span style="font-size:0.7rem; color:#64748b;">${formatNumber(c,2)}kWh * ${formatNumber(propR,4)}€</span><br>`;
                    } else {
                        const kw = (item.contractedPower && item.contractedPower[pIdx]) || 0;
                        const days = item.billingDays || 0;
                        const curR = (item.currentPowerRates && item.currentPowerRates[pIdx]) || 0;
                        const targetP = (item.targetPowerPrices && item.targetPowerPrices[pIdx]) || 0;
                        const boeRates = is20 ? (pIdx === 0 ? 0.075903 : 0.001988) : ((boePeajesExtPower[pIdx]||0) + (boeCargosExtPower[pIdx]||0));
                        const propR = targetP + boeRates;
                        extraCell = (curR > 0) ? `<span style="font-size:0.7rem; color:#64748b;">${kw}kW*${days}d * ${formatNumber(curR,4)}</span><br>` : '';
                        extraCellProp = `<span style="font-size:0.7rem; color:#64748b;">${kw}kW*${days}d * ${formatNumber(propR,4)}</span><br>`;
                    }
                }

                return `
                    <tr class="${subClass}">
                        <td style="padding-left:${isSubtotal ? '12px' : '1.5rem'}; color:#475569;">${label}</td>
                        <td class="text-right">${extraCell || ''}${formatCurrency(currentVal)}</td>
                        <td class="text-right" style="background:#f0fdf4;">${(extraCell ? extraCellProp : '') || ''}<strong>${formatCurrency(proposedVal)}</strong></td>
                        <td class="text-right" style="color:${diffVal > 0.01 ? '#16a34a' : (diffVal < -0.01 ? '#ef4444' : '#64748b')}; font-weight:bold;">${formatCurrency(diffVal)}</td>
                    </tr>
                `;
            };

            const renderRowWithSum = (label, currentVal, proposedVal, diffVal, isSubtotal = false, isEnergy = false, pIdx = null) => {
                if (!isSubtotal) {
                    currentSum += (currentVal || 0);
                    proposedSum += (proposedVal || 0);
                }
                return renderRow(label, currentVal, proposedVal, diffVal, isSubtotal, isEnergy, pIdx);
            };

            let rowsHtml = "";
            
            // 1. POTENCIA
            rowsHtml += `
                <tr class="mirror-row-total">
                    <td colspan="4" style="background:#f1f5f9; padding:6px 12px; font-weight:bold; color:#1e293b;">TÉRMINO DE POTENCIA CONTRATADA</td>
                </tr>
                ${renderRowWithSum("Importe por capacidad (fijo)", item.currentPowerCost, item.proposedPowerCost, item.currentPowerCost - item.proposedPowerCost, true)}
                ${[0,1,2,3,4,5].map(i => {
                    const kw = (item.contractedPower && item.contractedPower[i]) || 0;
                    if (kw <= 0) return '';
                    const days = item.billingDays || 0;
                    const curR = (item.currentPowerRates && item.currentPowerRates[i]) || 0;
                    const targetP = (item.targetPowerPrices && item.targetPowerPrices[i]) || 0;
                    const boeRates = is20 ? (i===0?0.075903:0.001988) : (boePeajesExtPower[i]||0)+(boeCargosExtPower[i]||0);
                    const propR = targetP + boeRates;
                    
                    const curTotal = (item.powerCostItems && item.powerCostItems[i]) !== undefined ? item.powerCostItems[i] : (kw * days * curR);
                    const propTotal = kw * days * propR;
                    const diff = curTotal - propTotal;
                    
                    return renderRowWithSum(`Potencia P${i+1}`, curTotal, propTotal, diff);
                }).join('')}

                <!-- 2. ENERGÍA -->
                <tr class="mirror-row-total" style="border-top:1rem solid transparent;">
                    <td colspan="4" style="background:#f1f5f9; padding:6px 12px; font-weight:bold; color:#1e293b;">TÉRMINO DE ENERGÍA CONSUMIDA</td>
                </tr>
                ${renderRowWithSum("Coste de Mercado y Margen", item.currentMarket, item.proposedMarket, item.currentMarket - item.proposedMarket, true)}
                ${[0,1,2,3,4,5].map(i => {
                    const kwh = (item.consumptions && item.consumptions[i]) || 0;
                    const curR = (item.currentEnergyMarketRates && item.currentEnergyMarketRates[i]) || 0;
                    const propR = (item.targetPrices && item.targetPrices[i]) || 0;
                    if (kwh <= 0 && ((item.energyMarketItems && item.energyMarketItems[i]) || 0) <= 0) return '';
                    
                    const curTotal = (item.energyMarketItems && item.energyMarketItems[i]) !== undefined ? item.energyMarketItems[i] : (kwh * curR);
                    const propTotal = kwh * propR;
                    const diff = curTotal - propTotal;
                    
                    return renderRowWithSum(`Consumo Energía P${i+1}`, curTotal, propTotal, diff, false, true, i);
                }).join('')}
                ${renderRowWithSum("Peajes, Cargos y Regulados (Passthrough)", item.currentTolls, item.proposedTolls, item.currentTolls - item.proposedTolls)}

                <!-- 3. OTROS CONCEPTOS -->
                <tr class="mirror-row-total" style="border-top:1rem solid transparent;">
                    <td colspan="4" style="background:#f1f5f9; padding:6px 12px; font-weight:bold; color:#1e293b;">AJUSTES, SERVICIOS E IMPUESTOS</td>
                </tr>
                ${renderRowWithSum("Impuesto de electricidad", item.currentElectricTax, item.proposedElectricTax, item.currentElectricTax - item.proposedElectricTax)}
                
                ${(item.rentCost > 0) ? renderRowWithSum("Alquiler de contador", item.rentCost, item.rentCost, 0) : ''}
                ${(item.socialBond > 0) ? renderRowWithSum("Financiación Bono Social", item.socialBond, item.socialBond, 0) : ''}

                ${(item.adjustments || []).filter(a => {
                    const desc = (a.concept || a.description || "").toLowerCase();
                    return !desc.includes("alquiler") && !desc.includes("social");
                }).map(adj => {
                   const desc = (adj.concept || adj.description || "").toLowerCase();
                   const isMgmt = desc.includes("gestión");
                   const valActual = adj.amount || 0;
                   const valProp = isMgmt ? 0 : valActual;
                   const label = isMgmt ? "Coste de Gestión (Gestoría)" : (adj.concept || adj.description || "Concepto Extra");
                   return renderRowWithSum(label, valActual, valProp, valActual - valProp);
                }).join('')}

                ${renderRowWithSum("IVA / IGIC de Aplicación", item.currentVat, item.proposedVat, item.currentVat - item.proposedVat)}
            `;

            const finalAhorro = currentSum - proposedSum;

            html += `
            <div style="border:1px solid #e2e8f0; border-radius:12px; margin-bottom:30px; background:white; overflow:hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
                <div style="background:#1e293b; color:white; padding:12px 20px; font-weight:bold; display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-size:0.9rem;">PERIODO: ${formatDateToNumeric(item.period)}</span>
                    <div style="text-align:right;">
                        <span style="font-size:0.8rem; color:#94a3b8; font-weight:normal;">AHORRO NETO COMPROMETIDO</span><br>
                        <span style="color:#22c55e; font-size:1.1rem; font-weight:800;">${formatCurrency(finalAhorro)}</span>
                    </div>
                </div>
                
                <table class="modal-table" style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr style="background:#f8fafc; border-bottom:2px solid #e2e8f0;">
                            <th style="padding:12px; text-align:left; width:35%;">Conceptos de Facturación</th>
                            <th style="padding:12px; text-align:right; width:22%;">Factura Actual (${comp.providerName || 'Original'})</th>
                            <th style="padding:12px; text-align:right; width:22%; background:#f0fdf4;">Factura Propuesta (${comp.targetProvider || 'Nueva'})</th>
                            <th style="padding:12px; text-align:right; width:21%;">Ahorro</th>
                        </tr>
                    </thead>
                    <tbody style="font-size:0.85rem;">
                        ${rowsHtml}
                    </tbody>
                    <tfoot style="background:#1e293b; color:white; border-top:2px solid #1e293b; font-size:1.1rem; font-weight:800;">
                        <tr>
                            <td style="padding:15px;">TOTAL FACTURA PROYECTADA</td>
                            <td class="text-right" style="color:#ffffff;">${formatCurrency(currentSum)}</td>
                            <td class="text-right" style="color:#4ade80; background:rgba(255,255,255,0.05);">${formatCurrency(proposedSum)}</td>
                            <td class="text-right" style="color:#22c55e;">${formatCurrency(finalAhorro)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
            `;
        });
    }
    
    // Botón de Debug para ver los datos crudos de la IA
    html += `
    <div style="margin-top: 30px; border-top: 2px dashed #e2e8f0; padding-top: 15px; padding-bottom: 20px;">
        <button onclick="let el = document.getElementById('raw-ia-data'); el.style.display = (el.style.display === 'none' ? 'block' : 'none')" 
                style="background: #e2e8f0; color: #475569; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-size: 0.85rem; font-weight: bold; width: 100%; transition: all 0.2s;">
            🔍 VER JSON DE EXTRACCIÓN IA (DATOS RAW)
        </button>
        <div id="raw-ia-data" style="display:none; margin-top:15px; background:#f8fafc; padding:20px; border-radius:12px; border:1px solid #e2e8f0; box-shadow: inset 0 2px 4px 0 rgba(0,0,0,0.05);">
            <p style="margin-bottom:10px; font-size:0.8rem; color:#64748b; font-weight:bold;">Este es el resultado exacto capturado por el prompt. Útil para verificar por qué un dato no se muestra.</p>
            <pre style="font-size:0.75rem; white-space: pre-wrap; word-break: break-all; color:#334155; font-family: 'Courier New', monospace;">${JSON.stringify(comp, null, 2)}</pre>
        </div>
    </div>
    `;

    const contentArea = document.getElementById('modal-comp-content');
    if (contentArea) contentArea.innerHTML = html;
    
    const modal = document.getElementById('comparison-details-modal');
    if (modal) {
        modal.classList.remove('hidden');
        modal.style.display = 'flex';
    }
};

window.viewOriginalPDF = function(fileName) {
    if (!fileName) {
        alert("No hay nombre de archivo asociado.");
        return;
    }
    const file = window.pendingPdfFiles.get(fileName);
    if (!file) {
        alert("⚠️ El archivo PDF original ya no está en la memoria (se ha recargado la web o ha pasado demasiado tiempo). \n\nPara verlo, por favor suba de nuevo el PDF en la pestaña de 'Subida de Facturas'. Los datos de la auditoría se mantienen, pero el visor del documento fuente requiere la subida activa.");
        return;
    }
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
};

// --- UTILITIES ---

function formatCurrency(amount, decimals = 2) {
    if (!Number.isFinite(amount)) return decimals === 0 ? '0 €' : '0,00 €';
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount);
}

function formatNumber(amount, decimals = 2) {
    if (!Number.isFinite(amount)) return '0';
    return new Intl.NumberFormat('es-ES', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(amount);
}

function formatDateToNumeric(str) {
    if (!str) return 'N/D';
    if (str.includes(' - ')) {
        return str.split(' - ').map(s => formatDateToNumeric(s)).join(' - ');
    }
    
    // Diccionario de meses en español
    const months = {
        'enero': '01', 'febrero': '02', 'marzo': '03', 'abril': '04', 'mayo': '05', 'junio': '06',
        'julio': '07', 'agosto': '08', 'septiembre': '09', 'octubre': '10', 'noviembre': '11', 'diciembre': '12'
    };
    
    const parts = str.toLowerCase().split(' de ');
    if (parts.length === 3) {
        const day = parts[0].trim().padStart(2, '0');
        const month = months[parts[1].trim()];
        const year = parts[2].trim();
        if (day && month && year) return `${day}/${month}/${year}`;
    }
    
    // Si ya es numérico (DD/MM/AAAA) o tiene otro formato, devolver tal cual
    return str;
}

function normalizeClientName(name) {
    if (!name || typeof name !== 'string') return 'N/D';
    return name.toUpperCase()
               .replace(/[,.]/g, '')
               .replace(/\s+/g, ' ')
               .trim();
}

function stopLoading() {
    const loadingIndicator = document.getElementById('loading');
    if (loadingIndicator) loadingIndicator.classList.add('hidden');
}

// --- INITIALIZATION & EVENT LISTENERS ---

document.addEventListener('DOMContentLoaded', () => {
    tryInitGoogle();

    const fileBtn = document.getElementById('select-files-btn');
    const fileInput = document.getElementById('file-input');
    if (fileBtn && fileInput) {
        fileBtn.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files.length > 0) processFiles(Array.from(e.target.files));
        });
    }

    const driveBtn = document.getElementById('gdrive-btn');
    if (driveBtn) {
        driveBtn.addEventListener('click', () => {
            if (gapiInited && gisInited) {
                const token = gapi.client.getToken();
                if (token) createPicker(token.access_token);
                else tokenClient.requestAccessToken({ prompt: '' });
            } else {
                alert("Google API no está lista todavía. Espera unos segundos.");
            }
        });
    }

    const pdfBtn = document.getElementById('pdf-btn');
    if (pdfBtn) pdfBtn.addEventListener('click', generatePDF);

    const logoInput = document.getElementById('logo-input');
    const logoBtn = document.getElementById('logo-btn');

    if (logoBtn && logoInput) {
        logoBtn.addEventListener('click', () => logoInput.click());
        logoInput.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const reader = new FileReader();
                reader.onload = async (event) => {
                    customLogoData = event.target.result;
                    logoBtn.textContent = "Guardando...";
                    try {
                        const response = await fetch('/api/save-logo', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ image: customLogoData })
                        });
                        if (response.ok) {
                            logoBtn.textContent = "Logo Guardado ✓";
                            logoBtn.classList.replace('secondary', 'success');
                            setTimeout(() => { logoBtn.textContent = "Subir Logo"; }, 2000);
                        }
                    } catch (err) {
                        console.error("Error saving logo:", err);
                    }
                };
                reader.readAsDataURL(file);
            }
        });
    }

    // Cargar logo silenciosamente sin errores 404
    fetch('/logo.png').then(response => {
        if (!response.ok) return; 
        return response.blob().then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result;
                if (dataUrl && dataUrl.startsWith('data:image')) {
                    customLogoData = dataUrl;
                    if (logoBtn) {
                        logoBtn.textContent = "Logo Disponible ✓";
                        logoBtn.classList.replace('secondary', 'success');
                    }
                }
            };
            reader.readAsDataURL(blob);
        });
    }).catch(() => {}); // Fallback silencioso

    const resetBtn = document.getElementById('reset-db-btn');
    if (resetBtn) resetBtn.addEventListener('click', resetDatabase);

    const stored = localStorage.getItem('audit_pro_db');
    if (stored) {
        dbInvoices = JSON.parse(stored);
        
        let migrated = false;
        dbInvoices.forEach(inv => {
            const raw = inv.clientName || 'N/D';
            const norm = normalizeClientName(raw);
            if (raw !== norm) {
                inv.clientName = norm;
                migrated = true;
            }
        });
        if (migrated) localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
        
        renderHistory();
        renderClients();
        renderPricing();
    }
    
    const storedPending = localStorage.getItem('audit_pro_pending_db');
    if (storedPending) {
        pendingInvoices = JSON.parse(storedPending);
    }

    const storedComparisons = localStorage.getItem('audit_pro_comparisons');
    if (storedComparisons) {
        savedComparisons = JSON.parse(storedComparisons);
        renderSavedComparisons();
    }

    // 8. Comparison listeners
    const compareSelect = document.getElementById('target-provider-select');
    if (compareSelect) compareSelect.addEventListener('change', runComparison);

    // 9. Navigation listeners
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            const viewId = btn.getAttribute('data-view');
            if (viewId) {
                switchView(viewId);
                // Forzar re-renderizado al navegar para asegurar estados de UI limpios
                if (viewId === 'history-view') renderHistory();
                if (viewId === 'clients-view') renderClients();
                if (viewId === 'settings-view') renderPricing();
                if (viewId === 'compare-view') renderSavedComparisons();
            }
        });
    });

    // 10. Drop Zone
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) {
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('drag-over');
        });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
        dropZone.addEventListener('drop', handleDrop);
    }

    // Initialize custom providers
    loadCustomProviders();

    const showFormBtn = document.getElementById('show-provider-form-btn');
    const cancelFormBtn = document.getElementById('cancel-provider-btn');
    const providerCard = document.getElementById('new-provider-card');
    const providerForm = document.getElementById('provider-form');

    if (showFormBtn && providerCard) {
        showFormBtn.addEventListener('click', () => {
             window.editingProviderId = null;
             if (providerForm) providerForm.reset();
             
             const select = document.getElementById('new-tariff-type');
             if (select) {
                 select.value = '2.0';
                 window.toggleFormPeriods();
             }

             const formBtn = document.querySelector('#provider-form button[type="submit"]');
             if (formBtn) formBtn.textContent = 'Guardar Comercializadora';
             providerCard.classList.remove('hidden');
        });
    }
    if (cancelFormBtn && providerCard) {
        cancelFormBtn.addEventListener('click', () => {
             providerCard.classList.add('hidden');
             window.editingProviderId = null;
        });
    }

    if (providerForm) {
        providerForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('new-provider-name').value;
            const newProvider = {
                name: name,
                p1: parseFloat(document.getElementById('new-p1').value),
                p2: parseFloat(document.getElementById('new-p2').value),
                p3: parseFloat(document.getElementById('new-p3').value),
                p4: parseFloat(document.getElementById('new-p4').value),
                p5: parseFloat(document.getElementById('new-p5').value),
                p6: parseFloat(document.getElementById('new-p6').value),
                pp1: parseFloat(document.getElementById('new-pp1').value),
                pp2: parseFloat(document.getElementById('new-pp2').value),
                pp3: parseFloat(document.getElementById('new-pp3').value),
                pp4: parseFloat(document.getElementById('new-pp4').value),
                pp5: parseFloat(document.getElementById('new-pp5').value),
                pp6: parseFloat(document.getElementById('new-pp6').value)
            };

            const id = window.editingProviderId || name.toLowerCase().replace(/ /g, '_');
            const stored = localStorage.getItem('custom_providers');
            let custom = stored ? JSON.parse(stored) : {};
            custom[id] = newProvider;
            
            localStorage.setItem('custom_providers', JSON.stringify(custom));
            providerForm.reset();
            providerCard.classList.add('hidden');
            
            window.editingProviderId = null;
            const formBtn = document.querySelector('#provider-form button[type="submit"]');
            if (formBtn) formBtn.textContent = 'Guardar Comercializadora';
            
            renderPricing();
            alert('Comercializadora guardada con éxito.');
        });
    }
});

window.resetDatabase = function() {
    localStorage.removeItem('audit_pro_db');
    localStorage.removeItem('audit_pro_comparisons');
    dbInvoices = [];
    savedComparisons = [];
    renderHistory();
    renderClients();
    renderPricing();
    renderSavedComparisons();
    alert('Base de datos borrada correctamente.');
};

window.resetDatabaseWithConfirmation = function() {
    if (confirm('¿Estás seguro de que deseas borrar TODA la base de datos? Esta acción no se puede deshacer.')) {
        if (confirm('RECONFIRMACIÓN: Se perderán todos los clientes, facturas guardadas y reportes comerciales. ¿Continuar?')) {
            window.resetDatabase();
        }
    }
};


window.selectForComparison = function(invoiceNum) {
    const inv = dbInvoices.find(i => i.invoiceNum === invoiceNum) || invoices.find(i => i.invoiceNum === invoiceNum);
    if (!inv) return;

    // Actualizar la info de referencia
    const refInfo = document.getElementById('ref-invoice-info');
    if (refInfo) {
        refInfo.innerHTML = `
            <strong>Factura:</strong> ${inv.invoiceNum || 'N/D'}<br>
            <strong>Consumo Total:</strong> ${formatNumber(inv.consumption || 0, 2)} kWh<br>
            <strong>Tarifa Detectada:</strong> <span class="badge secondary">${inv.tariffType || 'N/D'}</span><br>
            <strong>Pago Actual:</strong> ${formatCurrency(inv.totalCalculated || 0)}
        `;
    }
    window.selectedRefInvoice = inv;

    // 1. Filtrar por CUPS en la vista de comparativa
    const cupsSelect = document.getElementById('history-cups-filter');
    if (cupsSelect) {
        const clientSelect = document.getElementById('history-client-filter');
        if (clientSelect) {
            clientSelect.value = normalizeClientName(inv.clientName);
            updateCupsFilter();
        }
        cupsSelect.value = inv.cups;
    }

    // 2. Cambiar a la vista de comparativa
    switchView('compare-view');

    // 3. Ejecutar la comparativa automáticamente si hay una comercializadora seleccionada
    const targetProvider = document.getElementById('target-provider-select');
    if (targetProvider && targetProvider.value) {
        document.getElementById('comparison-results').classList.remove('hidden');
        runComparison();
    }
}

window.showHistoryAudit = function(invoiceNum, cups, period) {
    let inv = dbInvoices.find(i => i.invoiceNum === invoiceNum);
    if (!inv && cups && period) {
        inv = dbInvoices.find(i => i.cups === cups && i.period === period);
    }
    if (!inv) {
        alert("No se ha encontrado la factura en el historial.");
        return;
    }

    const modal = document.getElementById('comparison-details-modal');
    const content = document.getElementById('modal-comp-content');
    const title = document.getElementById('modal-comp-title');
    if (!modal || !content || !title) return;

    title.innerHTML = `Detalle de Factura - ${inv.invoiceNum}`;
    
    const c = Array.isArray(inv.consumptionItems) ? inv.consumptionItems : [inv.consumption, 0, 0, 0, 0, 0];
    const pwr = Array.isArray(inv.contractedPower) ? inv.contractedPower : [0,0,0,0,0,0];
    const days = inv.billingDays || 0;
    
    const adjArr = Array.isArray(inv.adjustments) ? [...inv.adjustments] : [];
    if (inv.rentCost > 0) adjArr.push({ description: 'Alquiler de Contador', amount: inv.rentCost });
    if (inv.socialBond > 0) adjArr.push({ description: 'Bono Social', amount: inv.socialBond });
    if (inv.reactiveEnergyCost > 0) adjArr.push({ description: 'Energía Reactiva', amount: inv.reactiveEnergyCost });
    if (inv.otherSpecificCost > 0) adjArr.push({ description: 'Otros Conceptos Factura', amount: inv.otherSpecificCost });

    const renderEnergyMarketRow = (pIdx) => {
        const kwh = c[pIdx] || 0;
        if (kwh === 0) return '';
        const price = inv.energyMarketRates?.[pIdx] || 0;
        const total = Math.round(kwh * price * 100) / 100;
        return `
            <tr class="mirror-row-details">
                <td>Energía Consumida P${pIdx+1} <small>(${formatNumber(kwh,2)} kWh)</small></td>
                <td class="text-right">
                    <span style="font-size:0.75rem;">${formatNumber(kwh,2)} * ${formatNumber(price, 4)}€</span><br>
                    <strong>${formatCurrency(total)}</strong>
                </td>
            </tr>
        `;
    };

    const renderEnergyTollsRow = (pIdx) => {
        const kwh = c[pIdx] || 0;
        if (kwh === 0) return '';
        const pRate = inv.energyPeajeRates?.[pIdx] || 0;
        const cRate = inv.energyCargoRates?.[pIdx] || 0;
        const totalRate = pRate + cRate;
        const total = Math.round(kwh * totalRate * 100) / 100;
        return `
            <tr class="mirror-row-details">
                <td>Peajes y Cargos P${pIdx+1} <small>(${formatNumber(kwh,2)} kWh)</small></td>
                <td class="text-right">
                    <span style="font-size:0.75rem;">${formatNumber(kwh,2)} * ${formatNumber(totalRate, 4)}€</span><br>
                    <strong>${formatCurrency(total)}</strong>
                </td>
            </tr>
        `;
    };

    const renderPowerRow = (pIdx) => {
        const kw = pwr[pIdx] || 0;
        if (kw === 0) return '';
        const rates = [inv.powerPeajeRates?.[pIdx]||0, inv.powerCargoRates?.[pIdx]||0, inv.powerFenieRates?.[pIdx]||0];
        const price = rates.reduce((a,b)=>a+b, 0);
        const total = Math.round(kw * days * price * 100) / 100;
        return `
            <tr class="mirror-row-details">
                <td>Potencia Facturada P${pIdx+1} <small>(${kw}kW * ${days}d)</small></td>
                <td class="text-right">
                    <span style="font-size:0.75rem;">${formatNumber(kw,2)} * ${days} * ${formatNumber(price, 4)}€</span><br>
                    <strong>${formatCurrency(total)}</strong>
                </td>
            </tr>
        `;
    };

    const eMarketTotal = inv.energyMarketTotal || (Array.isArray(inv.energyMarketItems) ? inv.energyMarketItems.reduce((a,b)=>a+b,0) : 0);
    const eTollsTotal = inv.energyTollsTotal || (Array.isArray(inv.energyTollsItems) ? inv.energyTollsItems.reduce((a,b)=>a+b,0) : 0);

    // --- SECCIÓN DE AUDITORÍA PARA EL CONSULTOR ---
    let auditHtml = '';
    const auditStatus = inv._auditStatus || 'OK';
    const paperT = inv.totalInvoice_PDF || 0;
    const calcT = inv.totalCalculated || 0;
    const discrepancy = inv._auditDiscrepancy || 0;

    if (auditStatus === 'ERROR' || Math.abs(discrepancy) >= 0.01) {
        const sign = discrepancy > 0 ? '+' : '';
        // Diagnóstico (copiado de renderDashboard para consistencia)
        const suspects = [];
        const gapAbs = Math.abs(discrepancy);
        if ((inv.powerCost || 0) < 0.5 && gapAbs > 5) suspects.push('Potencia no extraída (0,00 €)');
        if ((inv.energyCost || 0) < 0.5 && gapAbs > 5) suspects.push('Energía no extraída (0,00 €)');
        if (Math.abs((inv.othersCost || 0) - gapAbs) < 1.0) suspects.push('Posible duplicado en Otros/Impuestos');
        if (Math.abs(gapAbs - (inv.vatAmount_PDF || 0)) < 0.05) suspects.push('IVA/IGIC posiblemente doble contado');

        auditHtml = `
            <div style="background: #fff1f2; border: 2px solid #fda4af; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; animation: border-pulse 2s infinite;">
                <div style="display:flex; align-items:center; gap:0.75rem; color:#be123c; margin-bottom:1rem;">
                    <i class="fa-solid fa-triangle-exclamation" style="font-size:1.5rem;"></i>
                    <h3 style="margin:0; font-size:1.2rem;">ERROR DE AUDITORÍA: Discrepancia detectada</h3>
                </div>
                <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:1rem; background:white; padding:1rem; border-radius:8px; border:1px solid #fecdd3;">
                    <div>
                        <span style="font-size:0.75rem; color:#64748b; text-transform:uppercase; font-weight:700;">Total en PDF (Papel)</span><br>
                        <span style="font-size:1.25rem; font-weight:bold; color:#1e293b;">${formatCurrency(paperT)}</span>
                    </div>
                    <div>
                        <span style="font-size:0.75rem; color:#64748b; text-transform:uppercase; font-weight:700;">Total Calculado</span><br>
                        <span style="font-size:1.25rem; font-weight:bold; color:#e11d48;">${formatCurrency(calcT)}</span>
                    </div>
                    <div>
                        <span style="font-size:0.75rem; color:#64748b; text-transform:uppercase; font-weight:700;">Diferencia (Gap)</span><br>
                        <span style="font-size:1.25rem; font-weight:bold; color:#be123c;">${sign}${formatCurrency(discrepancy)}</span>
                    </div>
                </div>
                ${suspects.length > 0 ? `
                <div style="margin-top:1rem; color:#9f1239; font-size:0.9rem; font-style:italic;">
                    <strong>Posible causa detectada:</strong> ${suspects.join(' | ')}
                </div>
                ` : ''}
            </div>
            <style>
                @keyframes border-pulse { 0% { border-color: #fda4af; } 50% { border-color: #e11d48; } 100% { border-color: #fda4af; } }
            </style>
        `;
    } else if (auditStatus === 'NO_PDF_TOTAL') {
        auditHtml = `
            <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; display:flex; align-items:center; gap:0.75rem; color:#92400e;">
                <i class="fa-solid fa-circle-question"></i>
                <span><strong>Aviso:</strong> No se pudo validar el total contra el PDF porque no se detectó el importe total en el papel.</span>
            </div>
        `;
    } else {
        auditHtml = `
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 12px; padding: 1rem; margin-bottom: 1.5rem; display:flex; align-items:center; gap:0.75rem; color:#166534;">
                <i class="fa-solid fa-circle-check"></i>
                <span><strong>Verificado:</strong> El total calculado coincide exactamente con el total impreso en el PDF (${formatCurrency(paperT)}).</span>
            </div>
        `;
    }

    content.innerHTML = `
        ${auditHtml}
        <div style="background: #f8fafc; padding: 1.5rem; border-radius: 12px; border: 1px solid #e2e8f0; margin-bottom: 2rem;">
            <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                <div>
                    <h3 style="margin:0; color:#1e293b;">${inv.clientName || 'Cliente'}</h3>
                    <p style="margin:0.2rem 0; color:#64748b; font-size:0.9rem;">CUPS: ${inv.cups} | Tarifa: ${inv.tariffType || 'N/D'}</p>
                </div>
                <div style="text-align:right;">
                    <span style="font-size:0.8rem; color:#64748b; text-transform:uppercase;">Total Factura de Empresa</span><br>
                    <span style="font-size:1.5rem; font-weight:bold; color:#1e293b;">${formatCurrency(inv.totalCalculated)}</span>
                </div>
            </div>
        </div>

        <div style="border:1px solid #e2e8f0; border-radius:12px; background:white; overflow:hidden; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
            <table class="modal-table" style="width:100%; border-collapse:collapse;">
                <thead>
                    <tr style="background:#f1f5f9; border-bottom:2px solid #e2e8f0;">
                        <th style="padding:12px; text-align:left;">Conceptos de Facturación</th>
                        <th style="padding:12px; text-align:right;">Importe</th>
                    </tr>
                </thead>
                <tbody>
                    <!-- 1. BLOQUE POTENCIA TOTAL (FIJO) -->
                    <tr class="mirror-row-total" style="border-top:1.5rem solid transparent;">
                        <td style="padding:12px;">Facturación por potencia contratada (término fijo)</td>
                        <td class="text-right amount" style="padding:12px;">${formatCurrency(inv.powerTotalFixed_Invoice || (inv.powerCost || 0))}</td>
                    </tr>
                    <tr class="mirror-row-subtotal">
                        <td style="padding:8px 12px; font-size:0.85rem;">Importe por potencia</td>
                        <td class="text-right" style="padding:8px 12px;">${formatCurrency(inv.powerCost || 0)}</td>
                    </tr>
                    ${[0,1,2,3,4,5].map(i => renderPowerRow(i)).join('')}

                    <!-- 2. BLOQUE ENERGIA TOTAL (VARIABLE) -->
                    <tr style="height: 1.5rem;"><td colspan="2" style="border-bottom: 1px solid #e2e8f0;"></td></tr>
                    <tr class="mirror-row-total">
                        <td style="padding:12px;">Facturación por energía consumida (término variable)</td>
                        <td class="text-right amount" style="padding:12px;">${formatCurrency(inv.energyTotalVariable_Invoice || (eMarketTotal + eTollsTotal))}</td>
                    </tr>

                    <!-- Sub-bloque Mercado -->
                    <tr class="mirror-row-subtotal">
                        <td style="padding:8px 12px; font-size:0.85rem;">Importe por energía consumida</td>
                        <td class="text-right" style="padding:8px 12px;">${formatCurrency(eMarketTotal)}</td>
                    </tr>
                    ${[0,1,2,3,4,5].map(i => renderEnergyMarketRow(i)).join('')}

                    <!-- Sub-bloque Peajes -->
                    <tr class="mirror-row-subtotal">
                        <td style="padding:8px 12px; font-size:0.85rem;">Coste de peajes de transporte, distribución y cargos</td>
                        <td class="text-right" style="padding:8px 12px;">${formatCurrency(eTollsTotal)}</td>
                    </tr>
                    ${[0,1,2,3,4,5].map(i => renderEnergyTollsRow(i)).join('')}
                    
                    <!-- 3. BLOQUE ALQUILER (ANTES ERA EQUIPOS DE MEDIDA) -->
                    <tr style="height: 1.5rem;"><td colspan="2" style="border-bottom: 1px solid #e2e8f0;"></td></tr>
                    <tr class="mirror-row-total">
                         <td style="padding:10px 12px;">Alquiler de contador</td>
                         <td class="text-right amount" style="padding:10px 12px;">${formatCurrency(inv.rentCost || 0)}</td>
                    </tr>

                    <!-- 4. BLOQUE OTROS CONCEPTOS -->
                    <tr style="height: 1.5rem;"><td colspan="2" style="border-bottom: 1px solid #e2e8f0;"></td></tr>
                    <tr class="mirror-row-total">
                        <td style="padding:10px 12px;">Otros conceptos</td>
                        <td class="text-right amount" style="padding:10px 12px;">${formatCurrency((inv.otherSpecificCost || 0) + (inv.socialBond || 0))}</td>
                    </tr>
                    ${inv.otherSpecificCost ? `
                    <tr class="mirror-row-details">
                        <td style="padding:6px 24px; font-size:0.8rem;">Coste de gestión</td>
                        <td class="text-right" style="padding:6px 24px; font-size:0.85rem;">${formatCurrency(inv.otherSpecificCost)}</td>
                    </tr>
                    ` : ''}
                    ${inv.socialBond > 0 ? `
                    <tr class="mirror-row-details">
                        <td style="padding:6px 24px; font-size:0.8rem;">Financiación del bono social</td>
                        <td class="text-right" style="padding:6px 24px; font-size:0.85rem;">${formatCurrency(inv.socialBond)}</td>
                    </tr>
                    ` : ''}

                    <!-- 5. BLOQUE IMPUESTO ELECTRICIDAD (SEPARADO) -->
                    <tr style="height: 1.5rem;"><td colspan="2" style="border-bottom: 1px solid #e2e8f0;"></td></tr>
                    <tr class="mirror-row-total">
                        <td style="padding:10px 12px;">Impuesto de electricidad</td>
                        <td class="text-right amount" style="padding:10px 12px;">${formatCurrency(inv.electricTax || 0)}</td>
                    </tr>
                    ${inv.electricTaxRate ? `
                    <tr class="mirror-row-details">
                        <td style="padding:6px 24px; font-size:0.8rem;">${formatNumber(inv.electricTaxRate, 4)}% * ${formatCurrency(inv.electricTaxBase || 0)}</td>
                        <td class="text-right" style="padding:6px 24px; font-size:0.85rem;">${formatCurrency(inv.electricTax || 0)}</td>
                    </tr>
                    ` : ''}

                    <!-- 6. BLOQUE IMPUESTO DE APLICACIÓN (SEPARADO) -->
                    <tr style="height: 1.5rem;"><td colspan="2" style="border-bottom: 1px solid #e2e8f0;"></td></tr>
                    <tr class="mirror-row-total">
                        <td style="padding:10px 12px;">Impuesto de aplicación</td>
                        <td class="text-right amount" style="padding:10px 12px;">${formatCurrency(inv.vat || 0)}</td>
                    </tr>
                    ${inv.vatDetails && inv.vatDetails.length > 0 ? inv.vatDetails.map(v => `
                    <tr class="mirror-row-details">
                        <td style="padding:6px 24px; font-size:0.8rem;">${formatNumber(v.rate, 0)}% ${v.description} * ${formatCurrency(v.base || 0)}</td>
                        <td class="text-right" style="padding:6px 24px; font-size:0.85rem;">${formatCurrency(v.amount || 0)}</td>
                    </tr>
                    `).join('') : `
                    <tr class="mirror-row-details">
                        <td style="padding:6px 24px; font-size:0.8rem;">IVA / IGIC aplicado</td>
                        <td class="text-right" style="padding:6px 24px; font-size:0.85rem;">${formatCurrency(inv.vat || 0)}</td>
                    </tr>
                    `}
                    
                    ${inv.adjustments && inv.adjustments.length > 0 ? inv.adjustments.map(adj => `
                        <tr class="mirror-row-details">
                            <td style="padding:8px 12px; padding-left:24px;">${adj.description}</td>
                            <td class="text-right"><strong>${formatCurrency(adj.amount)}</strong></td>
                        </tr>
                    `).join('') : ''}
                </tbody>
                </tfoot>
            </table>
        </div>
    `;

    if (modal) {
        modal.style.display = 'flex';
        modal.classList.remove('hidden');
    }
    if (content) content.scrollTop = 0;
}

// --- PDF TEMPLATE HELPERS ---

function renderDetailedAuditTable(item, comp, is20) {
    const renderRow = (label, currentVal, proposedVal, diffVal, isSubtotal = false, isEnergy = false, pIdx = null) => {
        let extraCell = '';
        let extraCellProp = '';
        if (pIdx !== null) {
            const c = (item.consumptions && item.consumptions[pIdx]) || 0;
            if (isEnergy) {
                const curR = (item.currentEnergyMarketRates && item.currentEnergyMarketRates[pIdx]) || 0;
                const propR = (item.targetPrices && item.targetPrices[pIdx]) || 0;
                extraCell = (curR > 0 || (currentVal === 0 && c > 0)) ? `<div style="font-size:8px; color:#64748b; margin-bottom:2px;">${formatNumber(c,2)}kWh * ${formatNumber(curR,4)}€</div>` : '';
                extraCellProp = `<div style="font-size:8px; color:#64748b; margin-bottom:2px;">${formatNumber(c,2)}kWh * ${formatNumber(propR,4)}€</div>`;
            } else {
                const kw = (item.contractedPower && item.contractedPower[pIdx]) || 0;
                const days = item.billingDays || 0;
                const curR = (item.currentPowerRates && item.currentPowerRates[pIdx]) || 0;
                const targetP = (item.targetPowerPrices && item.targetPowerPrices[pIdx]) || 0;
                const propR = targetP + (is20 ? (pIdx === 0 ? 0.075903 : 0.001988) : ((boePeajesExtPower[pIdx]||0) + (boeCargosExtPower[pIdx]||0)));
                extraCell = (curR > 0 || (currentVal === 0 && kw > 0)) ? `<div style="font-size:8px; color:#64748b; margin-bottom:2px;">${kw}kW*${days}d * ${formatNumber(curR,4)}</div>` : '';
                extraCellProp = `<div style="font-size:8px; color:#64748b; margin-bottom:2px;">${kw}kW*${days}d * ${formatNumber(propR,4)}</div>`;
            }
        }

        return `
            <tr class="${isSubtotal ? 'category-total-row' : 'detail-row'}">
                <td style="padding-left:${isSubtotal ? '10px' : '20px'}; font-weight:${isSubtotal ? '700' : '400'}; text-align: left;">${label}</td>
                <td class="text-right">${extraCell}${formatCurrency(currentVal)}</td>
                <td class="text-right bg-emerald">${extraCellProp}${formatCurrency(proposedVal)}</td>
                <td class="text-right" style="color:${diffVal > 0.01 ? '#10b981' : (diffVal < -0.01 ? '#ef4444' : '#64748b')}; font-weight:700;">${formatCurrency(diffVal)}</td>
            </tr>
        `;
    };

    return `
        <table class="detailed-table">
            <thead>
                <tr>
                    <th style="width: 40%; text-align: left;">Conceptos de Facturación</th>
                    <th class="text-right">Actual</th>
                    <th class="text-right" style="background:#f0fdf4;">Propuesta</th>
                    <th class="text-right">Ahorro</th>
                </tr>
            </thead>
            <tbody>
                <!-- 1. BLOQUE POTENCIA -->
                <tr class="category-row"><td colspan="4">TÉRMINO DE POTENCIA CONTRATADA</td></tr>
                ${renderRow("Importe por capacidad (fijo)", item.currentPowerCost, item.proposedPowerCost, item.currentPowerCost - item.proposedPowerCost, true)}
                ${[0,1,2,3,4,5].map(i => {
                    const kw = (item.contractedPower && item.contractedPower[i]) || 0;
                    const curR = (item.currentPowerRates && item.currentPowerRates[i]) || 0;
                    const targetP = (item.targetPowerPrices && item.targetPowerPrices[i]) || 0;
                    if (kw <= 0) return '';
                    const propR = targetP + (is20 ? (i===0?0.075903:0.001988) : (boePeajesExtPower[i]||0)+(boeCargosExtPower[i]||0));
                    const curTotal = (item.powerCostItems && item.powerCostItems[i]) !== undefined ? item.powerCostItems[i] : (kw * item.billingDays * curR);
                    const propTotal = kw * item.billingDays * propR;
                    return renderRow(`Potencia P${i+1}`, curTotal, propTotal, curTotal - propTotal, false, false, i);
                }).join('')}

                <!-- 2. BLOQUE ENERGIA -->
                <tr class="category-row"><td colspan="4">TÉRMINO DE ENERGÍA CONSUMIDA</td></tr>
                ${renderRow("Coste de Mercado y Margen", item.currentMarket, item.proposedMarket, item.currentMarket - item.proposedMarket, true)}
                ${[0,1,2,3,4,5].map(i => {
                    const kwh = (item.consumptions && item.consumptions[i]) || 0;
                    const curR = (item.currentEnergyMarketRates && item.currentEnergyMarketRates[i]) || 0;
                    const propR = (item.targetPrices && item.targetPrices[i]) || 0;
                    if (kwh <= 0 && ((item.energyMarketItems && item.energyMarketItems[i]) || 0) <= 0) return '';
                    const curTotal = (item.energyMarketItems && item.energyMarketItems[i]) !== undefined ? item.energyMarketItems[i] : (kwh * curR);
                    const propTotal = kwh * propR;
                    return renderRow(`Consumo Energía P${i+1}`, curTotal, propTotal, curTotal - propTotal, false, true, i);
                }).join('')}
                
                <!-- 3. PEAJES -->
                ${renderRow("Peajes, Cargos y Regulados (Passthrough)", item.currentTolls, item.proposedTolls, item.currentTolls - item.proposedTolls, true)}

                <!-- 4. OTROS -->
                <tr class="category-row"><td colspan="4">AJUSTES, SERVICIOS E IMPUESTOS</td></tr>
                ${renderRow("Impuesto de electricidad", item.currentElectricTax, item.proposedElectricTax, item.currentElectricTax - item.proposedElectricTax, true)}
                ${(item.adjustments || []).map(adj => renderRow(adj.concept || adj.description || "Concepto Extra", adj.amount || 0, adj.amount || 0, 0, false)).join('')}
                ${renderRow("IVA / IGIC de Aplicación", item.currentVat, item.proposedVat, item.currentVat - item.proposedVat, true)}

                <tr class="total-row">
                    <td>TOTAL PROYECTADO</td>
                    <td class="text-right">${formatCurrency(item.currentTotal)}</td>
                    <td class="text-right">${formatCurrency(item.proposedTotal)}</td>
                    <td class="text-right">${formatCurrency(item.currentTotal - item.proposedTotal)}</td>
                </tr>
            </tbody>
        </table>
    `;
}

// --- GENERACIÓN DE PDF PROFESIONAL (REMOTO) ---
async function generateRemotePDF(html, filename, btn, originalText) {
    try {
        const response = await fetch('/api/generate-pdf', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html, filename })
        });

        if (!response.ok) throw new Error('Error al generar PDF en el servidor');

        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        document.body.removeChild(a);
    } catch (error) {
        console.error("PDF Error:", error);
        alert("Error al generar el PDF. Asegúrate de que el servidor esté activo.");
    } finally {
        if (btn) {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }
    }
}

// --- GENERACIÓN DE PDF PROFESIONAL ---
window.generatePDF = function(inv) {
    if (!inv) return;
    const btn = document.getElementById('pdf-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
    btn.disabled = true;

    const pdfStyles = `
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
            body { font-family: 'Inter', sans-serif; color: #1e293b; margin: 0; padding: 0; }
            .page { width: 210mm; min-height: 297mm; padding: 20mm; box-sizing: border-box; position: relative; page-break-after: always; background: white; }
            .header { display: flex; justify-content: space-between; align-items: start; border-bottom: 2px solid #e2e8f0; padding-bottom: 20px; margin-bottom: 30px; }
            .logo { height: 50px; width: auto; object-fit: contain; }
            .header-right { text-align: right; }
            .header-right h1 { margin: 0; font-size: 22px; color: #2563eb; font-weight: 800; text-transform: uppercase; }
            .header-right .ref { font-size: 11px; color: #64748b; margin-top: 5px; }
            
            .info-box-container { display: flex; gap: 20px; margin-bottom: 30px; }
            .info-box { flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; }
            .info-label { font-size: 9px; color: #64748b; text-transform: uppercase; font-weight: 600; margin-bottom: 5px; }
            .info-value { font-size: 14px; font-weight: 800; color: #1e293b; }
            
            .stats-bar { display: flex; align-items: center; justify-content: space-between; background: #1e293b; color: white; padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; }
            .stats-label { font-size: 11px; font-weight: 700; text-transform: uppercase; }
            .stats-value { font-size: 14px; font-weight: 800; color: #10b981; }

            .detailed-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 20px; }
            .detailed-table th { background: #f8fafc; padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0; color: #475569; font-weight: 700; text-transform: uppercase; }
            .detailed-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
            .detailed-table .category-row { background: #f1f5f9; font-weight: 800; text-transform: uppercase; color: #1e293b; font-size: 10px; padding: 10px; }
            .detailed-table .category-total-row td { background: #f8fafc; font-weight: 700; color: #1e293b; }
            .detailed-table .detail-row td { color: #475569; }
            .detailed-table .total-row { background: #1e293b; color: white; font-weight: 800; font-size: 11px; }
            .detailed-table .total-row td { border: none; padding: 15px 10px; }
            
            .text-right { text-align: right; }
            .bg-emerald { background: #f0fdf4 !important; }
        </style>
    `;

    const proposedTotal = inv.proposedTotal || 0;
    const totalSavings = inv.totalCalculated - proposedTotal;
    const is20 = (inv.tariffType || "").includes("2.0");

    // Convertimos el objeto inv simple en una estructura compatible con el helper
    const itemData = {
        period: inv.period,
        consumptions: inv.consumptionItems || [inv.consumption, 0,0,0,0,0],
        contractedPower: inv.contractedPower || [0,0,0,0,0,0],
        billingDays: inv.billingDays || 0,
        currentPowerCost: inv.powerCost || 0,
        currentPowerRates: inv.powerPeajeRates || [0,0,0,0,0,0],
        currentMarket: (inv.energyCost || 0) - (inv.energyTollsTotal || 0),
        currentTolls: inv.energyTollsTotal || 0,
        currentEnergyMarketRates: inv.energyMarketRates || [0,0,0,0,0,0],
        currentElectricTax: inv.electricTax || 0,
        currentVat: inv.vat || 0,
        currentTotal: inv.totalCalculated,
        
        proposedPowerCost: inv.proposedPowerCost || 0,
        proposedMarket: (inv.proposedEnergyCost || 0) - (inv.proposedTolls || 0),
        proposedTolls: inv.proposedTolls || 0,
        proposedElectricTax: inv.proposedElectricTax || 0,
        proposedVat: inv.proposedVat || 0,
        proposedTotal: proposedTotal,

        targetPrices: inv.targetPrices || [0,0,0,0,0,0],
        targetPowerPrices: inv.targetPowerPrices || [0,0,0,0,0,0],
        adjustments: inv.adjustments || []
    };
    
    const logoHtml = `<img src="LOGO_PLACEHOLDER" class="logo">`;

    const html = `
        <html>
        <head>${pdfStyles}</head>
        <body>
            <div class="page">
                <div class="header">
                    <div class="header-left">
                        ${logoHtml}
                    </div>
                    <div class="header-right">
                        <h1>INFORME DETALLADO DE SUMINISTRO</h1>
                        <div class="ref">CUPS: ${inv.cups}</div>
                    </div>
                </div>

                <div class="info-box-container">
                    <div class="info-box">
                        <div class="info-label">TITULAR DEL CONTRATO</div>
                        <div class="info-value">${inv.clientName || 'N/D'}</div>
                    </div>
                    <div class="info-box">
                        <div class="info-label">UBICACIÓN DEL SUMINISTRO</div>
                        <div class="info-value">${inv.clientAddress || inv.address || 'Dirección no detectada'}</div>
                    </div>
                </div>

                <div class="stats-bar">
                    <div class="stats-label">PERIODO: ${inv.period || 'N/D'}</div>
                    <div class="stats-value">Ahorro: ${formatCurrency(totalSavings)}</div>
                </div>

                ${renderDetailedAuditTable(itemData, {}, is20)}
            </div>
        </body>
        </html>
    `;

    const filename = `Auditoria_${inv.clientName || 'Factura'}_${inv.invoiceNumber || 'SinRef'}.pdf`;
    generateRemotePDF(html, filename, btn, originalText);
};

window.generateSavedComparisonsPDF = function() {
    if (savedComparisons.length === 0) return;
    
    const btn = document.getElementById('download-saved-comparisons-btn');
    const originalText = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Generando...';
    btn.disabled = true;

    // Totales Agregados para Portada
    let totalActual = 0;
    let totalPropuesto = 0;
    savedComparisons.forEach(c => {
        totalActual += (c.totalCurrent || 0);
        totalPropuesto += (c.totalProposed || 0);
    });
    const totalAhorro = totalActual - totalPropuesto;
    const reduccionMedia = totalActual > 0 ? (totalAhorro / totalActual) * 100 : 0;

    const pdfStyles = `
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
            body { font-family: 'Inter', sans-serif; color: #1e293b; margin: 0; padding: 0; }
            .page { width: 210mm; min-height: 297mm; padding: 20mm; box-sizing: border-box; position: relative; page-break-after: always; background: white; }
            
            /* Header */
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 25px; border-bottom: 2px solid #1e293b; padding-bottom: 15px; }
            .logo-container { height: 60px; display: flex; align-items: center; }
            .logo { max-height: 55px; width: auto; object-fit: contain; }
            .header-right { text-align: right; }
            .header-right h1 { margin: 0; font-size: 22px; color: #2563eb; font-weight: 800; text-transform: uppercase; }
            .header-right .ref { font-size: 11px; color: #64748b; margin-top: 5px; }

            /* Cards */
            .cards-container { display: flex; gap: 15px; margin-bottom: 30px; }
            .card { flex: 1; border-radius: 12px; padding: 20px; border: 1px solid #e2e8f0; background: #f8fafc; }
            .card.dark { background: #1e293b; color: white; border: none; }
            .card-label { font-size: 9px; font-weight: 700; text-transform: uppercase; margin-bottom: 8px; opacity: 0.8; }
            .card-value { font-size: 24px; font-weight: 800; }
            .card-value.green { color: #10b981; }

            /* Section Titles */
            .section-title { display: flex; align-items: center; gap: 10px; margin: 30px 0 15px; }
            .blue-bar { width: 4px; height: 24px; background: #2563eb; border-radius: 2px; }
            .section-title h2 { margin: 0; font-size: 16px; font-weight: 800; color: #1e293b; }
            .section-desc { font-size: 12px; color: #64748b; margin-bottom: 20px; }

            /* Tables */
            .summary-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 30px; }
            .summary-table th { background: #f8fafc; padding: 12px 10px; text-align: left; border-bottom: 2px solid #e2e8f0; color: #475569; font-weight: 700; text-transform: uppercase; }
            .summary-table td { padding: 12px 10px; border-bottom: 1px solid #f1f5f9; }
            .summary-table .total-row { background: #f8fafc; font-weight: 800; font-size: 11px; }
            
            .detailed-table { width: 100%; border-collapse: collapse; font-size: 10px; margin-bottom: 20px; }
            .detailed-table th { background: #f8fafc; padding: 10px; text-align: left; border-bottom: 2px solid #e2e8f0; color: #475569; font-weight: 700; text-transform: uppercase; }
            .detailed-table td { padding: 8px 10px; border-bottom: 1px solid #f1f5f9; vertical-align: middle; }
            .detailed-table .category-row { background: #f1f5f9; font-weight: 800; text-transform: uppercase; color: #1e293b; font-size: 10px; padding: 10px; }
            .detailed-table .category-total-row td { background: #f8fafc; font-weight: 700; color: #1e293b; }
            .detailed-table .detail-row td { color: #475569; }
            .detailed-table .total-row { background: #1e293b; color: white; font-weight: 800; font-size: 11px; }
            .detailed-table .total-row td { border: none; padding: 15px 10px; }

            /* Note */
            .note-box { background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 12px; padding: 20px; margin-top: 40px; }
            .note-box p { margin: 0; font-size: 11px; line-height: 1.6; color: #1e40af; }
            .note-box strong { color: #1e3a8a; }

            .text-right { text-align: right; }
            .text-green { color: #10b981; font-weight: 700; }
            .text-red { color: #ef4444; font-weight: 700; }
            .bg-emerald { background: #f0fdf4 !important; }

            .info-box-container { display: flex; gap: 20px; margin-bottom: 30px; }
            .info-box { flex: 1; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 12px; padding: 15px; }
            .info-label { font-size: 9px; color: #64748b; text-transform: uppercase; font-weight: 600; margin-bottom: 5px; }
            .info-value { font-size: 14px; font-weight: 800; color: #1e293b; }
            
            .stats-bar { display: flex; align-items: center; justify-content: space-between; background: #1e293b; color: white; padding: 12px 20px; border-radius: 8px; margin-bottom: 20px; }
            .stats-label { font-size: 11px; font-weight: 700; text-transform: uppercase; }
            .stats-value { font-size: 14px; font-weight: 800; color: #10b981; }
        </style>
    `;

    const logoHtml = `<img src="LOGO_PLACEHOLDER" class="logo">`;

    // --- PAGINA 1: RESUMEN EJECUTIVO ---
    const page1 = `
        <div class="page">
            <div class="header">
                <div class="header-left">
                    ${logoHtml}
                </div>
                <div class="header-right">
                    <h1>PROPUESTA TÉCNICA DE AHORRO</h1>
                    <div class="ref">Informe Multipunto / Consolidado | Fecha: ${new Date().toLocaleDateString()}</div>
                </div>
            </div>

            <div class="cards-container">
                <div class="card dark">
                    <div class="card-label">AHORRO NETO ESTIMADO</div>
                    <div class="card-value green">${formatCurrency(totalAhorro)}</div>
                </div>
                <div class="card">
                    <div class="card-label">PUNTOS ANALIZADOS</div>
                    <div class="card-value">${savedComparisons.length}</div>
                </div>
                <div class="card">
                    <div class="card-label">REDUCCIÓN MEDIA</div>
                    <div class="card-value green">${reduccionMedia.toFixed(1)}%</div>
                </div>
            </div>

            <div class="section-title">
                <div class="blue-bar"></div>
                <h2>Resumen Suministros - ${savedComparisons[0].clientName || 'Cliente'}</h2>
            </div>
            <p class="section-desc">A continuación se detalla el ahorro consolidado para todos los suministros incluidos en este estudio:</p>

            <table class="summary-table">
                <thead>
                    <tr>
                        <th>CUPS</th>
                        <th>Tarifa</th>
                        <th style="width: 30%;">Ubicación</th>
                        <th class="text-right">Factura Actual</th>
                        <th class="text-right">Factura Propuesta</th>
                        <th class="text-right">Ahorro (€)</th>
                        <th class="text-right">% Ahorro</th>
                    </tr>
                </thead>
                <tbody>
                    ${savedComparisons.map(c => `
                        <tr>
                            <td style="font-weight:700;">${c.cups.slice(-5)}</td>
                            <td>${c.tariffType || 'N/D'}</td>
                            <td style="font-size:9px;">${c.clientAddress || 'N/D'}</td>
                            <td class="text-right">${formatCurrency(c.totalCurrent)}</td>
                            <td class="text-right">${formatCurrency(c.totalProposed)}</td>
                            <td class="text-right text-green">${formatCurrency(c.totalSavings)}</td>
                            <td class="text-right text-green">${((c.totalSavings / c.totalCurrent) * 100).toFixed(1)}%</td>
                        </tr>
                    `).join('')}
                    <tr class="total-row">
                        <td colspan="3">TOTAL CONSOLIDADO</td>
                        <td class="text-right">${formatCurrency(totalActual)}</td>
                        <td class="text-right">${formatCurrency(totalPropuesto)}</td>
                        <td class="text-right text-green">${formatCurrency(totalAhorro)}</td>
                        <td class="text-right text-green">${reduccionMedia.toFixed(1)}%</td>
                    </tr>
                </tbody>
            </table>

            <div class="note-box">
                <p><strong>Nota de Consultoría:</strong> Los cálculos presentados son proyecciones basadas en el consumo histórico facilitado. Los ahorros se aplican sobre los términos de energía y potencia, optimizando el margen de comercialización y aplicando las tarifas vigentes más competitivas del mercado.</p>
            </div>
        </div>
    `;

    // --- PAGINAS DETALLADAS ---
    let detailedPages = '';
    savedComparisons.forEach(comp => {
        const item = comp.detailedData?.[0] || {};
        const totalPointSavings = comp.totalSavings;
        const is20 = (comp.tariffType || "").includes("2.0");

        detailedPages += `
            <div class="page">
                <div class="header">
                    <div class="header-left">
                        ${logoHtml}
                    </div>
                    <div class="header-right">
                        <h1>INFORME DETALLADO DE SUMINISTRO</h1>
                        <div class="ref">CUPS: ${comp.cups}</div>
                    </div>
                </div>

                <div class="info-box-container">
                    <div class="info-box">
                        <div class="info-label">TITULAR DEL CONTRATO</div>
                        <div class="info-value">${comp.clientName || 'N/D'}</div>
                    </div>
                    <div class="info-box">
                        <div class="info-label">UBICACIÓN DEL SUMINISTRO</div>
                        <div class="info-value">${comp.clientAddress || 'Dirección no detectada'}</div>
                    </div>
                </div>

                <div class="stats-bar">
                    <div class="stats-label">PERIODO: ${item.period || 'Periodo de Auditoría'}</div>
                    <div class="stats-value">Ahorro: ${formatCurrency(totalPointSavings)}</div>
                </div>

                ${renderDetailedAuditTable(item, comp, is20)}
            </div>
        `;
    });

    const fullHtml = `
        <html>
        <head>${pdfStyles}</head>
        <body>
            ${page1}
            ${detailedPages}
        </body>
        </html>
    `;

    const filename = `Propuesta_Ahorro_ECE_${savedComparisons[0].clientName || 'Cliente'}.pdf`;
    generateRemotePDF(fullHtml, filename, btn, originalText);
};

window.exportHistoryPDF = function() {
    const table = document.querySelector('.history-table');
    if (!table) return;

    const btn = document.getElementById('download-history-pdf-btn');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Exportando...';
        btn.disabled = true;
    }

    const rows = Array.from(table.rows);
    const headers = Array.from(rows[0].cells).map(c => c.textContent).slice(0, -1); // Exclude Actions
    const dataRows = rows.slice(1).map(row => {
        return Array.from(row.cells).map(c => c.textContent.trim()).slice(0, -1);
    });

    const logoHtml = `<img src="LOGO_PLACEHOLDER" style="max-height: 50px; width: auto; object-fit: contain;">`;

    const html = `
        <div style="padding:30px; font-family:'Inter', sans-serif;">
            <div style="display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #1e293b; padding-bottom:15px; margin-bottom:25px;">
                <div class="header-left">
                    ${logoHtml}
                    <p style="margin:2px 0; font-size:12px; color:#64748b;">Reporte Histórico de Facturación</p>
                </div>
                <div style="text-align:right;">
                    <p style="margin:0; font-size:11px; color:#64748b;">Fecha Exportación: ${new Date().toLocaleDateString()}</p>
                </div>
            </div>
            
            <table style="width:100%; border-collapse:collapse; font-size:9px; border:1px solid #e2e8f0;">
                <thead>
                    <tr style="background:#1e293b; color:white;">
                        ${headers.map(h => `<th style="padding:8px; text-align:left; border:1px solid #334155;">${h}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
                    ${dataRows.map(row => `
                        <tr style="border-bottom:1px solid #e2e8f0;">
                            ${row.map(cell => `<td style="padding:6px; border:1px solid #f1f5f9;">${cell}</td>`).join('')}
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;

    generateRemotePDF(html, 'Historial_Facturas_ECE.pdf', btn, originalText);
};

