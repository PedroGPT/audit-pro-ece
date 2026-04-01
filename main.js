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
    return Number(String(value).replace(/\./g, '').replace(/,/g, '.')) || 0;
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
        byPeriod[period] = { period, kwh, unitPriceKwh };
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

// ========================================================================
// 5. MOTOR DE PROCESAMIENTO DE ARCHIVOS (AUDITORÍA IA CON OPENAI)
// ========================================================================
async function processFiles(files) {
    const loading = document.getElementById('loading');
    if (loading) loading.classList.remove('hidden');

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
            
            console.log(`[PDF] Texto extraído (${fullText.length} caracteres):`, fullText.substring(0, 200) + "...");

            // Extracción con IA (Configurado para tu OpenAI Key en el backend)
            let auditData = await runExtractionIA(fullText, file.name);
            if (!auditData) {
                console.warn('No hay datos IA para', file.name, '- aplicando fallback local.');
                auditData = fallbackParseInvoiceText(fullText, file.name);
            }
            console.log(`[Result] Datos extraídos:`, auditData);
            invoices.push(auditData);
            saveToDatabase([auditData]);
            await cloudSync(auditData);
        } catch (e) {
            console.error(`[Fatal] Error crítico en archivo ${file.name}:`, e);
        }
    }

    if (invoices.length > 0) {
        renderAuditDashboard();
        switchView('audit-view');
        // Mostrar el dashboard después del procesamiento
        const dashboard = document.getElementById('dashboard');
        if (dashboard) dashboard.classList.remove('hidden');
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
                comercializadora, electricityTax, igicTax, ivaTax, total,
                consumptionItems (array de 6 números P1..P6),
                energyPeriodItems (array [{period,kwh,unitPriceKwh}]),
                powerPeriodItems (array [{period,kw,unitPriceKw}]).
                Incluye only JSON válido, sin explicaciones extra.
                Texto: ${text.substring(0, 6000)}` 
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
        inv.supplyAddress = inv.supplyAddress || inv.address || inv.direccion || 'N/D';
        inv.cups = inv.cups || inv.CUPS || 'N/D';
        inv.period = inv.period || inv.periodo || 'N/D';

        // Si el modelo da items por periodo guardarlos
        inv.energyPeriodItems = (inv.energyPeriodItems || []).map(item => ({
            period: Number(item.period) || 0,
            kwh: parseSpanishNumber(item.kwh),
            unitPriceKwh: parseSpanishNumber(item.unitPriceKwh)
        })).filter(item => item.period >= 1 && item.period <= 6);

        inv.powerPeriodItems = (inv.powerPeriodItems || []).map(item => ({
            period: Number(item.period) || 0,
            kw: parseSpanishNumber(item.kw),
            unitPriceKw: parseSpanishNumber(item.unitPriceKw)
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
    invoice._energyPeriodsSource = invoice.energyPeriodItems.length > 0 ? 'regex' : 'none';
    invoice._powerPeriodsSource = invoice.powerPeriodItems.length > 0 ? 'regex' : 'none';

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

        if (supabaseClient) {
            supabaseClient.from('invoices').insert(invoiceRecords).then(({ error }) => {
                if (error) console.warn('Supabase insert fallido:', error.message);
            });
        }
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
        avgPriceEl.innerText = `${(consumption > 0 ? totalCalculated / consumption : 0).toFixed(4)} €/kWh`;
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
                🗑️ Vaciar Todo el Historial
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
    const energyPeriodsText = (inv.energyPeriodItems && inv.energyPeriodItems.length > 0)
        ? inv.energyPeriodItems.map(item => `P${item.period}: ${item.kwh.toFixed(2)} kWh @ ${item.unitPriceKwh.toFixed(6)} €/kWh`).join(' | ')
        : 'N/D';
    const powerPeriodsText = (inv.powerPeriodItems && inv.powerPeriodItems.length > 0)
        ? inv.powerPeriodItems.map(item => `P${item.period}: ${item.kw.toFixed(2)} kW @ ${item.unitPriceKw.toFixed(6)} €/kW`).join(' | ')
        : 'N/D';

    const rows = [
        ['Factura', inv.invoiceNum || 'S/N'],
        ['Cliente', inv.clientName || 'N/D'],
        ['Comercializadora', inv.comercializadora || 'N/D'],
        ['Dirección suministro', inv.supplyAddress || 'N/D'],
        ['CUPS', inv.cups || 'N/D'],
        ['Periodo', inv.period || 'N/D'],
        ['Consumo total (kWh)', inv.consumption?.toFixed(2) || '0'],
        ['Consumo por periodos (kWh)', (inv.consumptionItems && inv.consumptionItems.length > 0) ? inv.consumptionItems.map((v,o)=>`P${o+1}:${v.toFixed(2)}`).join(' | ') : 'N/D'],
        ['Energía por periodo', energyPeriodsText],
        ['Potencia por periodo', powerPeriodsText],
        ['Precio medio energía', `${(inv.energyUnitPriceAvg || 0).toFixed(6)} €/kWh`],
        ['Coste energía', formatCurrency(inv.energyCost)],
        ['Coste potencia', formatCurrency(inv.powerCost)],
        ['Otros costes', formatCurrency(inv.othersCost)],
        ['Alquiler', formatCurrency(inv.alquiler)],
        ['Reactiva', formatCurrency(inv.reactiveCost)],
        ['Subtotal base', formatCurrency(inv.breakdown?.subtotalBase || 0)],
        ['Impuesto electricidad', formatCurrency(inv.electricityTax || inv.breakdown?.iee || 0)],
        ['Tipo de impuesto', inv.taxName || (inv.igicTax ? 'IGIC' : inv.ivaTax ? 'IVA' : 'N/D')],
        ['Importe impuesto', formatCurrency(inv.taxValue || inv.breakdown?.taxAmount || 0)],
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
    modal.classList.remove('hidden');
}

function openDetailModalFromInvoices(index) {
    if (!invoices[index]) return;
    openDetailModal(invoices[index]);
    renderInvoiceDetail(invoices[index]);
}

function openDetailModalFromHistory(index) {
    if (!dbInvoices[index]) return;
    openDetailModal(dbInvoices[index]);
    renderInvoiceDetail(dbInvoices[index]);
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
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeDetailModal();
    }
});

function openCompareView(index) {
    const inv = invoices[index];
    if (!inv) return;

    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

    const periodRows = (inv.energyPeriodItems || []).map(item => {
        const idx = item.period - 1;
        const fenie = MARKET_BENCHMARK.fenie.energy[idx] || 0;
        const repsol = MARKET_BENCHMARK.repsol.energy[idx] || 0;
        return `<tr>
            <td>P${item.period}</td>
            <td>${item.kwh.toFixed(2)} kWh</td>
            <td>${item.unitPriceKwh.toFixed(6)} €/kWh</td>
            <td>${fenie.toFixed(6)} €/kWh</td>
            <td>${repsol.toFixed(6)} €/kWh</td>
        </tr>`;
    }).join('');

    const avgCurrent = (inv.energyUnitPriceAvg || (inv.consumption > 0 ? (parseFloat(inv.energyCost || 0) / inv.consumption) : 0));
    const avgFenie = MARKET_BENCHMARK.fenie.energy.reduce((a, b) => a + b, 0) / MARKET_BENCHMARK.fenie.energy.length;
    const avgRepsol = MARKET_BENCHMARK.repsol.energy.reduce((a, b) => a + b, 0) / MARKET_BENCHMARK.repsol.energy.length;

    const html = `
        <h3>Comparativa para factura ${inv.invoiceNum || 'S/N'}</h3>
        <p><strong>Cliente:</strong> ${inv.clientName || 'Desconocido'} | <strong>Comercializadora:</strong> ${inv.comercializadora || 'N/D'}</p>
        <p><strong>Comparativa de precios de energía</strong> (€/kWh por periodo)</p>
        <table class="modal-table">
            <thead><tr><th>Periodo</th><th>Consumo</th><th>Precio actual</th><th>Fenie</th><th>Repsol</th></tr></thead>
            <tbody>
                ${periodRows || '<tr><td colspan="5">No hay periodos extraídos todavía</td></tr>'}
                <tr class="mirror-row-total"><td>Promedio</td><td>-</td><td>${avgCurrent.toFixed(6)} €/kWh</td><td>${avgFenie.toFixed(6)} €/kWh</td><td>${avgRepsol.toFixed(6)} €/kWh</td></tr>
            </tbody>
        </table>
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
        console.log(`[History] Eliminada factura en índice ${index}`);
    }
}

function clearAllHistory() {
    if (confirm('¿Estás seguro de que quieres vaciar TODO el historial? Esta acción no se puede deshacer.')) {
        dbInvoices = [];
        localStorage.removeItem('audit_pro_db');
        renderHistory();
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
        console.log(`[Dashboard] Eliminada factura en índice ${index}`);
    }
}

function clearCurrentInvoices() {
    if (confirm('¿Quieres limpiar todas las facturas del dashboard actual?')) {
        invoices = [];
        const dashboard = document.getElementById('dashboard');
        if (dashboard) dashboard.classList.add('hidden');
        switchView('audit-view');
        console.log('[Dashboard] Dashboard limpiado');
    }
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
});