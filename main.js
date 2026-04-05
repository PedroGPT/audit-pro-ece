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
let modalGuardUntil = { detail: 0, commercializer: 0, compareSelector: 0, clientSupply: 0, compareTransparency: 0, clientAudit: 0 };
let clientSupplyRows = [];
let currentClientSupplyPdfUrl = null;
let supplyProposals = {};
let proposalsLog = [];
let compareBaseInvoice = null;
let compareCatalog = [];

// Limites operativos para carga masiva de facturas
const MAX_BATCH_INVOICES = 30;
const MAX_PDF_SIZE_MB = 15;
const INVOICE_FILES_DB_NAME = 'audit_pro_invoice_files';
const INVOICE_FILES_STORE_NAME = 'files';
const PDF_BUCKET_CANDIDATES = ['invoice-pdfs', 'Invoices-PDF', 'invoices-pdf'];

// Mapa para mantener los objetos File en memoria para el visor de PDF
window.pendingPdfFiles = new Map();

let invoiceFilesDbPromise = null;

function normalizePdfToken(value) {
    return String(value || '').trim().toLowerCase();
}

function getLegacyInvoiceStorageKey(inv = {}) {
    return [
        String(inv.invoiceNum || 'S/N').trim(),
        String(inv.fileName || '').trim(),
        String(inv.period || '').trim(),
        String(inv.cups || '').trim()
    ].join('|');
}

function getInvoiceStorageKeys(inv = {}, file = null) {
    const keys = [];
    const fileName = normalizePdfToken(file?.name || inv.fileName || '');
    const invoiceNum = normalizePdfToken(inv.invoiceNum || '');
    const cups = normalizePdfToken(inv.cups || '');
    const period = normalizePdfToken(inv.period || '');

    if (fileName) keys.push(`file:${fileName}`);
    if (invoiceNum && cups) keys.push(`inv:${invoiceNum}|${cups}|${period}`);

    const legacy = getLegacyInvoiceStorageKey(inv);
    if (legacy) keys.push(legacy);

    return [...new Set(keys.filter(Boolean))];
}

function isSameInvoiceRecord(a, b) {
    const keysA = new Set(getInvoiceStorageKeys(a));
    const keysB = getInvoiceStorageKeys(b);
    return keysB.some(key => keysA.has(key));
}

function upsertInvoiceInList(list = [], invoice = {}, putFirst = true) {
    const idx = list.findIndex(item => isSameInvoiceRecord(item, invoice));
    if (idx >= 0) {
        list.splice(idx, 1);
        if (putFirst) list.unshift(invoice);
        else list.push(invoice);
        return { updated: true, index: idx };
    }

    if (putFirst) list.unshift(invoice);
    else list.push(invoice);
    return { updated: false, index: -1 };
}

function cachePendingPdf(inv = {}, file = null) {
    if (!file) return;
    const keys = getInvoiceStorageKeys(inv, file);
    keys.forEach(key => window.pendingPdfFiles.set(key, file));

    const rawFileName = String(file.name || inv.fileName || '').trim();
    if (rawFileName) window.pendingPdfFiles.set(rawFileName, file);
}

function getPendingPdfFromMemory(inv = {}) {
    const keys = getInvoiceStorageKeys(inv);
    for (const key of keys) {
        const file = window.pendingPdfFiles.get(key);
        if (file) return file;
    }

    const rawFileName = String(inv.fileName || '').trim();
    if (rawFileName) {
        const direct = window.pendingPdfFiles.get(rawFileName);
        if (direct) return direct;
    }
    return null;
}

function openInvoiceFilesDb() {
    if (!window.indexedDB) return Promise.resolve(null);
    if (!invoiceFilesDbPromise) {
        invoiceFilesDbPromise = new Promise((resolve, reject) => {
            const request = window.indexedDB.open(INVOICE_FILES_DB_NAME, 1);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(INVOICE_FILES_STORE_NAME)) {
                    db.createObjectStore(INVOICE_FILES_STORE_NAME, { keyPath: 'id' });
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        }).catch(err => {
            console.warn('[PDFStore] No se pudo abrir IndexedDB:', err);
            invoiceFilesDbPromise = null;
            return null;
        });
    }
    return invoiceFilesDbPromise;
}

async function saveInvoicePdfToStore(inv, file) {
    const db = await openInvoiceFilesDb();
    const storageKeys = getInvoiceStorageKeys(inv, file);
    if (!db || storageKeys.length === 0 || !file) return;

    await new Promise((resolve, reject) => {
        const tx = db.transaction(INVOICE_FILES_STORE_NAME, 'readwrite');
        storageKeys.forEach(id => {
            tx.objectStore(INVOICE_FILES_STORE_NAME).put({
                id,
                fileName: String(file.name || inv.fileName || 'factura.pdf'),
                type: String(file.type || 'application/pdf'),
                blob: file
            });
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }).catch(err => {
        console.warn('[PDFStore] No se pudo guardar PDF en IndexedDB:', err);
    });
}

async function loadInvoicePdfFromStore(inv) {
    const db = await openInvoiceFilesDb();
    const storageKeys = getInvoiceStorageKeys(inv);
    if (!db || storageKeys.length === 0) return null;

    for (const id of storageKeys) {
        const found = await new Promise((resolve, reject) => {
            const tx = db.transaction(INVOICE_FILES_STORE_NAME, 'readonly');
            const request = tx.objectStore(INVOICE_FILES_STORE_NAME).get(id);
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        }).catch(err => {
            console.warn('[PDFStore] No se pudo recuperar PDF de IndexedDB:', err);
            return null;
        });

        if (found?.blob) {
            return found.blob instanceof File
                ? found.blob
                : new File([found.blob], found.fileName || inv.fileName || 'factura.pdf', { type: found.type || 'application/pdf' });
        }
    }

    return null;
}

async function deleteInvoicePdfFromStore(inv) {
    const db = await openInvoiceFilesDb();
    const storageKeys = getInvoiceStorageKeys(inv);
    if (!db || storageKeys.length === 0) return;

    await new Promise((resolve, reject) => {
        const tx = db.transaction(INVOICE_FILES_STORE_NAME, 'readwrite');
        storageKeys.forEach(id => tx.objectStore(INVOICE_FILES_STORE_NAME).delete(id));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }).catch(err => {
        console.warn('[PDFStore] No se pudo eliminar PDF de IndexedDB:', err);
    });
}

async function clearInvoicePdfStore() {
    const db = await openInvoiceFilesDb();
    if (!db) return;

    await new Promise((resolve, reject) => {
        const tx = db.transaction(INVOICE_FILES_STORE_NAME, 'readwrite');
        tx.objectStore(INVOICE_FILES_STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
    }).catch(err => {
        console.warn('[PDFStore] No se pudo vaciar IndexedDB:', err);
    });
}

async function getInvoicePdfFile(inv) {
    if (!inv) return null;
    const inMemory = getPendingPdfFromMemory(inv);
    if (inMemory) return inMemory;

    const storedFile = await loadInvoicePdfFromStore(inv);
    if (storedFile) {
        cachePendingPdf(inv, storedFile);
        return storedFile;
    }

    // Último recurso: Supabase Storage
    const cloudFile = await cloudLoadPdf(inv);
    if (cloudFile) {
        await saveInvoicePdfToStore(inv, cloudFile);
        return cloudFile;
    }

    return null;
}

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

    // Cargar estado local inmediato para que la UI arranque rápida.
    loadLocalStore();
    loadSupplyProposals();
    loadProposalsLog();
    loadCommercializers();

    // Rehidratar desde cloud para estado consistente entre dispositivos/deployments.
    await cloudLoadInvoices();
    await cloudLoadAppState();

    renderHistory();
    renderClients();
    renderProposals();
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

    if (viewId === 'compare-view') {
        const compareSection = document.getElementById('comparison-results');
        if (compareSection && !String(compareSection.innerHTML || '').trim()) {
            renderCompareLanding();
        }
    }
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
    const raw = String(value).trim().toUpperCase();
    if (!raw) return 0;

    const explicitPeriod = raw.match(/(?:^|\b)P\s*([1-6])(?:\b|$)/i);
    if (explicitPeriod) return Number(explicitPeriod[1]);

    const namedPeriod = raw.match(/(?:^|\b)PERIODO\s*([1-6])(?:\b|$)/i);
    if (namedPeriod) return Number(namedPeriod[1]);

    const direct = raw.match(/^([1-6])$/);
    return direct ? Number(direct[1]) : 0;
}

function normalizeTariffTypeValue(value) {
    const raw = String(value || '').replace(/\s+/g, '').toUpperCase();
    if (raw.startsWith('2.0')) return '2.0';
    if (raw.startsWith('3.0')) return '3.0';
    if (raw.startsWith('6.1')) return '6.1';
    return String(value || '').trim();
}

function assignSequentialPeriodsIfNeeded(items = [], tariffType = '') {
    const validItems = (items || []).filter(item => Number(item.kwh || item.kw || 0) > 0);
    if (!validItems.length) return [];

    const hasExplicitPeriods = validItems.some(item => Number(item.period || 0) >= 1 && Number(item.period || 0) <= 6);
    if (hasExplicitPeriods) {
        return validItems.filter(item => Number(item.period || 0) >= 1 && Number(item.period || 0) <= 6);
    }

    const configured = getConfiguredEnergyPeriodsByTariff(normalizeTariffTypeValue(tariffType));
    const fallbackPeriods = configured.slice(0, validItems.length);
    if (fallbackPeriods.length !== validItems.length) return [];

    return validItems.map((item, index) => ({
        ...item,
        period: fallbackPeriods[index]
    }));
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

function normalizeNameToken(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[\.,;:()\-_/]/g, ' ')
        .replace(/\b(s\.?l\.?|s\.?a\.?|slu|slne|sae)\b/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isInvalidClientNameCandidate(value) {
    const raw = String(value || '').trim();
    const norm = normalizeNameToken(raw);
    if (!norm) return true;
    if (norm.length < 4) return true;

    const banned = new Set([
        'nif', 'cif', 'dni', 'nie', 'cliente', 'titular', 'nombre',
        'razon social', 'direccion', 'suministro', 'cups'
    ]);
    if (banned.has(norm)) return true;

    // Evitar IDs y valores sin nombre real
    if (/^[a-z]?\d{6,}[a-z]?$/i.test(raw.replace(/\s+/g, ''))) return true;

    return false;
}

function detectClientNameFromText(text) {
    const raw = String(text || '');
    const taxIdMatches = [...raw.matchAll(/([A-ZÁÉÍÓÚÜÑ0-9\s\.,\-]{4,120})\s+(?:NIF|CIF)\s*[:\-]?\s*[A-Z0-9]{5,}/gi)];
    for (const m of taxIdMatches) {
        const maybeName = String(m?.[1] || '')
            .replace(/^(?:cliente|titular|raz[oó]n\s+social|comercializadora|distribuidora)\s*[:\-]?\s*/i, '')
            .trim()
            .replace(/\s+/g, ' ');
        if (!isInvalidClientNameCandidate(maybeName) && !/comercializadora|distribuidora|energ[ií]a/i.test(maybeName)) {
            return maybeName.toUpperCase();
        }
    }

    const patterns = [
        /(?:cliente|titular|raz[oó]n\s+social|nombre\s+del\s+titular)\s*[:\-]?\s*([a-z0-9áéíóúüñ\s\.,\-]{3,120})/i,
        /(?:datos\s+del\s+cliente)\s*[:\-]?\s*([a-z0-9áéíóúüñ\s\.,\-]{3,120})/i
    ];

    for (const re of patterns) {
        const m = raw.match(re);
        if (!m) continue;
        const name = String(m[1] || '').trim().replace(/\s+/g, ' ');
        if (!isInvalidClientNameCandidate(name) && !/comercializadora|distribuidora|energ[ií]a/i.test(name)) {
            return name.toUpperCase();
        }
    }

    return 'Desconocido';
}

function resolveClientName(candidateName, comercializadora, text) {
    const candidate = String(candidateName || '').trim();
    const comm = String(comercializadora || '').trim();
    const candNorm = normalizeNameToken(candidate);
    const commNorm = normalizeNameToken(comm);

    const missing = !candNorm || candNorm === 'desconocido' || candNorm === 'n d' || isInvalidClientNameCandidate(candidate);
    const sameAsCommercializer = candNorm && commNorm && candNorm === commNorm;

    if (missing || sameAsCommercializer) {
        const detected = detectClientNameFromText(text);
        const detectedNorm = normalizeNameToken(detected);
        const detectedIsCommercializer = detectedNorm && commNorm && detectedNorm === commNorm;
        if (detected && detected !== 'Desconocido' && !detectedIsCommercializer) return detected;

        // Si no encontramos una alternativa fiable, NO conservar la comercializadora como cliente.
        if (sameAsCommercializer) return 'Desconocido';
    }

    return !isInvalidClientNameCandidate(candidate) ? candidate : 'Desconocido';
}

function resolveClientNameFromHistory(cups, comercializadora) {
    const cupsKey = String(cups || '').trim().toUpperCase();
    if (!cupsKey) return '';
    const commNorm = normalizeNameToken(comercializadora || '');
    const all = [...invoices, ...dbInvoices];

    for (const inv of all) {
        const invCups = String(inv?.cups || '').trim().toUpperCase();
        if (!invCups || invCups !== cupsKey) continue;

        const name = String(inv?.clientName || '').trim();
        const nameNorm = normalizeNameToken(name);
        if (!nameNorm || isInvalidClientNameCandidate(name)) continue;
        if (commNorm && nameNorm === commNorm) continue;
        return name;
    }

    return '';
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

async function renderPdfFileFirstPage(file, container) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1.25 });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: context, viewport }).promise;
    container.innerHTML = `
        <div style="display:flex; flex-direction:column; align-items:center;">
            <div style="font-size:0.85rem; color:#64748b; margin-bottom:0.25rem;">Pagina 1/${pdf.numPages}</div>
            ${canvas.outerHTML}
        </div>
    `;
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

function buildSupplyKey(inv) {
    return [
        normalizeClientKey(inv?.clientName || ''),
        String(inv?.cups || '').trim().toUpperCase(),
        String(inv?.tariffType || '').trim(),
        String(inv?.supplyAddress || '').trim().toLowerCase()
    ].join('|');
}

function loadSupplyProposals() {
    try {
        supplyProposals = JSON.parse(localStorage.getItem('audit_pro_supply_proposals') || '{}');
    } catch {
        supplyProposals = {};
    }
}

function saveSupplyProposals() {
    localStorage.setItem('audit_pro_supply_proposals', JSON.stringify(supplyProposals));
    cloudSaveAppState('supplyProposals', supplyProposals);
}

function loadProposalsLog() {
    try {
        proposalsLog = JSON.parse(localStorage.getItem('audit_pro_proposals_log') || '[]');
        if (!Array.isArray(proposalsLog)) proposalsLog = [];
    } catch {
        proposalsLog = [];
    }
}

function saveProposalsLog() {
    localStorage.setItem('audit_pro_proposals_log', JSON.stringify(proposalsLog));
    cloudSaveAppState('proposalsLog', proposalsLog);
}

function getProposalStatusOptions() {
    return ['propuesta', 'enviada', 'aceptada', 'rechazada', 'implantada', 'caducada'];
}

function getSupplyProposal(inv) {
    return supplyProposals[buildSupplyKey(inv)] || null;
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

function extractSectionByPattern(text, startRegex, endRegex = null, maxLength = 2200) {
    const raw = String(text || '');
    const startMatch = raw.match(startRegex);
    if (!startMatch || startMatch.index === undefined) return '';

    const startIndex = startMatch.index;
    const tail = raw.slice(startIndex, startIndex + maxLength);
    if (!endRegex) return tail;

    const endMatch = tail.slice(startMatch[0].length).match(endRegex);
    if (!endMatch || endMatch.index === undefined) return tail;

    return tail.slice(0, startMatch[0].length + endMatch.index);
}

function extractEnergyBlockText(text) {
    return extractSectionByPattern(
        text,
        /facturaci[oó]n\s+por\s+energ[ií]a\s+consumida|importe\s+por\s+energ[ií]a\s+consumida/i,
        /coste\s+de\s+peajes|alquiler|otros\s+conceptos|impuesto\s+de\s+electricidad|total\s+factura|informaci[oó]n\s+adicional/i,
        1800
    );
}

function extractTollBlockText(text) {
    return extractSectionByPattern(
        text,
        /coste\s+de\s+peajes\s+de\s+transporte\s*,?\s*distribuci[oó]n\s+y\s+cargos?|peajes\s+de\s+transporte|peajes\s+y\s+cargos/i,
        /alquiler|otros\s+conceptos|impuesto\s+de\s+electricidad|total\s+factura|informaci[oó]n\s+adicional/i,
        1800
    );
}

async function requestOpenAIJson(prompt) {
    const response = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ engine: 'openai', prompt })
    });

    if (!response.ok) throw new Error('La pasarela IA de Vercel no ha respondido.');

    const data = await response.json();
    let content = data.choices ? data.choices[0].message.content : data;
    const raw = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const parsed = typeof content === 'string'
        ? JSON.parse(content.replace(/```json\n?|```/g, '').trim())
        : content;

    return { parsed, raw };
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

function areDuplicatedEnergyAndTolls(energyItems = [], tollItems = []) {
    const energy = (energyItems || []).filter(item => Number(item.period) >= 1 && Number(item.unitPriceKwh || 0) > 0);
    const tolls = (tollItems || []).filter(item => Number(item.period) >= 1 && Number(item.unitPriceKwh || 0) > 0);
    if (energy.length === 0 || tolls.length === 0) return false;

    let compared = 0;
    let duplicated = 0;
    energy.forEach(item => {
        const toll = tolls.find(t => Number(t.period) === Number(item.period));
        if (!toll) return;
        compared += 1;
        const energyPrice = Number(item.unitPriceKwh || 0);
        const tollPrice = Number(toll.unitPriceKwh || 0);
        if (Math.abs(energyPrice - tollPrice) <= 0.000001) duplicated += 1;
    });

    return compared > 0 && duplicated === compared;
}

function calculateEnergyWithTollsTotal(energyItems = [], tollItems = []) {
    const energy = (energyItems || []).filter(item => Number(item.period) >= 1 && Number(item.kwh || 0) > 0);
    return energy.reduce((sum, item) => {
        const energyAmount = Number(item.kwh || 0) * Number(item.unitPriceKwh || 0);
        const toll = (tollItems || []).find(t => Number(t.period) === Number(item.period));
        const tollAmount = Number(item.kwh || 0) * Number(toll?.unitPriceKwh || 0);
        return sum + energyAmount + tollAmount;
    }, 0);
}

function calculateCommodityEnergyTotal(energyItems = []) {
    return (energyItems || [])
        .filter(item => Number(item.period) >= 1 && Number(item.kwh || 0) > 0)
        .reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
}

function reconcileEnergyCostReference(inv) {
    const energyItems = inv.energyPeriodItems || [];
    const tollItems = inv.tollPeriodItems || [];
    const rawEnergyCost = Number(inv.energyCost || 0);
    if (!energyItems.length || rawEnergyCost <= 0) return;

    const commodityTotal = calculateCommodityEnergyTotal(energyItems);
    const energyWithTollsTotal = calculateEnergyWithTollsTotal(energyItems, tollItems);
    const tollsTotal = Math.max(0, energyWithTollsTotal - commodityTotal);

    const diffToCommodity = Math.abs(rawEnergyCost - commodityTotal);
    const diffToFullEnergy = Math.abs(rawEnergyCost - energyWithTollsTotal);

    // Caso detectado en varias facturas: la IA separa bien tollPeriodItems, pero energyCost
    // se queda con solo la energía comercializada y no con el término variable completo.
    if (tollsTotal > 0.5 && diffToCommodity <= 0.75 && diffToFullEnergy > 0.75) {
        inv._energyCostOriginalAI = rawEnergyCost;
        inv.energyCost = Number(energyWithTollsTotal.toFixed(2));
        inv._energyCostSource = 'reconciled-from-period-detail';
        console.log('[EnergyCost] Reconciliado desde detalle por periodos', {
            original: rawEnergyCost,
            commodityTotal,
            tollsTotal,
            reconciled: inv.energyCost
        });
    } else {
        inv._energyCostSource = inv._energyCostSource || 'openai';
    }
}

function buildResidualTollPeriodItems(inv) {
    const energyItems = (inv.energyPeriodItems || []).filter(item => Number(item.period) >= 1 && Number(item.kwh || 0) > 0);
    const energyRef = Number(inv.energyCost || inv.breakdown?.energyCost || 0);
    if (!energyItems.length || energyRef <= 0) return [];

    const commodityTotal = calculateCommodityEnergyTotal(energyItems);
    const residualTotal = energyRef - commodityTotal;
    const totalKwh = energyItems.reduce((sum, item) => sum + Number(item.kwh || 0), 0);

    if (residualTotal <= 0 || totalKwh <= 0) return [];

    const unitPriceKwh = residualTotal / totalKwh;
    // Si el precio residual es irreal (<0.002 €/kWh ~0.2 ct) los precios de energía de OpenAI
    // ya incluían los peajes → no usar residual, devolver vacío
    if (unitPriceKwh < 0.002) return [];

    return energyItems.map(item => ({
        period: Number(item.period),
        kwh: Number(item.kwh || 0),
        unitPriceKwh
    }));
}

function shouldPreferRegexTolls(inv, regexTolls = []) {
    if (!regexTolls.length) return false;

    const energyItems = inv.energyPeriodItems || [];
    const currentTolls = inv.tollPeriodItems || [];
    if (!energyItems.length || !currentTolls.length) return false;

    if (areDuplicatedEnergyAndTolls(energyItems, currentTolls)) return true;

    const energyRef = Number(inv.energyCost || inv.breakdown?.energyCost || 0);
    if (energyRef <= 0) return false;

    const currentTotal = calculateEnergyWithTollsTotal(energyItems, currentTolls);
    const regexTotal = calculateEnergyWithTollsTotal(energyItems, regexTolls);
    const currentDiff = Math.abs(currentTotal - energyRef);
    const regexDiff = Math.abs(regexTotal - energyRef);

    const currentBlowsUpEnergy = currentTotal > (energyRef + 0.5);
    const regexIsClearlyBetter = regexDiff + 0.5 < currentDiff;

    return currentBlowsUpEnergy && regexIsClearlyBetter;
}

function shouldUseResidualTolls(inv, residualTolls = []) {
    if (!residualTolls.length) return false;

    const energyItems = inv.energyPeriodItems || [];
    const currentTolls = inv.tollPeriodItems || [];
    const energyRef = Number(inv.energyCost || inv.breakdown?.energyCost || 0);
    if (!energyItems.length || !currentTolls.length || energyRef <= 0) return false;

    const currentTotal = calculateEnergyWithTollsTotal(energyItems, currentTolls);
    const residualTotal = calculateEnergyWithTollsTotal(energyItems, residualTolls);
    const currentDiff = Math.abs(currentTotal - energyRef);
    const residualDiff = Math.abs(residualTotal - energyRef);

    return currentTotal > (energyRef + 0.5) && residualDiff + 0.5 < currentDiff;
}

function shouldBackfillResidualTolls(inv, residualTolls = []) {
    if (!residualTolls.length) return false;

    const energyItems = inv.energyPeriodItems || [];
    const currentTolls = inv.tollPeriodItems || [];
    const energyRef = Number(inv.energyCost || inv.breakdown?.energyCost || 0);
    if (!energyItems.length || energyRef <= 0) return false;

    const currentTotal = calculateEnergyWithTollsTotal(energyItems, currentTolls);
    const residualTotal = calculateEnergyWithTollsTotal(energyItems, residualTolls);
    const currentDiff = Math.abs(currentTotal - energyRef);
    const residualDiff = Math.abs(residualTotal - energyRef);

    // Caso simétrico al inflado: si el detalle de energía queda corto porque faltan
    // peajes/cargos, usar el residual cuando mejore claramente el cuadre.
    return currentTotal < (energyRef - 0.5) && residualDiff + 0.5 < currentDiff;
}

function sanitizeInvoiceForStorage(inv) {
    if (!inv || typeof inv !== 'object') return inv;
    const clone = { ...inv };
    clone.fileName = String(clone.fileName || clone.invoiceNum || 'factura.pdf').trim();
    delete clone.invoicePreviewPages;
    delete clone.invoicePreview;
    delete clone.invoicePreviewTotalPages;
    delete clone.invoicePreviewRenderedPages;
    return clone;
}

function sanitizeInvoiceForCloud(inv) {
    const s = sanitizeInvoiceForStorage(inv);
    // Eliminar campos voluminosos o de diagnóstico que no aportan valor en cloud
    delete s._rawOpenAIJSON;
    delete s._impliedTollsFromEnergy;
    delete s._tollOpenAIItems;
    delete s._tollRegexItems;
    delete s._tollResidualItems;
    return s;
}

// ========================================================================
// 5. MOTOR DE PROCESAMIENTO DE ARCHIVOS (AUDITORÍA IA CON OPENAI)
// ========================================================================
async function processFiles(files) {
    const selectedFiles = Array.from(files || []).filter(Boolean);
    if (selectedFiles.length === 0) return;

    const nonPdfCount = selectedFiles.filter(file => !String(file.name || '').toLowerCase().endsWith('.pdf')).length;
    const oversized = selectedFiles.filter(file => (Number(file.size || 0) / (1024 * 1024)) > MAX_PDF_SIZE_MB);
    const validPdfFiles = selectedFiles.filter(file =>
        String(file.name || '').toLowerCase().endsWith('.pdf') &&
        (Number(file.size || 0) / (1024 * 1024)) <= MAX_PDF_SIZE_MB
    );

    if (validPdfFiles.length === 0) {
        alert(`No hay facturas PDF validas para procesar. Tamano maximo por archivo: ${MAX_PDF_SIZE_MB} MB.`);
        return;
    }

    const filesToProcess = validPdfFiles.slice(0, MAX_BATCH_INVOICES);
    const skippedByBatchLimit = Math.max(0, validPdfFiles.length - filesToProcess.length);

    const loading = document.getElementById('loading');
    if (loading) loading.classList.remove('hidden');

    let rejectedByMissingTolls = 0;
    const duplicateNotices = [];

    for (const file of filesToProcess) {
        try {
            const fileNameToken = normalizePdfToken(file.name || '');
            const existingByName = [...invoices, ...dbInvoices].some(inv => normalizePdfToken(inv?.fileName || '') === fileNameToken);
            if (existingByName) {
                duplicateNotices.push(file.name || 'factura.pdf');
                console.warn('[Dup] Factura duplicada por nombre, se omite carga:', file.name);
                continue;
            }

            console.log(`[Auditor] Analizando documento: ${file.name}`);
            cachePendingPdf({ fileName: file.name }, file);
            
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
            auditData.fileName = String(auditData.fileName || file.name || auditData.invoiceNum || 'factura.pdf').trim();

            // Detección estricta de duplicado por claves de factura (invoiceNum + cups + periodo / fileName)
            const existingByRecord = [...invoices, ...dbInvoices].some(inv => isSameInvoiceRecord(inv, auditData));
            if (existingByRecord) {
                duplicateNotices.push(auditData.invoiceNum || auditData.fileName || file.name);
                console.warn('[Dup] Factura duplicada por claves de factura, se omite carga:', auditData.invoiceNum || auditData.fileName || file.name);
                continue;
            }

            auditData.invoicePreviewPages = invoicePreviewPages;
            auditData.invoicePreview = invoicePreviewPages[0] || null;
            auditData.invoicePreviewTotalPages = Number(pdf.numPages || 0);
            auditData.invoicePreviewRenderedPages = invoicePreviewPages.length;
            cachePendingPdf(auditData, file);
            await saveInvoicePdfToStore(auditData, file);
            invoices.push(auditData);

            // Siempre guardar en historial local (incluidas rechazadas)
            saveToDatabase([auditData]);

            // Solo sincronizar cloud si cumple la regla de peajes obligatorios
            if (hasMandatoryTolls) {
                await cloudSync(auditData);
                        await cloudSyncPdf(auditData, file);
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

    if (duplicateNotices.length > 0) {
        const uniqueDup = [...new Set(duplicateNotices)];
        alert(`Se detectaron ${uniqueDup.length} factura(s) ya cargadas y NO se volvieron a cargar:\n- ${uniqueDup.join('\n- ')}`);
    }

    const skippedBySize = oversized.length;
    if (nonPdfCount > 0 || skippedBySize > 0 || skippedByBatchLimit > 0) {
        alert(
            `Carga masiva finalizada. Procesadas: ${filesToProcess.length}. ` +
            `Ignoradas no PDF: ${nonPdfCount}. ` +
            `Ignoradas por tamano (>${MAX_PDF_SIZE_MB} MB): ${skippedBySize}. ` +
            `Ignoradas por limite de lote (${MAX_BATCH_INVOICES}): ${skippedByBatchLimit}.`
        );
    }

    if (loading) loading.classList.add('hidden');
}

async function runExtractionIA(text, fileName) {
    try {
        const energyBlockText = extractEnergyBlockText(text);
        const tollBlockText = extractTollBlockText(text);

        const { parsed: initialParsed, raw: rawOpenAIContent } = await requestOpenAIJson(
            `Actúa como auditor energético experto en facturas españolas. Devuelve exclusivamente JSON válido.
                Extrae estos campos:
                invoiceNum, cups, period, clientName, supplyAddress, powerCost, energyCost, othersCost, alquiler, reactiveCost,
                comercializadora, tariffType (2.0, 3.0 o 6.1), electricityTax, igicTax, ivaTax, total,
                consumptionItems (array de 6 números P1..P6),
                energyPeriodItems (array [{period,kwh,unitPriceKwh}]),
                powerPeriodItems (array [{period,kw,unitPriceKw,days}]) donde days son los dias del periodo de facturacion,
                tollPeriodItems (array [{period,kwh,unitPriceKwh}]),
                energySourceLabel, tollSourceLabel.

                Reglas obligatorias de separación:
                1. energyPeriodItems debe contener SOLO energía comercializada del bloque "importe por energía consumida" o equivalente comercializador.
                2. tollPeriodItems debe contener SOLO peajes y cargos de energía del bloque "coste de peajes de transporte, distribución y cargos" o equivalente.
                3. Nunca mezcles peajes/cargos dentro de energyPeriodItems.
                4. Nunca repitas un mismo periodo en energyPeriodItems con dos precios distintos. Si ves dos líneas P1/P2/P3 y una pertenece a peajes/cargos, esa debe ir a tollPeriodItems.
                5. Si la factura muestra bajo "facturación por energía consumida (término variable)" dos subbloques separados, usa:
                   - "importe por energía consumida" => energyPeriodItems
                   - "coste de peajes de transporte, distribución y cargos" => tollPeriodItems
                6. Si no encuentras peajes/cargos por periodo, devuelve tollPeriodItems: [].
                7. energyCost debe ser el TOTAL del término variable de energía de la factura: energía comercializada + peajes/cargos de energía. No devuelvas en energyCost solo la parte de energía comercializada.

                Ejemplo correcto:
                - energyPeriodItems: [{"period":"P1","kwh":138.01,"unitPriceKwh":0.230000}]
                - tollPeriodItems: [{"period":"P1","kwh":138.01,"unitPriceKwh":0.097553}]

                Si en la factura aparecen literalmente las palabras "peajes" o "cargos", debes localizar ese bloque y usarlo para tollPeriodItems.
                tollSourceLabel debe devolver el encabezado exacto o casi exacto del bloque usado para peajes/cargos.
                energySourceLabel debe devolver el encabezado exacto o casi exacto del bloque usado para energía comercializada.

                Bloque de energía detectado localmente:
                ${energyBlockText || 'NO DETECTADO'}

                Bloque de peajes/cargos detectado localmente:
                ${tollBlockText || 'NO DETECTADO'}

                No incluyas explicaciones, texto adicional ni markdown. Solo JSON.
                Texto completo: ${text.substring(0, 12000)}`
        );

        let inv = initialParsed;
        inv._rawOpenAIJSON = rawOpenAIContent;
        inv.energySourceLabel = inv.energySourceLabel || '';
        inv.tollSourceLabel = inv.tollSourceLabel || '';

        // Completar campos adicionales del JSON IA
        inv.invoiceNum = inv.invoiceNum || inv.factura || inv.invoice || 'S/N';
        inv.clientName = inv.clientName || inv.customerName || inv.cliente || 'Desconocido';
        inv.comercializadora = inv.comercializadora || inv.provider || inv.vendedor || inv.company || inv.distribuidora || inv.operador || detectComercializadoraFromText(text);
        inv.tariffType = normalizeTariffTypeValue(inv.tariffType || inv.tarifa || inv.tariff || inv.tipoTarifa || detectTariffTypeFromText(text));
        inv.supplyAddress = inv.supplyAddress || inv.address || inv.direccion || 'N/D';
        inv.cups = inv.cups || inv.CUPS || 'N/D';
        inv.period = inv.period || inv.periodo || 'N/D';
        inv.clientName = resolveClientName(inv.clientName, inv.comercializadora, text);
        const clientNorm = normalizeNameToken(inv.clientName);
        const commNorm = normalizeNameToken(inv.comercializadora);
        if (!clientNorm || clientNorm === 'desconocido' || clientNorm === commNorm) {
            const historicalClient = resolveClientNameFromHistory(inv.cups, inv.comercializadora);
            if (historicalClient) {
                inv.clientName = historicalClient;
                inv._clientNameSource = 'history-by-cups';
            }
        }

        // Si el modelo da items por periodo guardarlos
        inv.energyPeriodItems = assignSequentialPeriodsIfNeeded((inv.energyPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kwh: firstPositiveNumber(item.kwh, item.consumption, item.consumo),
            unitPriceKwh: firstPositiveNumber(item.unitPriceKwh, item.unitPrice, item.priceKwh, item.price, item.precio)
        })), inv.tariffType).filter(item => item.period >= 1 && item.period <= 6);

        inv.powerPeriodItems = assignSequentialPeriodsIfNeeded((inv.powerPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kw: firstPositiveNumber(item.kw, item.powerKw, item.potencia),
            unitPriceKw: firstPositiveNumber(item.unitPriceKw, item.unitPrice, item.priceKw, item.price, item.precio),
            days: item.days || item.dias || item.numDays || null
        })), inv.tariffType).filter(item => item.period >= 1 && item.period <= 6);

        let tollFromIA = assignSequentialPeriodsIfNeeded((inv.tollPeriodItems || inv.tollsPeriodItems || inv.peajesPeriodItems || []).map(item => ({
            period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
            kwh: firstPositiveNumber(item.kwh, item.consumption, item.consumo),
            unitPriceKwh: firstPositiveNumber(item.unitPriceKwh, item.unitPrice, item.priceKwh, item.price, item.peajePrice, item.precioPeaje, item.precio)
        })), inv.tariffType).filter(item => item.period >= 1 && item.period <= 6);

        if (tollFromIA.length === 0 && tollBlockText && /peajes|cargos/i.test(tollBlockText)) {
            try {
                const { parsed: tollRetryParsed, raw: tollRetryRaw } = await requestOpenAIJson(
                    `Extrae exclusivamente JSON válido con estos campos: tollPeriodItems, tollSourceLabel.
                    Debes buscar SOLO en este bloque de la factura, que corresponde a peajes y cargos de energía.
                    Si aparecen líneas P1..P6 con kWh y €/kWh, devuélvelas en tollPeriodItems.
                    No confundas este bloque con energía comercializada.
                    tollSourceLabel debe devolver el encabezado exacto o casi exacto del bloque.
                    Bloque de peajes/cargos:
                    ${tollBlockText}`
                );
                const focusedTolls = assignSequentialPeriodsIfNeeded((tollRetryParsed.tollPeriodItems || []).map(item => ({
                    period: parsePeriodValue(item.period ?? item.periodo ?? item.p),
                    kwh: firstPositiveNumber(item.kwh, item.consumption, item.consumo),
                    unitPriceKwh: firstPositiveNumber(item.unitPriceKwh, item.unitPrice, item.priceKwh, item.price, item.peajePrice, item.precioPeaje, item.precio)
                })), inv.tariffType).filter(item => item.period >= 1 && item.period <= 6);
                if (focusedTolls.length > 0) {
                    tollFromIA = focusedTolls;
                    inv.tollSourceLabel = tollRetryParsed.tollSourceLabel || inv.tollSourceLabel || '';
                    inv._rawOpenAIJSON += `\n\n/* toll retry */\n${tollRetryRaw}`;
                }
            } catch (retryError) {
                console.warn('[OpenAI] Reintento focalizado de peajes/cargos falló:', retryError);
            }
        }

        if (inv.energyPeriodItems.length === 0) {
            inv.energyPeriodItems = extractEnergyPeriodItems(text);
            inv._energyPeriodsSource = inv.energyPeriodItems.length > 0 ? 'regex' : 'none';
        } else {
            inv._energyPeriodsSource = 'openai';
        }

        // Deduplicar energyPeriodItems: OpenAI a veces incluye las filas de peajes
        // dentro del array de energía (mismo periodo, precio menor = peaje).
        // Conservamos el precio más alto por periodo como commodity y guardamos
        // el más bajo como candidato implícito de peaje.
        {
            const _emap = {};
            const _tmap = {};
            inv.energyPeriodItems.forEach(item => {
                const p = Number(item.period);
                const price = Number(item.unitPriceKwh || 0);
                if (!_emap[p] || price > Number(_emap[p].unitPriceKwh || 0)) {
                    if (_emap[p]) {
                        const old = _emap[p];
                        if (!_tmap[p] || Number(old.unitPriceKwh) < Number(_tmap[p].unitPriceKwh)) {
                            _tmap[p] = old;
                        }
                    }
                    _emap[p] = item;
                } else if (price > 0) {
                    if (!_tmap[p] || price < Number(_tmap[p].unitPriceKwh)) {
                        _tmap[p] = item;
                    }
                }
            });
            inv.energyPeriodItems = Object.values(_emap).sort((a, b) => Number(a.period) - Number(b.period));
            inv._impliedTollsFromEnergy = Object.values(_tmap).filter(t => Number(t.unitPriceKwh || 0) > 0);
        }

        if (inv.powerPeriodItems.length === 0) {
            inv.powerPeriodItems = extractPowerPeriodItems(text);
            inv._powerPeriodsSource = inv.powerPeriodItems.length > 0 ? 'regex' : 'none';
        } else {
            inv._powerPeriodsSource = 'openai';
        }

        const regexTolls = extractTollPeriodItems(text);
        const residualTolls = buildResidualTollPeriodItems(inv);

        if (tollFromIA.length > 0) {
            inv.tollPeriodItems = tollFromIA;
            inv._tollPeriodsSource = 'openai';

            if (shouldPreferRegexTolls(inv, regexTolls)) {
                inv.tollPeriodItems = regexTolls;
                inv._tollPeriodsSource = 'regex-fallback-suspicious-openai';
            } else if (shouldUseResidualTolls(inv, residualTolls)) {
                inv.tollPeriodItems = residualTolls;
                inv._tollPeriodsSource = 'residual-fallback-energy-total';
            } else if (shouldBackfillResidualTolls(inv, residualTolls)) {
                inv.tollPeriodItems = residualTolls;
                inv._tollPeriodsSource = 'residual-backfill-missing-tolls';
            }
        } else {
            inv.tollPeriodItems = regexTolls;
            inv._tollPeriodsSource = inv.tollPeriodItems.length > 0 ? 'regex' : 'none';

            // Si regex vacío y tenemos peajes inferidos de duplicados en energyPeriodItems, usarlos
            if (inv.tollPeriodItems.length === 0 && (inv._impliedTollsFromEnergy || []).length > 0) {
                inv.tollPeriodItems = inv._impliedTollsFromEnergy;
                inv._tollPeriodsSource = 'implied-from-energy-dedup';
            }

            const useResidualByMissing = shouldBackfillResidualTolls(inv, residualTolls);
            if ((inv.tollPeriodItems.length === 0 || shouldUseResidualTolls(inv, residualTolls) || useResidualByMissing) && residualTolls.length > 0) {
                inv.tollPeriodItems = residualTolls;
                inv._tollPeriodsSource = useResidualByMissing ? 'residual-backfill-missing-tolls' : 'residual-fallback-energy-total';
            }
        }

        normalizeEnergyAndTolls(inv);
        reconcileEnergyCostReference(inv);

        console.log('[Debug] Toll extraction', {
            source: inv._tollPeriodsSource,
            tollFromIA,
            impliedTolls: inv._impliedTollsFromEnergy,
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
    const sanitizedRecords = (invoiceRecords || []).map(sanitizeInvoiceForStorage);
    let updated = 0;
    let inserted = 0;

    sanitizedRecords.forEach(record => {
        const result = upsertInvoiceInList(dbInvoices, record, true);
        if (result.updated) updated += 1;
        else inserted += 1;
    });

    try {
        localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
    } catch (err) {
        console.warn('Error guardando en localStorage (continuando en memoria):', err);
    }

    // Refrescar UI siempre, incluso si localStorage falla
    renderHistory();
    renderClients();

    return { updated, inserted };
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

async function cloudSync(invoice) {
    if (!supabaseClient) return;
    try {
        const clean = sanitizeInvoiceForCloud(invoice);
        const fileName = String(clean.fileName || clean.invoiceNum || 'S/N');
        const { error } = await supabaseClient.from('invoices').upsert([{
            file_name: fileName,
            invoice_num: String(clean.invoiceNum || 'S/N'),
            cups: String(clean.cups || ''),
            period: String(clean.period || ''),
            client_name: String(clean.clientName || ''),
            data: clean
        }], { onConflict: 'file_name' });
        if (error) throw error;

        // Guardar tambien ficha maestra de suministro (CUPS) cuando exista tabla supplies.
        await cloudUpsertSupply(clean);

        console.log("[Cloud] Sincronizado:", fileName);
    } catch (e) {
        console.warn("[Cloud] Error sync:", e.message);
    }
}

async function cloudUpsertSupply(invoice) {
    if (!supabaseClient) return;

    const cups = String(invoice?.cups || '').trim();
    if (!cups || cups === 'N/D') return;

    try {
        const payload = {
            cups,
            client_name: String(invoice?.clientName || '').trim() || 'Desconocido',
            supply_address: String(invoice?.supplyAddress || '').trim(),
            tariff_type: normalizeTariffTypeValue(invoice?.tariffType || 'N/D'),
            current_commercializer: String(invoice?.comercializadora || '').trim(),
            last_invoice_num: String(invoice?.invoiceNum || '').trim(),
            last_period: String(invoice?.period || '').trim(),
            updated_at: new Date().toISOString()
        };

        const { error } = await supabaseClient
            .from('supplies')
            .upsert([payload], { onConflict: 'cups' });

        // Si la tabla no existe todavía, no romper el flujo de facturas.
        if (error) throw error;
    } catch (err) {
        console.warn('[Cloud] No se pudo sincronizar supply por CUPS (tabla supplies pendiente o sin policy):', err?.message || err);
    }
}

async function cloudLoadInvoices() {
    if (!supabaseClient) return;
    try {
        const { data, error } = await supabaseClient
            .from('invoices')
            .select('file_name,data')
            .order('created_at', { ascending: false });
        if (error) throw error;
        if (data && data.length > 0) {
            const cloudInvoices = data
                .map(row => {
                    const payload = row.data || {};
                    if (!payload.fileName && row.file_name) payload.fileName = row.file_name;
                    return payload;
                })
                .filter(Boolean)
                .map(sanitizeInvoiceForStorage);
            const existingKeys = new Set(dbInvoices.map(i => String(i.fileName || i.invoiceNum || '')));
            const newFromCloud = cloudInvoices.filter(i => !existingKeys.has(String(i.fileName || i.invoiceNum || '')));
            if (newFromCloud.length > 0) {
                dbInvoices = [...dbInvoices, ...newFromCloud];
                localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
                renderHistory();
                renderClients();
            }
            console.log("[Cloud] Cargados:", cloudInvoices.length, "registros,", newFromCloud.length, "nuevos");
        }
    } catch (e) {
        console.warn("[Cloud] Error load:", e.message);
    }
}

async function cloudSaveAppState(key, value) {
    if (!supabaseClient) return { ok: false, skipped: true, message: 'Sin cliente Supabase' };
    try {
        const { error } = await supabaseClient
            .from('app_settings')
            .upsert([
                {
                    key,
                    value,
                    updated_at: new Date().toISOString()
                }
            ], { onConflict: 'key' });
        if (error) throw error;
        return { ok: true, skipped: false, message: 'OK' };
    } catch (err) {
        console.warn(`[CloudState] No se pudo guardar ${key} en cloud:`, err?.message || err);
        return { ok: false, skipped: false, message: String(err?.message || err || 'Error desconocido') };
    }
}

async function cloudLoadAppState() {
    if (!supabaseClient) return;
    try {
        const keys = ['commercializers', 'supplyProposals', 'proposalsLog'];
        const { data, error } = await supabaseClient
            .from('app_settings')
            .select('key,value')
            .in('key', keys);
        if (error) throw error;

        const byKey = new Map((data || []).map(row => [String(row.key || ''), row.value]));

        const cloudCommercializers = byKey.get('commercializers');
        if (Array.isArray(cloudCommercializers)) {
            commercializers = cloudCommercializers;
            localStorage.setItem('audit_pro_commercializers', JSON.stringify(commercializers));
            renderCommercializersList();
            console.log('[CloudState] Comercializadoras cargadas desde cloud:', commercializers.length);
        }

        const cloudSupplyProposals = byKey.get('supplyProposals');
        if (cloudSupplyProposals && typeof cloudSupplyProposals === 'object' && !Array.isArray(cloudSupplyProposals)) {
            supplyProposals = cloudSupplyProposals;
            localStorage.setItem('audit_pro_supply_proposals', JSON.stringify(supplyProposals));
            console.log('[CloudState] Propuestas por suministro cargadas desde cloud:', Object.keys(supplyProposals).length);
        }

        const cloudProposalsLog = byKey.get('proposalsLog');
        if (Array.isArray(cloudProposalsLog)) {
            proposalsLog = cloudProposalsLog;
            localStorage.setItem('audit_pro_proposals_log', JSON.stringify(proposalsLog));
            console.log('[CloudState] Log de propuestas cargado desde cloud:', proposalsLog.length);
        }
    } catch (err) {
        console.warn('[CloudState] No se pudo cargar estado funcional desde cloud:', err?.message || err);
    }
}

function buildPdfCloudNameCandidates(inv = {}, file = null) {
    const names = [];
    const fileName = String(file?.name || inv.fileName || '').trim();
    const invoiceNum = String(inv.invoiceNum || '').trim();

    if (fileName) names.push(fileName);
    if (invoiceNum) {
        names.push(invoiceNum);
        names.push(`${invoiceNum}.pdf`);
        names.push(`${invoiceNum}.PDF`);
    }

    return [...new Set(names.filter(Boolean))];
}

function normalizePdfNameToken(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\.pdf$/i, '')
        .replace(/[^a-z0-9]/g, '');
}

function pickBestCloudPdfName(fileEntries = [], inv = {}, candidateNames = []) {
    const invNumNorm = normalizePdfNameToken(inv.invoiceNum || '');
    const fileNorm = normalizePdfNameToken(inv.fileName || '');
    const cupsNorm = normalizePdfNameToken(inv.cups || '');
    const candidateNorms = new Set((candidateNames || []).map(normalizePdfNameToken).filter(Boolean));

    let best = null;
    let bestScore = -1;

    (fileEntries || []).forEach(entry => {
        const name = String(entry?.name || '').trim();
        if (!name) return;
        const n = normalizePdfNameToken(name);
        if (!n) return;

        let score = 0;
        if (candidateNorms.has(n)) score += 100;
        if (invNumNorm && n.includes(invNumNorm)) score += 40;
        if (fileNorm && n.includes(fileNorm)) score += 25;
        if (cupsNorm && cupsNorm.length >= 6 && n.includes(cupsNorm.slice(-6))) score += 10;

        if (score > bestScore) {
            bestScore = score;
            best = name;
        }
    });

    return bestScore > 0 ? best : '';
}

async function cloudSyncPdf(inv, file) {
    if (!supabaseClient || !file) return;
    const fileNames = buildPdfCloudNameCandidates(inv, file);
    let lastError = null;
    let uploadedAny = false;

    for (const bucket of PDF_BUCKET_CANDIDATES) {
        for (const fileName of fileNames) {
            try {
                const { error } = await supabaseClient.storage
                    .from(bucket)
                    .upload(fileName, file, { upsert: true, contentType: 'application/pdf' });
                if (error) throw error;
                console.log("[CloudPDF] Subido:", fileName, "bucket:", bucket);
                uploadedAny = true;
            } catch (e) {
                lastError = e;
                console.warn("[CloudPDF] Error upload bucket", bucket + ":", e.message);
            }
        }
    }

    if (uploadedAny) return;

    console.warn("[CloudPDF] Upload fallido en todos los buckets para", fileNames, lastError?.message || 'sin detalle');
}

async function cloudLoadPdf(inv) {
    if (!supabaseClient) return null;
    const fileNames = buildPdfCloudNameCandidates(inv);
    let lastError = null;

    for (const bucket of PDF_BUCKET_CANDIDATES) {
        for (const fileName of fileNames) {
            try {
                const { data, error } = await supabaseClient.storage
                    .from(bucket)
                    .download(fileName);
                if (error) throw error;
                if (data) {
                    const file = new File([data], fileName, { type: 'application/pdf' });
                    cachePendingPdf(inv, file);
                    console.log("[CloudPDF] Descargado:", fileName, "bucket:", bucket);
                    return file;
                }
            } catch (e) {
                lastError = e;
                console.warn("[CloudPDF] Error download bucket", bucket + ":", e.message);
            }
        }
    }

    // Fallback: buscar un nombre similar en el bucket (facturas antiguas o guardadas con otro alias)
    for (const bucket of PDF_BUCKET_CANDIDATES) {
        try {
            const { data: files, error: listError } = await supabaseClient.storage
                .from(bucket)
                .list('', { limit: 200, offset: 0, sortBy: { column: 'name', order: 'asc' } });
            if (listError) throw listError;

            const bestName = pickBestCloudPdfName(files || [], inv, fileNames);
            if (!bestName) continue;

            const { data, error } = await supabaseClient.storage
                .from(bucket)
                .download(bestName);
            if (error) throw error;
            if (data) {
                const file = new File([data], bestName, { type: 'application/pdf' });
                cachePendingPdf(inv, file);
                console.log("[CloudPDF] Descargado por fallback:", bestName, "bucket:", bucket);
                return file;
            }
        } catch (e) {
            lastError = e;
            console.warn("[CloudPDF] Error fallback download bucket", bucket + ":", e.message);
        }
    }

    console.warn("[CloudPDF] Download fallido en todos los buckets para", fileNames, lastError?.message || 'sin detalle');
    return null;
}

async function clearCloudHistory() {
    if (!supabaseClient) return { ok: true, skipped: true, message: 'Sin cliente Supabase' };

    try {
        const { error: invoicesError } = await supabaseClient
            .from('invoices')
            .delete()
            .not('id', 'is', null);
        if (invoicesError) throw invoicesError;

        // Intentar limpiar PDFs del storage en todos los buckets conocidos
        for (const bucket of PDF_BUCKET_CANDIDATES) {
            let offset = 0;
            const limit = 100;
            while (true) {
                const { data: files, error: listError } = await supabaseClient
                    .storage
                    .from(bucket)
                    .list('', { limit, offset, sortBy: { column: 'name', order: 'asc' } });
                if (listError) break;
                if (!files || files.length === 0) break;

                const names = files
                    .map(f => String(f.name || '').trim())
                    .filter(Boolean);

                if (names.length > 0) {
                    const { error: removeError } = await supabaseClient.storage.from(bucket).remove(names);
                    if (removeError) break;
                }

                if (files.length < limit) break;
                offset += limit;
            }
        }

        return { ok: true, skipped: false, message: 'Cloud limpiado' };
    } catch (err) {
        return { ok: false, skipped: false, message: String(err?.message || err || 'Error desconocido') };
    }
}

async function cloudDeleteInvoice(inv) {
    if (!supabaseClient || !inv) return { ok: true, skipped: true, message: 'Sin cliente Supabase o factura' };

    try {
        const fileName = String(inv.fileName || '').trim();
        const invoiceNum = String(inv.invoiceNum || '').trim();
        const cups = String(inv.cups || '').trim();
        const period = String(inv.period || '').trim();

        if (fileName) {
            const { error } = await supabaseClient
                .from('invoices')
                .delete()
                .eq('file_name', fileName);
            if (error) throw error;
        }

        if (invoiceNum && cups) {
            let query = supabaseClient
                .from('invoices')
                .delete()
                .eq('invoice_num', invoiceNum)
                .eq('cups', cups);
            if (period) query = query.eq('period', period);
            const { error } = await query;
            if (error) throw error;
        }

        const pdfNames = buildPdfCloudNameCandidates(inv);
        for (const bucket of PDF_BUCKET_CANDIDATES) {
            if (pdfNames.length === 0) continue;
            const { error } = await supabaseClient.storage.from(bucket).remove(pdfNames);
            if (error) {
                console.warn('[CloudPDF] No se pudo borrar en bucket', bucket, error.message);
            }
        }

        return { ok: true, skipped: false, message: 'Factura eliminada en cloud' };
    } catch (err) {
        return { ok: false, skipped: false, message: String(err?.message || err || 'Error desconocido') };
    }
}

function loadLocalStore() {
    const stored = localStorage.getItem('audit_pro_db');
    if (stored) {
        try {
            dbInvoices = JSON.parse(stored).map(sanitizeInvoiceForStorage);
            localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
            console.log("[LocalDB] Cargado:", dbInvoices.length, "registros");
        } catch (err) {
            console.warn('[LocalDB] Error parseando datos locales, se ignoran:', err);
            dbInvoices = [];
        }
    }
    renderHistory();
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

    const allInvoices = [...invoices, ...dbInvoices];
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
    const proposalNames = Object.values(supplyProposals || {}).map(p => String(p?.commercializerName || '').trim()).filter(Boolean);
    const commercializerOptions = [...new Set([
        ...allInvoices.map(inv => String(inv.comercializadora || 'N/D').trim() || 'N/D'),
        ...proposalNames
    ])]
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
                    const proposal = getSupplyProposal(inv);
                    supplyMap.set(key, {
                        address,
                        cups,
                        tariffType,
                        comercializadora: inv.comercializadora || 'N/D',
                        proposedCommercializer: proposal?.commercializerName || null,
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
                    const matchCommercializer = !activeCommercializer
                        || s.comercializadora === activeCommercializer
                        || s.proposedCommercializer === activeCommercializer;
                    return matchSupply && matchTariff && matchCommercializer;
                });

            if (supplies.length === 0) return '';

            const rows = supplies.map(s => {
                const rowIndex = clientSupplyRows.push({ supply: s, invoice: s.invoice }) - 1;
                const audit = computeInvoiceAutoAudit(s.invoice);
                const badgeBg = audit.isOk ? '#ecfdf5' : '#fff7ed';
                const badgeColor = audit.isOk ? '#166534' : '#9a3412';
                return `
                    <tr>
                        <td>${s.address}</td>
                        <td>${s.cups}</td>
                        <td>${s.tariffType}</td>
                        <td>
                            <div>${s.comercializadora}</div>
                            ${s.proposedCommercializer ? `<div style="font-size:0.8rem; color:#059669;">Propuesta: ${s.proposedCommercializer}</div>` : ''}
                        </td>
                        <td>
                            <span style="display:inline-block; padding:0.2rem 0.5rem; border-radius:999px; font-size:0.78rem; font-weight:700; background:${badgeBg}; color:${badgeColor};">
                                ${audit.isOk ? 'CUADRADA' : `REVISAR (${audit.failedCount})`}
                            </span>
                        </td>
                        <td>
                            <button class="btn primary btn-sm" onclick="openClientSupplyInvoice(${rowIndex})">Ver factura</button>
                            <button class="btn secondary btn-sm" onclick="openClientSupplyAuditModal(${rowIndex})" style="margin-left:0.4rem;">Audit</button>
                            <button class="btn secondary btn-sm" onclick="openCompareFromClientSupply(${rowIndex})" style="margin-left:0.4rem;">Comparar</button>
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
                                    <th>Cuadre</th>
                                    <th>Acciones</th>
                                </tr>
                            </thead>
                            <tbody>
                                ${rows || '<tr><td colspan="6">Sin suministros</td></tr>'}
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
            <td>${formatBillingPeriod(inv.period || 'N/D')}</td>
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

    const activeSearch = String(document.getElementById('history-search-input')?.value || '').trim().toLowerCase();

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

    const searchBox = `
        <div class="card" style="padding:0.75rem; margin-bottom:0.75rem;">
            <input
                id="history-search-input"
                type="text"
                value="${activeSearch.replace(/"/g, '&quot;')}"
                oninput="renderHistory()"
                placeholder="Buscar por factura, cliente, CUPS o direccion de suministro"
                style="width:100%; padding:0.6rem 0.75rem; border:1px solid #cbd5e1; border-radius:8px;"
            >
        </div>
    `;

    const indexedInvoices = dbInvoices.map((inv, index) => ({ inv, index }));
    const filteredInvoices = activeSearch
        ? indexedInvoices.filter(({ inv }) => {
            const haystack = [
                inv.fileName,
                inv.invoiceNum,
                inv.clientName,
                inv.cups,
                inv.supplyAddress,
                inv.period,
                inv.comercializadora
            ].map(v => String(v || '').toLowerCase()).join(' | ');
            return haystack.includes(activeSearch);
        })
        : indexedInvoices;

    if (filteredInvoices.length === 0) {
        historyList.innerHTML = searchBox + clearAllButton + `
            <div class="card" style="padding:1rem;">No hay facturas que coincidan con la busqueda.</div>
        `;
        return;
    }

    historyList.innerHTML = searchBox + clearAllButton + filteredInvoices.map(({ inv, index }) => `
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
                    <strong>${inv.fileName || inv.invoiceNum || 'N/A'}</strong> - ${formatBillingPeriod(inv.period || 'Periodo desconocido')}
                    <br><small><strong>Cliente:</strong> ${inv.clientName || 'N/D'}</small>
                    <br><small><strong>CUPS:</strong> ${inv.cups || 'N/D'}</small>
                    <br><small><strong>Suministro:</strong> ${inv.supplyAddress || 'N/D'}</small>
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

function formatDecimal(value, digits = 6) {
    return Number(value || 0).toFixed(digits);
}

function formatBillingPeriod(periodText) {
    const raw = String(periodText || '').trim();
    if (!raw || raw === 'N/D') return 'N/D';

    const rangeMatch = raw.match(/(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})\s*(?:-|a|al)\s*(\d{1,2}[\/\.\-]\d{1,2}[\/\.\-]\d{2,4})/i);
    const longMatch = raw.match(/del\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{2,4})\s+al\s+(\d{1,2})\s+de\s+([a-záéíóúñ]+)\s+de\s+(\d{2,4})/i);

    if (!rangeMatch && !longMatch) return raw;

    const normalizeDate = (value) => {
        const parts = value.replace(/[\.\-]/g, '/').split('/').map(v => v.trim());
        if (parts.length !== 3) return value;
        const d = String(Number(parts[0] || 0)).padStart(2, '0');
        const m = String(Number(parts[1] || 0)).padStart(2, '0');
        const yNum = Number(parts[2] || 0);
        const yy = String(yNum % 100).padStart(2, '0');
        return `${d}/${m}/${yy}`;
    };

    const monthMap = {
        enero: 1,
        febrero: 2,
        marzo: 3,
        abril: 4,
        mayo: 5,
        junio: 6,
        julio: 7,
        agosto: 8,
        septiembre: 9,
        setiembre: 9,
        octubre: 10,
        noviembre: 11,
        diciembre: 12
    };

    let from;
    let to;

    if (rangeMatch) {
        from = normalizeDate(rangeMatch[1]);
        to = normalizeDate(rangeMatch[2]);
    } else {
        const d1 = String(Number(longMatch[1] || 0)).padStart(2, '0');
        const m1 = String(monthMap[String(longMatch[2] || '').toLowerCase()] || 0).padStart(2, '0');
        const y1 = String(Number(longMatch[3] || 0) % 100).padStart(2, '0');

        const d2 = String(Number(longMatch[4] || 0)).padStart(2, '0');
        const m2 = String(monthMap[String(longMatch[5] || '').toLowerCase()] || 0).padStart(2, '0');
        const y2 = String(Number(longMatch[6] || 0) % 100).padStart(2, '0');

        if (m1 === '00' || m2 === '00') return raw;
        from = `${d1}/${m1}/${y1}`;
        to = `${d2}/${m2}/${y2}`;
    }

    return `del ${from} al ${to}`;
}

function computeInvoiceAutoAudit(inv) {
    const tolerance = 0.5;
    const allowedPeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
    const energyItems = (inv.energyPeriodItems || []).filter(item => allowedPeriods.includes(Number(item.period)));

    const energyCommodityDetail = energyItems.reduce((sum, e) => {
        return sum + (Number(e.kwh || 0) * Number(e.unitPriceKwh || 0));
    }, 0);

    const tollsDetail = energyItems.reduce((sum, e) => {
        const toll = (inv.tollPeriodItems || []).find(t => Number(t.period) === Number(e.period));
        return sum + (Number(e.kwh || 0) * Number(toll?.unitPriceKwh || 0));
    }, 0);

    const energyTotalDetail = energyCommodityDetail + tollsDetail;

    const billingDays = inferInvoiceBillingDays(inv);
    const powerDetail = (inv.powerPeriodItems || [])
        .filter(item => Number(item.kw || 0) > 0)
        .reduce((sum, p) => {
            const days = Number(p.days || 0) > 0 ? Number(p.days || 0) : billingDays;
            return sum + (Number(p.kw || 0) * Number(p.unitPriceKw || 0) * Number(days || 0));
        }, 0);

    const others = Number(inv.othersCost || 0);
    const alquiler = Number(inv.alquiler || 0);
    const reactive = Number(inv.reactiveCost || 0);

    const energyRef = Number(inv.energyCost || 0);
    const powerRef = Number(inv.powerCost || 0);
    const ieeRef = Number(inv.breakdown?.iee || inv.electricityTax || 0);
    const taxRef = Number(inv.taxValue || inv.breakdown?.taxAmount || 0);
    const totalRef = Number(inv.totalCalculated || 0);

    const subtotalFromBreakdown = Number(inv.breakdown?.subtotalBase || 0);
    const subtotalFromComponents = energyRef + powerRef + others + alquiler + reactive;
    const subtotalFromTotal = totalRef > 0 ? Math.max(0, totalRef - ieeRef - taxRef) : 0;

    // Prioridad de referencia:
    // 1) total - impuestos (más estable cuando IA mezcla others/alquiler)
    // 2) subtotal explícito de breakdown
    // 3) suma de componentes
    const subtotalRef = subtotalFromTotal > 0
        ? subtotalFromTotal
        : (subtotalFromBreakdown > 0 ? subtotalFromBreakdown : subtotalFromComponents);

    let otherChargesDetail = others + alquiler + reactive;
    if (totalRef > 0) {
        const subtotalFromTotal = totalRef - ieeRef - taxRef;
        if (subtotalFromTotal > 0) {
            const impliedOtherFromDetail = Math.max(0, subtotalFromTotal - (energyTotalDetail + powerDetail));
            // En algunas facturas IA mete alquiler dentro de othersCost y también en alquiler.
            // Si hay desvío claro, usar el cargo implícito por coherencia fiscal.
            if (Math.abs(otherChargesDetail - impliedOtherFromDetail) > 0.5) {
                otherChargesDetail = impliedOtherFromDetail;
            }
        }
    }

    const subtotalDetail = energyTotalDetail + powerDetail + otherChargesDetail;
    const totalDetail = subtotalDetail + ieeRef + taxRef;

    const checks = [
        {
            key: 'energy',
            label: 'Energia total (energia + peajes/cargos)',
            expected: energyRef,
            actual: energyTotalDetail
        },
        {
            key: 'power',
            label: 'Potencia total',
            expected: powerRef,
            actual: powerDetail
        },
        {
            key: 'subtotal',
            label: 'Subtotal base',
            expected: subtotalRef,
            actual: subtotalDetail
        },
        {
            key: 'total',
            label: 'Total factura',
            expected: totalRef,
            actual: totalDetail
        }
    ].map(item => {
        const diff = Math.abs(item.expected - item.actual);
        return { ...item, diff, ok: diff <= tolerance };
    });

    const failed = checks.filter(c => !c.ok);
    return {
        tolerance,
        checks,
        failedCount: failed.length,
        isOk: failed.length === 0,
        breakdown: {
            energyCommodityDetail,
            tollsDetail,
            energyTotalDetail,
            powerDetail,
            others,
            alquiler,
            reactive,
            otherChargesDetail,
            ieeRef,
            taxRef,
            subtotalDetail,
            totalDetail,
            energyRef,
            powerRef,
            subtotalRef,
            totalRef
        }
    };
}

function openClientSupplyAuditModal(rowIndex) {
    const row = clientSupplyRows[rowIndex];
    if (!row || !row.invoice) return;

    const inv = row.invoice;
    const audit = computeInvoiceAutoAudit(inv);
    const modal = document.getElementById('client-supply-audit-modal');
    const body = document.getElementById('client-supply-audit-modal-body');
    if (!modal || !body) return;

    const checkRows = audit.checks.map(c => `
        <tr>
            <td>${c.label}</td>
            <td>${formatCurrency(c.expected)}</td>
            <td>${formatCurrency(c.actual)}</td>
            <td style="font-weight:700; color:${c.ok ? '#059669' : '#dc2626'};">${formatCurrency(c.diff)}</td>
            <td style="font-weight:700; color:${c.ok ? '#059669' : '#dc2626'};">${c.ok ? 'OK' : 'REVISAR'}</td>
        </tr>
    `).join('');

    const activePeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
    const sourceRows = [
        ['Fuente energía por periodos', inv._energyPeriodsSource || 'N/D'],
        ['Fuente peajes/cargos', inv._tollPeriodsSource || 'N/D'],
        ['Fuente potencia por periodos', inv._powerPeriodsSource || 'N/D'],
        ['Fuente energyCost total variable', inv._energyCostSource || 'N/D'],
        ['Ajuste manual aplicado', inv._manualPeriodOverrides ? 'Sí' : 'No'],
        ['Última corrección manual', inv._manualEditedAt ? new Date(inv._manualEditedAt).toLocaleString('es-ES') : 'N/D']
    ].map(([label, value]) => `
        <tr>
            <td>${label}</td>
            <td>${value}</td>
        </tr>
    `).join('');

    const periodEditorRows = activePeriods.map(period => {
        const energy = (inv.energyPeriodItems || []).find(item => Number(item.period) === Number(period)) || { kwh: 0, unitPriceKwh: 0 };
        const toll = (inv.tollPeriodItems || []).find(item => Number(item.period) === Number(period)) || { unitPriceKwh: 0 };
        return `
            <tr>
                <td>P${period}</td>
                <td><input type="number" id="audit-kwh-${rowIndex}-${period}" value="${formatDecimal(energy.kwh, 3)}" step="0.001" style="width:100%; padding:0.4rem; border:1px solid #cbd5e1; border-radius:6px;"></td>
                <td><input type="number" id="audit-energy-${rowIndex}-${period}" value="${formatDecimal(energy.unitPriceKwh, 6)}" step="0.000001" style="width:100%; padding:0.4rem; border:1px solid #cbd5e1; border-radius:6px;"></td>
                <td><input type="number" id="audit-toll-${rowIndex}-${period}" value="${formatDecimal(toll.unitPriceKwh, 6)}" step="0.000001" style="width:100%; padding:0.4rem; border:1px solid #cbd5e1; border-radius:6px;"></td>
            </tr>
        `;
    }).join('');

    body.innerHTML = `
        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem; background:${audit.isOk ? '#ecfdf5' : '#fff7ed'}; border:1px solid ${audit.isOk ? '#bbf7d0' : '#fed7aa'};">
            <div><strong>Resultado de cuadre:</strong> ${audit.isOk ? 'CUADRADA' : 'REVISAR'}</div>
            <div><strong>Factura:</strong> ${inv.invoiceNum || 'S/N'} | <strong>CUPS:</strong> ${inv.cups || 'N/D'} | <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'}</div>
            <div style="margin-top:0.35rem; color:#475569;">Tolerancia aplicada: ${formatCurrency(audit.tolerance)}</div>
        </div>

        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem; border:1px solid #dbeafe; background:#f8fbff;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:0.5rem;">
                <h3 style="margin:0;">Trazabilidad de la extracción</h3>
                <button class="btn secondary btn-sm" onclick="toggleAuditCorrections(${rowIndex})">Mostrar / ocultar corrección manual</button>
            </div>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead><tr><th>Dato</th><th>Valor</th></tr></thead>
                    <tbody>${sourceRows}</tbody>
                </table>
            </div>
            <p style="margin:0.65rem 0 0; color:#475569;">Si aquí ves una fuente incorrecta o el cuadre falla, puedes corregir los periodos y guardar la versión manual para usarla después en comparativas.</p>
        </div>

        ${inv._rawOpenAIJSON ? `
        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem; border:1px solid #e2e8f0; background:#f8fafc;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:0.5rem;">
                <h3 style="margin:0;">JSON crudo de OpenAI</h3>
                <button class="btn secondary btn-sm" onclick="document.getElementById('raw-openai-json-${rowIndex}').classList.toggle('hidden')">Mostrar / ocultar</button>
            </div>
            <div id="raw-openai-json-${rowIndex}" class="hidden">
                <pre style="background:#1e293b; color:#e2e8f0; padding:0.85rem; border-radius:8px; overflow-x:auto; white-space:pre-wrap; font-size:0.78rem; max-height:400px; overflow-y:auto;">${inv._rawOpenAIJSON.replace(/</g,'&lt;').replace(/>/g,'&gt;')}</pre>
            </div>
        </div>
        ` : ''}

        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem;">
            <h3 style="margin-bottom:0.5rem;">Comprobaciones automaticas (detalle vs factura)</h3>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr><th>Chequeo</th><th>Factura</th><th>Detalle calculado</th><th>Diferencia</th><th>Estado</th></tr>
                    </thead>
                    <tbody>${checkRows}</tbody>
                </table>
            </div>
        </div>

        <div id="audit-corrections-${rowIndex}" class="card hidden" style="padding:0.85rem; margin-bottom:0.75rem; border:1px solid #fcd34d; background:#fffbeb;">
            <h3 style="margin-bottom:0.5rem;">Corrección manual para futuras comparativas</h3>
            <p style="margin:0 0 0.75rem; color:#475569;">Edita kWh, precio de energía y precio de peajes/cargos por periodo. Al guardar, esta factura quedará corregida y se usará así en comparativas y auditorías posteriores.</p>
            <div style="overflow-x:auto; margin-bottom:0.75rem;">
                <table class="modal-table">
                    <thead>
                        <tr><th>Periodo</th><th>kWh</th><th>Energía €/kWh</th><th>Peajes €/kWh</th></tr>
                    </thead>
                    <tbody>${periodEditorRows || '<tr><td colspan="4">No hay periodos activos detectados para esta factura.</td></tr>'}</tbody>
                </table>
            </div>
            <div style="display:flex; gap:0.6rem; flex-wrap:wrap;">
                <button class="btn primary btn-sm" onclick="saveAuditCorrections(${rowIndex})">Guardar corrección</button>
                <button class="btn secondary btn-sm" onclick="openClientSupplyAuditModal(${rowIndex})">Restaurar valores mostrados</button>
            </div>
        </div>

        <div class="card" style="padding:0.85rem;">
            <h3 style="margin-bottom:0.5rem;">Desglose usado en el calculo del detalle</h3>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead><tr><th>Concepto</th><th>Importe</th></tr></thead>
                    <tbody>
                        <tr><td>Energia comercializada (detalle)</td><td>${formatCurrency(audit.breakdown.energyCommodityDetail)}</td></tr>
                        <tr><td>Peajes/cargos energia (detalle)</td><td>${formatCurrency(audit.breakdown.tollsDetail)}</td></tr>
                        <tr><td>Energia total detalle</td><td>${formatCurrency(audit.breakdown.energyTotalDetail)}</td></tr>
                        <tr><td>Potencia total detalle</td><td>${formatCurrency(audit.breakdown.powerDetail)}</td></tr>
                        <tr><td>Otros + Alquiler + Reactiva</td><td>${formatCurrency(audit.breakdown.otherChargesDetail)}</td></tr>
                        <tr><td>IEE (factura)</td><td>${formatCurrency(audit.breakdown.ieeRef)}</td></tr>
                        <tr><td>${inv.taxName || 'Impuesto'} (factura)</td><td>${formatCurrency(audit.breakdown.taxRef)}</td></tr>
                        <tr style="font-weight:700; background:#eef2ff;"><td>Total detalle calculado</td><td>${formatCurrency(audit.breakdown.totalDetail)}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    `;

    modalGuardUntil.clientAudit = Date.now() + 250;
    modal.classList.remove('hidden');
}

function toggleAuditCorrections(rowIndex) {
    const panel = document.getElementById(`audit-corrections-${rowIndex}`);
    if (!panel) return;
    panel.classList.toggle('hidden');
}

function persistCorrectedInvoice(updatedInvoice) {
    const dbPayload = sanitizeInvoiceForStorage(updatedInvoice);
    let foundInDb = false;

    dbInvoices.forEach(inv => {
        if (isSameInvoiceRecord(inv, updatedInvoice)) {
            Object.assign(inv, JSON.parse(JSON.stringify(dbPayload)));
            foundInDb = true;
        }
    });

    if (!foundInDb) {
        dbInvoices.unshift(JSON.parse(JSON.stringify(dbPayload)));
    }

    invoices.forEach(inv => {
        if (isSameInvoiceRecord(inv, updatedInvoice)) {
            Object.assign(inv, JSON.parse(JSON.stringify(updatedInvoice)));
        }
    });

    if (compareBaseInvoice && isSameInvoiceRecord(compareBaseInvoice, updatedInvoice)) {
        Object.assign(compareBaseInvoice, JSON.parse(JSON.stringify(updatedInvoice)));
    }

    localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
    renderHistory();
    renderClients();
}

function saveAuditCorrections(rowIndex) {
    const row = clientSupplyRows[rowIndex];
    if (!row || !row.invoice) return;

    const inv = row.invoice;
    const activePeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
    if (activePeriods.length === 0) {
        alert('No hay periodos detectados para corregir.');
        return;
    }

    const correctedEnergyItems = [];
    const correctedTollItems = [];

    for (const period of activePeriods) {
        const kwh = Number(document.getElementById(`audit-kwh-${rowIndex}-${period}`)?.value || 0);
        const energyPrice = Number(document.getElementById(`audit-energy-${rowIndex}-${period}`)?.value || 0);
        const tollPrice = Number(document.getElementById(`audit-toll-${rowIndex}-${period}`)?.value || 0);

        if (kwh > 0 && energyPrice > 0) {
            correctedEnergyItems.push({ period, kwh, unitPriceKwh: energyPrice });
        }
        if (kwh > 0 && tollPrice >= 0) {
            correctedTollItems.push({ period, kwh, unitPriceKwh: tollPrice });
        }
    }

    if (correctedEnergyItems.length === 0) {
        alert('Debes indicar al menos un periodo con kWh y precio de energía válidos.');
        return;
    }

    inv.energyPeriodItems = correctedEnergyItems;
    inv.tollPeriodItems = correctedTollItems;
    inv.consumptionItems = [0, 0, 0, 0, 0, 0];
    correctedEnergyItems.forEach(item => {
        inv.consumptionItems[item.period - 1] = Number(item.kwh || 0);
    });
    inv.consumption = correctedEnergyItems.reduce((sum, item) => sum + Number(item.kwh || 0), 0);
    inv._energyPeriodsSource = 'manual';
    inv._tollPeriodsSource = 'manual';
    inv._manualPeriodOverrides = true;
    inv._manualEditedAt = new Date().toISOString();

    normalizeEnergyAndTolls(inv);
    validateMandatoryTolls(inv);
    persistCorrectedInvoice(inv);
    openClientSupplyAuditModal(rowIndex);
}

function closeClientSupplyAuditModal() {
    const modal = document.getElementById('client-supply-audit-modal');
    if (modal) modal.classList.add('hidden');
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
        ['Periodo', formatBillingPeriod(inv.period || 'N/D')],
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
        const isTotalRow = label === 'Total calculado';
        html += isTotalRow
            ? `<tr style="font-weight:700; background:#eef2ff;"><th>${label}</th><td>${value}</td></tr>`
            : `<tr><th>${label}</th><td>${value}</td></tr>`;
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

function openCompareForInvoice(inv, fromIndex = null) {
    if (!inv) return;

    const compatible = commercializers.filter(c => !c.tariffType || inv.tariffType?.startsWith(String(c.tariffType).trim()));
    if (compatible.length === 0) {
        alert('No hay comercializadoras configuradas compatibles con la tarifa de esta factura.');
        return;
    }

    compareBaseInvoice = inv;
    compareCurrentInvoiceIndex = fromIndex;
    compareSelectedCommercializers = [];
    compareScope = 'single';
    const scopeEl = document.getElementById('compare-scope');
    if (scopeEl) scopeEl.value = 'single';
    renderCompareSelectorList();
    modalGuardUntil.compareSelector = Date.now() + 250;
    document.getElementById('compare-selector-modal').classList.remove('hidden');
}

function openCompareView(index) {
    const inv = invoices[index];
    openCompareForInvoice(inv, index);
}

function openCompareFromClientSupply(rowIndex) {
    const row = clientSupplyRows[rowIndex];
    if (!row || !row.invoice) {
        alert('No hay factura asociada para comparar.');
        return;
    }
    openCompareForInvoice(row.invoice, null);
}

function renderCompareLanding() {
    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

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
    compareCatalog = unique;

    if (compareCatalog.length === 0) {
        compareSection.innerHTML = '<div class="card" style="padding:1rem;">No hay facturas disponibles para iniciar una comparativa.</div>';
        return;
    }

    const options = compareCatalog.map((inv, idx) => {
        const label = `${inv.clientName || 'Cliente'} | ${getShortSupplyAddress(inv.supplyAddress)} | ${inv.cups || 'N/D'} | ${inv.tariffType || 'N/D'} | ${inv.invoiceNum || 'S/N'}`;
        return `<option value="${idx}">${label}</option>`;
    }).join('');

    compareSection.innerHTML = `
        <div class="card" style="padding:1rem; margin-bottom:1rem;">
            <h3 style="margin-bottom:0.75rem;">Iniciar Comparativa</h3>
            <p style="color:#64748b; margin-bottom:0.75rem;">Puedes iniciarla desde aquí o desde cada suministro en la pestaña Clientes.</p>
            <div style="display:grid; grid-template-columns: 1fr auto; gap:0.75rem; align-items:center;">
                <select id="compare-base-select" style="padding:0.55rem; border:1px solid #d1d5db; border-radius:6px;">${options}</select>
                <button class="btn primary" onclick="startCompareFromTab()">Elegir y comparar</button>
            </div>
        </div>
    `;
}

function startCompareFromTab() {
    const select = document.getElementById('compare-base-select');
    if (!select) return;
    const idx = Number(select.value);
    const inv = compareCatalog[idx];
    if (!inv) return;
    openCompareForInvoice(inv, null);
}

function normalizeClientKey(name) {
    return String(name || '').trim().toLowerCase();
}

function getShortSupplyAddress(address, maxLen = 48) {
    const raw = String(address || '').trim();
    if (!raw || raw === 'N/D') return 'Suministro N/D';

    const abbreviated = raw
        .replace(/\bavenida\b/gi, 'Av.')
        .replace(/\bcalle\b/gi, 'C/')
        .replace(/\bcarretera\b/gi, 'Ctra.')
        .replace(/\bplaza\b/gi, 'Pza.')
        .replace(/\bpoligono\b/gi, 'Pol.')
        .replace(/\burbanizacion\b/gi, 'Urb.')
        .replace(/\bn[úu]mero\b/gi, 'Num.')
        .replace(/\s+/g, ' ')
        .trim();

    if (abbreviated.length <= maxLen) return abbreviated;
    return `${abbreviated.slice(0, maxLen - 1).trim()}...`;
}

function getCompareInvoices(baseInvoice) {
    return getCompareInvoicesByScope(baseInvoice, compareScope);
}

function getCompareInvoicesByScope(baseInvoice, scopeMode) {
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

    if (scopeMode === 'client-tariff') {
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
        const tollItems = (inv.tollPeriodItems || []).filter(item => allowedPeriods.includes(Number(item.period)));
        const simulation = buildInvoiceTransparencySimulation(inv, comm);

        const consumption = energyItems.reduce((sum, item) => sum + Number(item.kwh || 0), 0);
        const oldEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0)
            + tollItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
        const proposedEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(comm.energyPrices?.[item.period] || 0)), 0)
            + tollItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
        const baseTotal = Number(inv.totalCalculated || 0);
        const simulatedTotal = simulation.newTotal;

        totalConsumption += consumption;
        oldEnergyCost += oldEnergy;
        newEnergyCost += proposedEnergy;
        oldTotalInvoice += baseTotal;
        newTotalInvoiceSim += simulatedTotal;

        invoiceRows.push({
            invoiceNum: inv.invoiceNum || 'S/N',
            cups: inv.cups || 'N/D',
            supplyAddress: inv.supplyAddress || 'N/D',
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

function computeInvoiceProposalMetrics(inv, comm) {
    const allowedPeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
    const energyItems = (inv.energyPeriodItems || []).filter(item => allowedPeriods.includes(Number(item.period)));
    const tollItems = (inv.tollPeriodItems || []).filter(item => allowedPeriods.includes(Number(item.period)));
    const simulation = buildInvoiceTransparencySimulation(inv, comm);
    const consumption = energyItems.reduce((sum, item) => sum + Number(item.kwh || 0), 0);
    const oldEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0)
        + tollItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
    const newEnergy = energyItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(comm.energyPrices?.[item.period] || 0)), 0)
        + tollItems.reduce((sum, item) => sum + (Number(item.kwh || 0) * Number(item.unitPriceKwh || 0)), 0);
    const oldTotal = Number(inv.totalCalculated || 0);
    const newTotalSim = simulation.newTotal;
    return {
        consumption,
        oldEnergy,
        newEnergy,
        oldAvgPrice: consumption > 0 ? oldEnergy / consumption : 0,
        newAvgPrice: consumption > 0 ? newEnergy / consumption : 0,
        energySaving: oldEnergy - newEnergy,
        oldTotal,
        newTotalSim,
        totalSaving: oldTotal - newTotalSim
    };
}

function inferInvoiceBillingDays(inv) {
    const fromItems = (inv.powerPeriodItems || []).map(i => Number(i.days || 0)).find(d => d > 0);
    if (fromItems) return fromItems;

    const period = String(inv.period || '');
    const rangeMatch = period.match(/(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})\s*(?:-|a|al)\s*(\d{1,2}[\/\.]\d{1,2}[\/\.]\d{2,4})/i);
    if (!rangeMatch) return 30;

    const parseDate = (raw) => {
        const sep = raw.includes('/') ? '/' : '.';
        const [d, m, y] = raw.split(sep).map(v => Number(v));
        const year = y < 100 ? (2000 + y) : y;
        return new Date(year, (m || 1) - 1, d || 1);
    };

    const d1 = parseDate(rangeMatch[1]);
    const d2 = parseDate(rangeMatch[2]);
    const diff = Math.round((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24));
    return diff > 0 && diff <= 365 ? diff : 30;
}

function buildInvoiceTransparencySimulation(inv, comm) {
    const allowedEnergyPeriods = getActivePeriodsByTariff(inv.tariffType, inv.energyPeriodItems || []);
    const energyItems = (inv.energyPeriodItems || [])
        .filter(item => allowedEnergyPeriods.includes(Number(item.period)))
        .sort((a, b) => Number(a.period || 0) - Number(b.period || 0));

    const rawEnergyRows = energyItems.map(item => {
        const period = Number(item.period || 0);
        const kwh = Number(item.kwh || 0);
        const oldUnit = Number(item.unitPriceKwh || 0);
        const newUnit = Number(comm.energyPrices?.[period] || 0);
        const tollItem = (inv.tollPeriodItems || []).find(t => Number(t.period || 0) === period);
        const rawTollUnit = Number(tollItem?.unitPriceKwh || 0);
        const oldAmount = kwh * oldUnit;
        const newAmount = kwh * newUnit;
        const rawTollAmount = kwh * rawTollUnit;
        return {
            period,
            kwh,
            oldUnit,
            newUnit,
            oldAmount,
            newAmount,
            rawTollUnit,
            rawTollAmount
        };
    });

    const rawTollTotal = rawEnergyRows.reduce((sum, r) => sum + r.rawTollAmount, 0);
    const oldCommodityEnergy = rawEnergyRows.reduce((sum, r) => sum + r.oldAmount, 0);
    const newCommodityEnergy = rawEnergyRows.reduce((sum, r) => sum + r.newAmount, 0);
    const oldEnergyFromDetail = oldCommodityEnergy + rawTollTotal;
    const oldEnergyReference = oldEnergyFromDetail > 0
        ? oldEnergyFromDetail
        : (Number(inv.energyCost || 0) > 0 ? Number(inv.energyCost || 0) : oldCommodityEnergy);
    const preservedEnergyFixedTotal = oldEnergyReference - oldCommodityEnergy;
    const totalKwh = rawEnergyRows.reduce((sum, r) => sum + r.kwh, 0);

    const energyRows = rawEnergyRows.map(row => {
        let preservedAmount = 0;
        if (Math.abs(rawTollTotal) > 0.000001) {
            preservedAmount = preservedEnergyFixedTotal * (row.rawTollAmount / rawTollTotal);
        } else if (totalKwh > 0) {
            preservedAmount = preservedEnergyFixedTotal * (row.kwh / totalKwh);
        } else if (rawEnergyRows.length > 0) {
            preservedAmount = preservedEnergyFixedTotal / rawEnergyRows.length;
        }

        const preservedUnit = row.kwh > 0 ? preservedAmount / row.kwh : 0;
        const oldTotalAmount = row.oldAmount + preservedAmount;
        const newTotalAmount = row.newAmount + preservedAmount;

        return {
            period: row.period,
            kwh: row.kwh,
            oldUnit: row.oldUnit,
            newUnit: row.newUnit,
            tollUnit: preservedUnit,
            oldAmount: row.oldAmount,
            newAmount: row.newAmount,
            tollAmount: preservedAmount,
            oldTotalAmount,
            newTotalAmount,
            delta: oldTotalAmount - newTotalAmount
        };
    });

    const tollEnergyCost = energyRows.reduce((sum, r) => sum + r.tollAmount, 0);
    const newEnergy = energyRows.reduce((sum, r) => sum + r.newTotalAmount, 0);

    const allowedPowerPeriods = getConfiguredPowerPeriodsByTariff(inv.tariffType || comm.tariffType || '2.0');
    const billingDays = inferInvoiceBillingDays(inv);
    const powerItems = (inv.powerPeriodItems || [])
        .filter(item => allowedPowerPeriods.includes(Number(item.period)) && Number(item.kw || 0) > 0)
        .sort((a, b) => Number(a.period || 0) - Number(b.period || 0));

    const rawPowerRows = powerItems.map(item => {
        const period = Number(item.period || 0);
        const kw = Number(item.kw || 0);
        const days = Number(item.days || 0) > 0 ? Number(item.days || 0) : billingDays;
        const oldUnit = Number(item.unitPriceKw || 0);
        const configuredNew = Number(comm.powerPrices?.[period] || 0);
        const newUnit = configuredNew > 0 ? configuredNew : oldUnit;
        const oldAmount = kw * oldUnit * days;
        const newAmount = kw * newUnit * days;
        return {
            period,
            kw,
            days,
            oldUnit,
            newUnit,
            oldAmount,
            newAmount,
            delta: oldAmount - newAmount
        };
    });

    const oldPowerFromRows = rawPowerRows.reduce((sum, r) => sum + r.oldAmount, 0);
    const newPowerFromRows = rawPowerRows.reduce((sum, r) => sum + r.newAmount, 0);
    const oldPowerReference = Number(inv.powerCost || 0) > 0 ? Number(inv.powerCost || 0) : oldPowerFromRows;
    const preservedPowerFixedTotal = oldPowerReference - oldPowerFromRows;
    const powerRows = rawPowerRows.map(row => {
        const share = oldPowerFromRows > 0 ? (row.oldAmount / oldPowerFromRows) : (rawPowerRows.length > 0 ? 1 / rawPowerRows.length : 0);
        const preservedAmount = preservedPowerFixedTotal * share;
        const oldTotalAmount = row.oldAmount + preservedAmount;
        const newTotalAmount = row.newAmount + preservedAmount;
        return {
            period: row.period,
            kw: row.kw,
            days: row.days,
            oldUnit: row.oldUnit,
            newUnit: row.newUnit,
            oldAmount: oldTotalAmount,
            newAmount: newTotalAmount,
            delta: oldTotalAmount - newTotalAmount
        };
    });
    const newPower = powerRows.length > 0 ? powerRows.reduce((sum, r) => sum + r.newAmount, 0) : oldPowerReference;

    const others = Number(inv.othersCost || 0);
    const alquiler = Number(inv.alquiler || 0);
    const reactive = Number(inv.reactiveCost || 0);

    const oldSubtotalBase = Number(inv.breakdown?.subtotalBase || 0) > 0
        ? Number(inv.breakdown.subtotalBase)
        : (oldEnergyReference + oldPowerReference + others + alquiler + reactive);
    const newSubtotalBase = oldSubtotalBase - oldEnergyReference - oldPowerReference + newEnergy + newPower;

    const ieeRate = oldSubtotalBase > 0
        ? (Number(inv.breakdown?.iee || 0) / oldSubtotalBase)
        : BOE.taxes.iee;
    const oldIee = Number(inv.breakdown?.iee || 0) || (oldSubtotalBase * ieeRate);
    const newIee = newSubtotalBase * ieeRate;

    const oldSubtotalConIee = oldSubtotalBase + oldIee;
    const oldTaxAmount = Number(inv.taxValue || inv.breakdown?.taxAmount || 0);
    const isIgic = String(inv.taxName || inv.breakdown?.taxName || '').toUpperCase() === 'IGIC';
    const fallbackTaxRate = isIgic ? 0.07 : BOE.taxes.iva;
    const taxRate = oldSubtotalConIee > 0 ? (oldTaxAmount / oldSubtotalConIee) : fallbackTaxRate;

    const newSubtotalConIee = newSubtotalBase + newIee;
    const newTaxAmount = newSubtotalConIee * taxRate;

    const oldTotal = Number(inv.totalCalculated || 0);
    const newTotal = newSubtotalConIee + newTaxAmount;

    return {
        invoiceNum: inv.invoiceNum || 'S/N',
        clientName: inv.clientName || 'N/D',
        currentCommercializer: inv.comercializadora || 'N/D',
        cups: inv.cups || 'N/D',
        supplyAddress: inv.supplyAddress || 'N/D',
        period: inv.period || 'N/D',
        tariffType: inv.tariffType || 'N/D',
        taxName: isIgic ? 'IGIC' : 'IVA',
        taxRate,
        billingDays,
        energyRows,
        powerRows,
        oldEnergy: oldEnergyReference,
        newEnergy,
        oldCommodityEnergy,
        newCommodityEnergy,
        tollEnergyCost,
        preservedEnergyFixedTotal,
        oldEnergyReference,
        oldPowerReference,
        newPower,
        others,
        alquiler,
        reactive,
        oldSubtotalBase,
        newSubtotalBase,
        oldIee,
        newIee,
        oldTaxAmount,
        newTaxAmount,
        oldTotal,
        newTotal,
        energySaving: oldEnergyReference - newEnergy,
        powerImpact: oldPowerReference - newPower,
        totalSaving: oldTotal - newTotal
    };
}

function serializeSimulationSnapshot(simulation = {}) {
    return {
        energyRows: simulation.energyRows || [],
        powerRows: simulation.powerRows || [],
        oldCommodityEnergy: simulation.oldCommodityEnergy || 0,
        newCommodityEnergy: simulation.newCommodityEnergy || 0,
        tollEnergyCost: simulation.tollEnergyCost || 0,
        oldEnergyReference: simulation.oldEnergyReference || 0,
        newEnergy: simulation.newEnergy || 0,
        oldPowerReference: simulation.oldPowerReference || 0,
        newPower: simulation.newPower || 0,
        others: simulation.others || 0,
        alquiler: simulation.alquiler || 0,
        reactive: simulation.reactive || 0,
        oldIee: simulation.oldIee || 0,
        newIee: simulation.newIee || 0,
        taxName: simulation.taxName || 'Impuesto',
        taxRate: simulation.taxRate || 0,
        oldTaxAmount: simulation.oldTaxAmount || 0,
        newTaxAmount: simulation.newTaxAmount || 0,
        oldTotal: simulation.oldTotal || 0,
        newTotal: simulation.newTotal || 0,
        energySaving: simulation.energySaving || 0,
        powerImpact: simulation.powerImpact || 0,
        totalSaving: simulation.totalSaving || 0,
        newSubtotalBase: simulation.newSubtotalBase || 0
    };
}

function normalizeProposalMatchToken(value) {
    return String(value || '').trim().toLowerCase();
}

function findInvoiceForProposalEntry(entry) {
    const invoiceNum = normalizeProposalMatchToken(entry?.invoiceNum);
    const cups = normalizeProposalMatchToken(entry?.cups);
    const fileName = normalizeProposalMatchToken(entry?.fileName);
    const clientName = normalizeProposalMatchToken(entry?.clientName);
    const supplyAddress = normalizeProposalMatchToken(entry?.supplyAddress);

    const pool = [...dbInvoices, ...invoices];
    if (!pool.length) return null;

    if (invoiceNum && cups) {
        const strict = pool.find(inv => (
            normalizeProposalMatchToken(inv?.invoiceNum) === invoiceNum
            && normalizeProposalMatchToken(inv?.cups) === cups
        ));
        if (strict) return strict;
    }

    if (fileName) {
        const byFile = pool.find(inv => normalizeProposalMatchToken(inv?.fileName) === fileName);
        if (byFile) return byFile;
    }

    let best = null;
    let bestScore = -1;
    pool.forEach(inv => {
        let score = 0;
        if (invoiceNum && normalizeProposalMatchToken(inv?.invoiceNum) === invoiceNum) score += 60;
        if (cups && normalizeProposalMatchToken(inv?.cups) === cups) score += 30;
        if (clientName && normalizeProposalMatchToken(inv?.clientName) === clientName) score += 10;
        if (supplyAddress && normalizeProposalMatchToken(inv?.supplyAddress) === supplyAddress) score += 10;
        if (score > bestScore) {
            best = inv;
            bestScore = score;
        }
    });

    return bestScore >= 60 ? best : null;
}

function findCommercializerForProposalEntry(entry, invoice) {
    const proposedName = normalizeProposalMatchToken(entry?.proposedCommercializer);
    if (!proposedName || !Array.isArray(commercializers) || commercializers.length === 0) return null;

    const invoiceTariff = normalizeTariffTypeValue(invoice?.tariffType || entry?.tariffType || '');
    const byName = commercializers.filter(c => normalizeProposalMatchToken(c?.name) === proposedName);
    if (byName.length === 0) return null;

    if (!invoiceTariff || invoiceTariff === 'N/D') return byName[0];
    const strictTariff = byName.find(c => normalizeTariffTypeValue(c?.tariffType || '') === invoiceTariff);
    return strictTariff || byName[0];
}

function rebuildProposalSnapshotIfMissing(entry) {
    if (entry?.simulationSnapshot) {
        return { snapshot: entry.simulationSnapshot, regenerated: false };
    }

    const invoice = findInvoiceForProposalEntry(entry);
    if (!invoice) return { snapshot: null, regenerated: false };

    const commercializer = findCommercializerForProposalEntry(entry, invoice);
    if (!commercializer) return { snapshot: null, regenerated: false };

    const simulation = buildInvoiceTransparencySimulation(invoice, commercializer);
    const snapshot = serializeSimulationSnapshot(simulation);
    entry.simulationSnapshot = snapshot;

    if (!entry.simulatedTotal || Number(entry.simulatedTotal) === 0) {
        entry.simulatedTotal = Number(simulation.newTotal || 0);
    }
    if (!entry.totalSaving || Number(entry.totalSaving) === 0) {
        entry.totalSaving = Number(simulation.totalSaving || 0);
    }
    if (!entry.energySaving || Number(entry.energySaving) === 0) {
        entry.energySaving = Number(simulation.energySaving || 0);
    }

    return { snapshot, regenerated: true };
}

function buildReportHeaderHtml(title, subtitle = '') {
    const cleanTitle = String(title || '').trim() || 'Informe';
    const cleanSubtitle = String(subtitle || '').trim();
    return `
        <div class="card" style="padding:0.9rem; margin-bottom:1rem; border:1px solid #dbeafe; background:#f8fafc;">
            <div style="display:flex; align-items:center; justify-content:space-between; gap:1rem; flex-wrap:wrap;">
                <div>
                    <div style="font-size:1rem; font-weight:700; color:#0f172a;">${cleanTitle}</div>
                    <div style="font-size:0.85rem; color:#64748b;">ECE Consultores${cleanSubtitle ? ` | ${cleanSubtitle}` : ''}</div>
                </div>
                <img src="logo.png" alt="Logo ECE Consultores" style="height:54px; width:auto; object-fit:contain;" onerror="this.style.display='none'">
                <img src="logo.png" alt="Logo ECE Consultores" style="height:80px; width:auto; object-fit:contain; flex-shrink:0;" onerror="this.style.display='none'">
                <div>
                    <h1 style="margin:0; font-size:2rem; line-height:1.1; color:#0f172a;">Propuesta de Mejora de Precios</h1>
                    <p style="margin:0.45rem 0 0; color:#475569; font-size:1rem; max-width:760px;">Se presenta una propuesta comparativa sobre la factura analizada, manteniendo la estructura real del suministro y recalculando el impacto económico estimado con una nueva oferta de precios.</p>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(2, minmax(260px, 1fr)); gap:0.75rem; margin-bottom:1rem;">
                <div class="card pdf-avoid-break" style="padding:0.85rem; border:1px solid #dbeafe; background:#ffffff; margin:0;">
                    <div style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; margin-bottom:0.45rem;">Datos del informe</div>
                    <div><strong>Cliente:</strong> <strong style="font-size:1rem; color:#0f172a;">${clientName}</strong></div>
                    <div><strong>Tarifa:</strong> ${tariffType}</div>
                    <div><strong>Periodo analizado:</strong> ${periodLabel}</div>
                    <div><strong>${supplyCount} suministro${supplyCount !== 1 ? 's' : ''}</strong></div>
                    <div><strong>Fecha de emisión:</strong> ${generatedAt}</div>
                </div>
                <div class="card pdf-avoid-break" style="padding:0.85rem; border:1px solid #dbeafe; background:#ffffff; margin:0;">
                    <div style="font-size:0.78rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; margin-bottom:0.45rem;">Propuesta comercial</div>
                    <div style="font-size:0.85rem; color:#64748b; margin-bottom:0.5rem;"><small>De: ${currentCommercializerLabel}</small></div>
                    <div style="font-size:1rem; font-weight:700; color:#0f172a; margin-bottom:0.5rem;">${proposedCommercializer}</div>
                    <p style="margin:0; color:#475569;">Nueva oferta de precios con impacto directo en la factura.</p>
                </div>
            </div>

            <div style="display:grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap:0.75rem; margin-bottom:1rem;">
                <div class="card pdf-avoid-break" style="padding:0.9rem; margin:0; background:#ffffff; border:1px solid #e2e8f0;">
                    <div style="font-size:0.8rem; color:#64748b;">Coste actual</div>
                    <div style="font-size:1.5rem; font-weight:700; color:#0f172a;">${formatCurrency(currentTotal)}</div>
                </div>
                <div class="card pdf-avoid-break" style="padding:0.9rem; margin:0; background:#ffffff; border:1px solid #e2e8f0;">
                    <div style="font-size:0.8rem; color:#64748b;">Coste propuesto</div>
                    <div style="font-size:1.5rem; font-weight:700; color:#0f172a;">${formatCurrency(proposedTotal)}</div>
                </div>
                <div class="card pdf-avoid-break" style="padding:0.9rem; margin:0; background:#f0fdf4; border:1px solid #bbf7d0;">
                    <div style="font-size:0.8rem; color:#166534;">Ahorro estimado</div>
                    <div style="font-size:1.6rem; font-weight:800; color:#15803d;">${formatCurrency(savingTotal)}</div>
                </div>
                <div class="card pdf-avoid-break" style="padding:0.9rem; margin:0; background:#eff6ff; border:1px solid #bfdbfe;">
                    <div style="font-size:0.8rem; color:#1d4ed8;">Mejora estimada</div>
                    <div style="font-size:1.6rem; font-weight:800; color:#1d4ed8;">${savingPct.toFixed(2)}%</div>
                </div>
            </div>

            <div class="card pdf-avoid-break" style="padding:0.9rem; margin:0; border:1px solid #e2e8f0; background:#ffffff;">
                <div style="font-size:0.82rem; text-transform:uppercase; letter-spacing:0.06em; color:#64748b; margin-bottom:0.35rem;">Resumen ejecutivo</div>
                <p style="margin:0; color:#334155;">Esta propuesta compara la factura actual con una nueva oferta de precios y muestra el ahorro estimado.</p>
            </div>
        </section>
    `;
}

function openComparisonTransparencyModal(invoiceIdx, commercializerIdx, scopeMode = 'single') {
    const baseInv = compareBaseInvoice || invoices[invoiceIdx];
    const comm = commercializers[commercializerIdx];
    if (!baseInv || !comm) {
        alert('No se pudo abrir el informe transparente de comparativa.');
        return;
    }

    const targets = getCompareInvoicesByScope(baseInv, scopeMode);
    if (targets.length === 0) {
        alert('No hay facturas para construir el informe de comparativa.');
        return;
    }

    const modal = document.getElementById('comparison-transparency-modal');
    const body = document.getElementById('comparison-transparency-body');
    if (!modal || !body) return;

    const simulations = targets.map(inv => buildInvoiceTransparencySimulation(inv, comm));

    const totals = simulations.reduce((acc, s) => {
        acc.oldEnergy += s.oldEnergyReference;
        acc.newEnergy += s.newEnergy;
        acc.oldPower += s.oldPowerReference;
        acc.newPower += s.newPower;
        acc.oldTotal += s.oldTotal;
        acc.newTotal += s.newTotal;
        return acc;
    }, { oldEnergy: 0, newEnergy: 0, oldPower: 0, newPower: 0, oldTotal: 0, newTotal: 0 });

    const currentCommercializers = [...new Set(simulations.map(s => String(s.currentCommercializer || 'N/D').trim()).filter(Boolean))];
    const currentCommercializerLabel = currentCommercializers.length > 0 ? currentCommercializers.join(' | ') : 'N/D';

    const involvedSuppliesRows = simulations.map(s => `
        <tr>
            <td>${s.invoiceNum}</td>
            <td>${getShortSupplyAddress(s.supplyAddress)}</td>
            <td>${s.cups}</td>
            <td>${formatBillingPeriod(s.period)}</td>
            <td>${s.tariffType}</td>
            <td>${s.currentCommercializer || 'N/D'}</td>
            <td>${comm.name}</td>
            <td>${formatCurrency(s.oldTotal)}</td>
        </tr>
    `).join('');

    const involvedSuppliesCard = scopeMode === 'client-tariff' ? `
        <div class="card pdf-avoid-break" style="padding:0.85rem; margin-bottom:1rem; border:1px solid #e5e7eb;">
            <h3 style="margin-bottom:0.5rem;">Suministros implicados en el informe multipunto</h3>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr><th>Factura</th><th>Suministro</th><th>CUPS</th><th>Periodo</th><th>Tarifa</th><th>Comercializadora actual</th><th>Comercializadora propuesta</th><th>Total actual</th></tr>
                    </thead>
                    <tbody>
                        ${involvedSuppliesRows || '<tr><td colspan="8">No hay suministros implicados.</td></tr>'}
                        <tr style="font-weight:700; background:#f8fafc;"><td colspan="7" style="text-align:right;">Total actual agregado</td><td>${formatCurrency(totals.oldTotal)}</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
    ` : '';

    const blocks = simulations.map((s, idx) => {
        const energyRowsHtml = s.energyRows.map(r => `
            <tr>
                <td>P${r.period}</td>
                <td>${r.kwh.toFixed(2)} kWh</td>
                <td>${r.oldUnit.toFixed(6)} €/kWh</td>
                <td>${r.newUnit.toFixed(6)} €/kWh</td>
                <td>${r.tollUnit.toFixed(6)} €/kWh</td>
                <td>${formatCurrency(r.oldTotalAmount)}</td>
                <td>${formatCurrency(r.newTotalAmount)}</td>
                <td style="font-weight:700; color:${r.delta >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.delta)}</td>
            </tr>
        `).join('');

        const powerRowsHtml = s.powerRows.map(r => `
            <tr>
                <td>P${r.period}</td>
                <td>${r.kw.toFixed(2)} kW</td>
                <td>${r.days}</td>
                <td>${r.oldUnit.toFixed(6)} €/kW/dia</td>
                <td>${r.newUnit.toFixed(6)} €/kW/dia</td>
                <td>${formatCurrency(r.oldAmount)}</td>
                <td>${formatCurrency(r.newAmount)}</td>
                <td style="font-weight:700; color:${r.delta >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.delta)}</td>
            </tr>
        `).join('');

        const blockClass = idx === 0 ? 'pdf-avoid-break' : 'pdf-break-before';
        return `
            <div class="card ${blockClass}" style="padding:1rem; margin-bottom:1rem; border:1px solid #dbeafe;">
                <h3 style="margin-bottom:0.5rem;">Factura ${s.invoiceNum}</h3>
                <p style="margin:0 0 0.65rem; color:#334155;"><strong>Cliente:</strong> ${s.clientName} | <strong>Suministro:</strong> ${getShortSupplyAddress(s.supplyAddress)}<br><strong>Periodo:</strong> ${formatBillingPeriod(s.period)} | <strong>Tarifa:</strong> ${s.tariffType} | <strong>CUPS:</strong> ${s.cups}</p>

                <h4 style="margin:0.75rem 0 0.5rem;">1) Energia por periodos</h4>
                <div style="overflow-x:auto; margin-bottom:0.75rem;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Periodo</th><th>Consumo</th><th>Energia antes</th><th>Energia despues</th><th>Peajes/cargos</th><th>Total antes</th><th>Total despues</th><th>Diferencia</th></tr>
                        </thead>
                        <tbody>
                            ${energyRowsHtml || '<tr><td colspan="8">No hay periodos de energia disponibles.</td></tr>'}
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Subtotal energia comercializada</td><td>${formatCurrency(s.oldCommodityEnergy)}</td><td>${formatCurrency(s.newCommodityEnergy)}</td><td style="color:${(s.oldCommodityEnergy - s.newCommodityEnergy) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.oldCommodityEnergy - s.newCommodityEnergy)}</td></tr>
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Subtotal peajes/cargos energia</td><td>${formatCurrency(s.tollEnergyCost)}</td><td>${formatCurrency(s.tollEnergyCost)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Total energia facturada</td><td>${formatCurrency(s.oldEnergyReference)}</td><td>${formatCurrency(s.newEnergy)}</td><td style="color:${s.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.energySaving)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <h4 style="margin:0.75rem 0 0.5rem;">2) Potencia por periodos</h4>
                <div style="overflow-x:auto; margin-bottom:0.75rem;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Periodo</th><th>Potencia</th><th>Dias</th><th>Precio antes</th><th>Precio despues</th><th>Coste antes</th><th>Coste despues</th><th>Impacto</th></tr>
                        </thead>
                        <tbody>
                            ${powerRowsHtml || '<tr><td colspan="8">No hay periodos de potencia extraidos; se mantiene el coste original de potencia.</td></tr>'}
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="6" style="text-align:right;">Total potencia</td><td>${formatCurrency(s.newPower)}</td><td style="color:${s.powerImpact >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.powerImpact)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <h4 style="margin:0.75rem 0 0.5rem;">3) Factura completa simulada (transparente)</h4>
                <div style="overflow-x:auto;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Concepto</th><th>Antes</th><th>Despues</th><th>Diferencia</th></tr>
                        </thead>
                        <tbody>
                            <tr><td>Energia comercializada</td><td>${formatCurrency(s.oldCommodityEnergy)}</td><td>${formatCurrency(s.newCommodityEnergy)}</td><td style="color:${(s.oldCommodityEnergy - s.newCommodityEnergy) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.oldCommodityEnergy - s.newCommodityEnergy)}</td></tr>
                            <tr><td>Peajes/cargos energia</td><td>${formatCurrency(s.tollEnergyCost)}</td><td>${formatCurrency(s.tollEnergyCost)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Energia total facturada</td><td>${formatCurrency(s.oldEnergyReference)}</td><td>${formatCurrency(s.newEnergy)}</td><td style="color:${s.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.energySaving)}</td></tr>
                            <tr><td>Potencia</td><td>${formatCurrency(s.oldPowerReference)}</td><td>${formatCurrency(s.newPower)}</td><td style="color:${s.powerImpact >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.powerImpact)}</td></tr>
                            <tr><td>Otros conceptos</td><td>${formatCurrency(s.others)}</td><td>${formatCurrency(s.others)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Alquiler</td><td>${formatCurrency(s.alquiler)}</td><td>${formatCurrency(s.alquiler)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Reactiva</td><td>${formatCurrency(s.reactive)}</td><td>${formatCurrency(s.reactive)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Impuesto electrico (IEE)</td><td>${formatCurrency(s.oldIee)}</td><td>${formatCurrency(s.newIee)}</td><td>${formatCurrency(s.oldIee - s.newIee)}</td></tr>
                            <tr><td>${s.taxName} (${(s.taxRate * 100).toFixed(2)}%)</td><td>${formatCurrency(s.oldTaxAmount)}</td><td>${formatCurrency(s.newTaxAmount)}</td><td>${formatCurrency(s.oldTaxAmount - s.newTaxAmount)}</td></tr>
                            <tr style="font-weight:700; background:#eef2ff;"><td>Total factura</td><td>${formatCurrency(s.oldTotal)}</td><td>${formatCurrency(s.newTotal)}</td><td style="color:${s.totalSaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.totalSaving)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <h4 style="margin:0.75rem 0 0.5rem;">4) Como se ha calculado esta nueva factura</h4>
                <div style="overflow-x:auto;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Bloque</th><th>Criterio aplicado</th><th>Calculo</th></tr>
                        </thead>
                        <tbody>
                            <tr>
                                <td>Base original</td>
                                <td>Se toma la factura ya analizada del cliente como referencia.</td>
                                <td>Energia original = ${formatCurrency(s.oldEnergyReference)} | Potencia original = ${formatCurrency(s.oldPowerReference)} | Otros fijos = ${formatCurrency(s.others + s.alquiler + s.reactive)}</td>
                            </tr>
                            <tr>
                                <td>Energia nueva</td>
                                <td>Se sustituyen solo los precios de energia por periodo; los peajes/cargos extraidos se mantienen.</td>
                                <td>Energia nueva = Energia comercializada nueva ${formatCurrency(s.newCommodityEnergy)} + parte fija energia ${formatCurrency(s.tollEnergyCost)} = ${formatCurrency(s.newEnergy)}</td>
                            </tr>
                            <tr>
                                <td>Potencia nueva</td>
                                <td>Se recalculan los periodos de potencia con los nuevos precios configurados; lo no variable queda preservado.</td>
                                <td>Potencia nueva = ${formatCurrency(s.newPower)}</td>
                            </tr>
                            <tr>
                                <td>Base imponible nueva</td>
                                <td>Se mantiene el resto de conceptos exactamente igual.</td>
                                <td>Nueva base = Energia ${formatCurrency(s.newEnergy)} + Potencia ${formatCurrency(s.newPower)} + Otros ${formatCurrency(s.others)} + Alquiler ${formatCurrency(s.alquiler)} + Reactiva ${formatCurrency(s.reactive)} = ${formatCurrency(s.newSubtotalBase)}</td>
                            </tr>
                            <tr>
                                <td>Impuestos</td>
                                <td>Se recalculan sobre la nueva base imponible.</td>
                                <td>IEE nuevo = ${formatCurrency(s.newIee)} | ${s.taxName} nuevo = ${formatCurrency(s.newTaxAmount)} | Total nuevo = ${formatCurrency(s.newTotal)}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');

    const scopeLabel = scopeMode === 'client-tariff' ? 'Multisuministro / Multipunto (mismo cliente y tarifa)' : 'Suministro individual';
    body.innerHTML = `
        ${buildReportCoverHtml({
            scopeLabel,
            currentCommercializerLabel,
            proposedCommercializer: comm.name,
            totals,
            simulations
        })}
        <div class="card pdf-avoid-break" style="padding:0.85rem; margin-bottom:1rem; border:1px solid #e5e7eb;">
            <h3 style="margin-bottom:0.5rem;">Reglas de transparencia del calculo</h3>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr><th>Elemento</th><th>Tratamiento en la simulacion</th></tr>
                    </thead>
                    <tbody>
                        <tr><td>Factura base</td><td>Se usa la factura original ya analizada en el detalle del cliente.</td></tr>
                        <tr><td>Energia</td><td>Se recalcula con los nuevos precios por periodo aplicados al mismo consumo extraido.</td></tr>
                        <tr><td>Potencia</td><td>Se recalcula con los nuevos precios por periodo sobre la misma potencia y mismos dias.</td></tr>
                        <tr><td>Peajes/cargos de energia</td><td>Se conservan como parte fija de la energia ya extraida de la factura.</td></tr>
                        <tr><td>Otros conceptos, alquiler y reactiva</td><td>Se mantienen exactamente iguales a la factura original.</td></tr>
                        <tr><td>IEE e IVA/IGIC</td><td>Se recalculan automaticamente sobre la nueva base imponible.</td></tr>
                    </tbody>
                </table>
            </div>
        </div>
        ${involvedSuppliesCard}
        ${blocks}
    `;

    modalGuardUntil.compareTransparency = Date.now() + 250;
    modal.classList.remove('hidden');
}

function closeComparisonTransparencyModal() {
    const modal = document.getElementById('comparison-transparency-modal');
    if (modal) modal.classList.add('hidden');
}

function openComparisonTransparencyPrintView() {
    const source = document.getElementById('comparison-transparency-body');
    if (!source || !String(source.innerHTML || '').trim()) {
        alert('No hay contenido de informe para imprimir.');
        return;
    }

    const printWindow = window.open('', '_blank', 'noopener,noreferrer');
    if (!printWindow) {
        alert('El navegador bloqueo la ventana emergente. Permite popups para abrir la vista de impresion.');
        return;
    }

    const logoUrl = `${window.location.origin}/logo.png`;
    const reportHtml = String(source.innerHTML || '').replace(/src="logo\.png"/g, `src="${logoUrl}"`);

    printWindow.document.open();
    printWindow.document.write(`
<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Informe Transparente</title>
    <style>
        @page {
            size: A4;
            margin: 12mm;
        }
        * {
            box-sizing: border-box;
        }
        body {
            margin: 0;
            color: #0f172a;
            background: #ffffff;
            font-family: "Segoe UI", Tahoma, Arial, sans-serif;
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
        }
        .print-wrap {
            width: 100%;
        }
        .card {
            border: 1px solid #dbe3ef;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 10px;
            page-break-inside: avoid;
            break-inside: avoid-page;
            overflow: visible;
        }
        h2, h3, h4, p {
            margin-top: 0;
            page-break-after: avoid;
            break-after: avoid-page;
        }
        .modal-table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
            margin-top: 6px;
        }
        .modal-table th,
        .modal-table td {
            border: 1px solid #dbe3ef;
            padding: 6px;
            font-size: 11px;
            line-height: 1.35;
            vertical-align: top;
            white-space: normal;
            word-break: break-word;
            overflow-wrap: anywhere;
        }
        .modal-table thead th {
            background: #f8fafc;
        }
        img {
            max-width: 100%;
            height: auto;
        }
    </style>
</head>
<body>
    <div class="print-wrap">${reportHtml}</div>
</body>
</html>
    `);
    printWindow.document.close();
}

async function downloadComparisonTransparencyHtml() {
    const source = document.getElementById('comparison-transparency-body');
    if (!source || !String(source.innerHTML || '').trim()) {
        alert('No hay contenido de informe para exportar.');
        return;
    }

    const clientNameMatch = String(source.innerHTML || '').match(/<strong>Cliente:<\/strong>\s*([^<\n]+)/i);
    const clientName = (clientNameMatch ? clientNameMatch[1] : '').trim() || 'cliente';
    const safeClientName = clientName
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-zA-Z0-9\-_\s]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .toLowerCase() || 'cliente';

    let logoSrc = `${window.location.origin}/logo.png`;
    try {
        const resp = await fetch(logoSrc);
        if (resp.ok) {
            const blob = await resp.blob();
            logoSrc = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => resolve(logoSrc);
                reader.readAsDataURL(blob);
            });
        }
    } catch (err) {
        console.warn('[HTML] No se pudo embebir el logo, se usara URL absoluta:', err);
    }

    const reportHtml = String(source.innerHTML || '')
        .replace(/src="logo\.png"/g, `src="${logoSrc}"`)
        .replace(/src="\/logo\.png"/g, `src="${logoSrc}"`);

    const exportHtml = `<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Propuesta de Mejora de Precios - ${clientName}</title>
    <style>
        * { box-sizing: border-box; }
        body {
            margin: 0;
            padding: 18px;
            color: #0f172a;
            background: #ffffff;
            font-family: "Segoe UI", Tahoma, Arial, sans-serif;
        }
        .card {
            border: 1px solid #dbe3ef;
            border-radius: 8px;
            padding: 10px;
            margin-bottom: 10px;
            overflow: visible;
        }
        .modal-table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        .modal-table th,
        .modal-table td {
            border: 1px solid #dbe3ef;
            padding: 7px;
            font-size: 12px;
            line-height: 1.35;
            vertical-align: top;
            white-space: normal;
            word-break: break-word;
            overflow-wrap: anywhere;
        }
        .modal-table thead th {
            background: #f8fafc;
        }
        img { max-width: 100%; height: auto; }
    </style>
</head>
<body>
    ${reportHtml}
</body>
</html>`;

    const ts = new Date();
    const safeDate = `${String(ts.getDate()).padStart(2, '0')}-${String(ts.getMonth() + 1).padStart(2, '0')}-${ts.getFullYear()}`;
    const filename = `propuesta-${safeClientName}-${safeDate}.html`;

    const blob = new Blob([exportHtml], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function downloadComparisonTransparencyPdf() {
    const source = document.getElementById('comparison-transparency-body');
    if (!source || !String(source.innerHTML || '').trim()) {
        alert('No hay contenido de informe para exportar.');
        return;
    }

    if (typeof window.html2pdf !== 'function') {
        alert('No se ha podido cargar el motor de PDF (html2pdf). Recarga la pagina e intenta de nuevo.');
        return;
    }

    const exportNode = source.cloneNode(true);
    exportNode.classList.add('pdf-report-root');
    exportNode.style.background = '#ffffff';
    exportNode.style.padding = '10px';
    exportNode.style.width = '740px';

    // Forzar logo absoluto para evitar fallos de resolución al exportar fuera del modal.
    const logoImg = exportNode.querySelector('img[alt="Logo ECE Consultores"]');
    if (logoImg) {
        logoImg.setAttribute('src', `${window.location.origin}/logo.png`);
        logoImg.setAttribute('crossorigin', 'anonymous');
    }

    const style = document.createElement('style');
    style.textContent = `
        .pdf-report-root { color: #0f172a; }
        .pdf-report-root .modal-table {
            width: 100%;
            table-layout: fixed;
            border-collapse: collapse;
        }
        .pdf-report-root .modal-table th,
        .pdf-report-root .modal-table td {
            white-space: normal;
            word-break: break-word;
            overflow-wrap: anywhere;
            vertical-align: top;
        }
        .pdf-report-root .pdf-avoid-break,
        .pdf-report-root table,
        .pdf-report-root tr,
        .pdf-report-root h3,
        .pdf-report-root h4,
        .pdf-report-root p {
            break-inside: avoid;
            page-break-inside: avoid;
        }
        .pdf-report-root .pdf-break-before {
            break-before: page;
            page-break-before: always;
        }
    `;
    exportNode.prepend(style);

    const tempContainer = document.createElement('div');
    tempContainer.style.position = 'fixed';
    tempContainer.style.left = '-20000px';
    tempContainer.style.top = '0';
    tempContainer.style.width = '740px';
    tempContainer.style.background = '#ffffff';
    tempContainer.appendChild(exportNode);
    document.body.appendChild(tempContainer);

    const images = Array.from(exportNode.querySelectorAll('img'));
    await Promise.all(images.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
            img.onload = () => resolve();
            img.onerror = () => resolve();
        });
    }));

    const ts = new Date();
    const safeDate = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
    const filename = `informe-transparente-${safeDate}.pdf`;

    const options = {
        margin: [8, 8, 8, 8],
        filename,
        image: { type: 'jpeg', quality: 0.98 },
        html2canvas: { scale: 1.6, useCORS: true, backgroundColor: '#ffffff', scrollY: 0 },
        jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
        pagebreak: {
            mode: ['css', 'legacy'],
            before: '.pdf-break-before',
            avoid: '.pdf-avoid-break, table, tr'
        }
    };

    try {
        await window.html2pdf().set(options).from(exportNode).save();
    } catch (err) {
        console.error('[PDF] Error exportando informe transparente:', err);
        alert('No se pudo generar el PDF. Revisa consola y vuelve a intentarlo.');
    } finally {
        if (tempContainer.parentNode) tempContainer.parentNode.removeChild(tempContainer);
    }
}

function renderProposals() {
    const list = document.getElementById('proposals-list');
    if (!list) return;

    const filterClientEl = document.getElementById('proposals-filter-client');
    const filterStatusEl = document.getElementById('proposals-filter-status');
    const filterTariffEl = document.getElementById('proposals-filter-tariff');
    const filterComEl = document.getElementById('proposals-filter-commercializer');

    const q = String(filterClientEl?.value || '').trim().toLowerCase();
    const selectedStatus = filterStatusEl?.value || '';
    const selectedTariff = filterTariffEl?.value || '';
    const selectedCom = filterComEl?.value || '';

    if (filterStatusEl) {
        const opts = getProposalStatusOptions();
        filterStatusEl.innerHTML = '<option value="">Todos los estados</option>' + opts.map(v => `<option value="${v}">${v}</option>`).join('');
        if (opts.includes(selectedStatus)) filterStatusEl.value = selectedStatus;
    }

    if (filterTariffEl) {
        const tariffs = [...new Set(proposalsLog.map(p => String(p.tariffType || '').trim()).filter(Boolean))]
            .sort((a, b) => sortTariffValue(a) - sortTariffValue(b));
        filterTariffEl.innerHTML = '<option value="">Todas las tarifas</option>' + tariffs.map(v => `<option value="${v}">${v}</option>`).join('');
        if (tariffs.includes(selectedTariff)) filterTariffEl.value = selectedTariff;
    }

    if (filterComEl) {
        const comms = [...new Set(proposalsLog.map(p => String(p.proposedCommercializer || '').trim()).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
        filterComEl.innerHTML = '<option value="">Todas las propuestas</option>' + comms.map(v => `<option value="${v}">${v}</option>`).join('');
        if (comms.includes(selectedCom)) filterComEl.value = selectedCom;
    }

    const activeStatus = filterStatusEl?.value || '';
    const activeTariff = filterTariffEl?.value || '';
    const activeCom = filterComEl?.value || '';

    const filtered = proposalsLog
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .filter(p => {
            const text = `${p.clientName || ''} ${p.cups || ''} ${p.invoiceNum || ''}`.toLowerCase();
            const matchText = !q || text.includes(q);
            const matchStatus = !activeStatus || p.status === activeStatus;
            const matchTariff = !activeTariff || p.tariffType === activeTariff;
            const matchCom = !activeCom || p.proposedCommercializer === activeCom;
            return matchText && matchStatus && matchTariff && matchCom;
        });

    // Agrupar informes conjuntos (multisuministro) por batchId para no mostrar filas sueltas.
    const displayRows = [];
    const groupedByBatch = new Map();
    filtered.forEach(p => {
        const isJoint = p.scope === 'client-tariff' && p.batchId;
        if (!isJoint) {
            displayRows.push({ ...p, _displayType: 'single' });
            return;
        }

        const key = String(p.batchId);
        if (!groupedByBatch.has(key)) {
            groupedByBatch.set(key, {
                ...p,
                _displayType: 'batch',
                _displayId: `batch:${key}`,
                _supplyCount: Number(p.batchSupplyCount || 0) || 1,
                _energySavingAgg: Number(p.energySaving || 0),
                _simulatedTotalAgg: Number(p.simulatedTotal || 0),
                _cupsSet: new Set([String(p.cups || '').trim()])
            });
            displayRows.push(groupedByBatch.get(key));
        } else {
            const g = groupedByBatch.get(key);
            g._energySavingAgg += Number(p.energySaving || 0);
            g._simulatedTotalAgg += Number(p.simulatedTotal || 0);
            g._cupsSet.add(String(p.cups || '').trim());
            g._supplyCount = Math.max(g._supplyCount, g._cupsSet.size, Number(p.batchSupplyCount || 0) || 1);
        }
    });

    if (displayRows.length === 0) {
        list.innerHTML = '<div class="card" style="padding:1rem;">No hay propuestas registradas con esos filtros.</div>';
        return;
    }

    const rows = displayRows.map(p => {
        const rowId = p._displayType === 'batch'
            ? `batch:${p.batchId}`
            : `proposal:${p.proposalId}`;
        const statusOptions = getProposalStatusOptions().map(v => `<option value="${v}" ${p.status === v ? 'selected' : ''}>${v}</option>`).join('');
        const informeLabel = p._displayType === 'batch'
            ? `Conjunto (${p._supplyCount} suministro${p._supplyCount > 1 ? 's' : ''})`
            : 'Individual';
        const cupsLabel = p._displayType === 'batch'
            ? `${p._supplyCount} CUPS`
            : (p.cups || 'N/D');
        const energySavingValue = p._displayType === 'batch' ? p._energySavingAgg : Number(p.energySaving || 0);
        const simulatedTotalValue = p._displayType === 'batch' ? p._simulatedTotalAgg : Number(p.simulatedTotal || 0);
        return `
            <tr>
                <td>${new Date(p.createdAt).toLocaleDateString('es-ES')}</td>
                <td>${p.clientName || 'N/D'}</td>
                <td>${cupsLabel}</td>
                <td>${p.tariffType || 'N/D'}</td>
                <td>${informeLabel}</td>
                <td>${p.currentCommercializer || 'N/D'}</td>
                <td>${p.proposedCommercializer || 'N/D'}</td>
                <td>${formatCurrency(energySavingValue)}</td>
                <td>${formatCurrency(simulatedTotalValue)}</td>
                <td>
                    <select onchange="updateProposalStatus('${rowId}', this.value)" style="padding:0.35rem; border:1px solid #d1d5db; border-radius:6px;">
                        ${statusOptions}
                    </select>
                </td>
                <td>
                    <button class="btn secondary btn-sm" onclick="openStoredProposalReport('${rowId}')">Ver informe</button>
                    <button class="btn secondary btn-sm" onclick="deleteProposalEntry('${rowId}')" style="margin-left:0.35rem; background-color:#ef4444; color:#fff;">Eliminar</button>
                </td>
            </tr>
        `;
    }).join('');

    list.innerHTML = `
        <div class="card" style="padding:1rem;">
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr>
                            <th>Fecha</th>
                            <th>Cliente</th>
                            <th>CUPS</th>
                            <th>Tarifa</th>
                            <th>Informe</th>
                            <th>Actual</th>
                            <th>Propuesta</th>
                            <th>Ahorro energia</th>
                            <th>Factura simulada</th>
                            <th>Estado</th>
                            <th>Acciones</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
    `;
}

function updateProposalStatus(proposalRef, status) {
    const ref = String(proposalRef || '');
    const now = new Date().toISOString();

    if (ref.startsWith('batch:')) {
        const batchId = ref.replace('batch:', '');
        let changed = 0;
        proposalsLog.forEach(p => {
            if (String(p.batchId || '') === batchId) {
                p.status = status;
                p.updatedAt = now;
                changed += 1;
            }
        });
        if (changed === 0) return;
    } else {
        const proposalId = ref.replace('proposal:', '');
        const idx = proposalsLog.findIndex(p => p.proposalId === proposalId);
        if (idx < 0) return;
        proposalsLog[idx].status = status;
        proposalsLog[idx].updatedAt = now;
    }

    saveProposalsLog();
    renderProposals();
}

function getProposalEntriesByRef(proposalRef) {
    const ref = String(proposalRef || '');
    if (ref.startsWith('batch:')) {
        const batchId = ref.replace('batch:', '');
        return proposalsLog.filter(p => String(p.batchId || '') === batchId);
    }

    const proposalId = ref.replace('proposal:', '');
    const single = proposalsLog.find(p => p.proposalId === proposalId);
    return single ? [single] : [];
}

function removeSupplyProposalByLogEntry(entry) {
    const key = buildSupplyKey({
        clientName: entry.clientName,
        cups: entry.cups,
        tariffType: entry.tariffType,
        supplyAddress: entry.supplyAddress
    });
    if (supplyProposals[key]) {
        delete supplyProposals[key];
        return true;
    }
    return false;
}

function deleteProposalEntry(proposalRef) {
    const entries = getProposalEntriesByRef(proposalRef);
    if (!entries.length) return;

    const isBatch = String(proposalRef || '').startsWith('batch:');
    const msg = isBatch
        ? `¿Eliminar este informe conjunto y sus ${entries.length} propuestas asociadas?`
        : '¿Eliminar esta propuesta del historial?';
    if (!confirm(msg)) return;

    const idsToRemove = new Set(entries.map(e => String(e.proposalId || '')));
    proposalsLog = proposalsLog.filter(p => !idsToRemove.has(String(p.proposalId || '')));

    let removedSupplyRefs = 0;
    entries.forEach(e => {
        if (removeSupplyProposalByLogEntry(e)) removedSupplyRefs += 1;
    });

    saveProposalsLog();
    saveSupplyProposals();
    renderProposals();
    renderClients();

    console.log('[Proposals] Eliminadas propuestas:', idsToRemove.size, 'refs suministro eliminadas:', removedSupplyRefs);
}

function openStoredProposalReport(proposalRef) {
    const entries = getProposalEntriesByRef(proposalRef);
    if (!entries.length) {
        alert('No se encontró el informe asociado a esta propuesta.');
        return;
    }

    const first = entries[0];
    const isBatch = entries.length > 1;
    const energySaving = entries.reduce((sum, e) => sum + Number(e.energySaving || 0), 0);
    const simulatedTotal = entries.reduce((sum, e) => sum + Number(e.simulatedTotal || 0), 0);
    const oldTotal = entries.reduce((sum, e) => sum + Number(e.oldTotal || 0), 0);

    let regeneratedCount = 0;
    const detailedBlocks = entries.map((e, idx) => {
        const rebuilt = rebuildProposalSnapshotIfMissing(e);
        const s = rebuilt.snapshot;
        if (rebuilt.regenerated) regeneratedCount += 1;
        if (!s) {
            return `
                <div class="card ${idx === 0 ? 'pdf-avoid-break' : 'pdf-break-before'}" style="padding:1rem; margin-bottom:1rem; border:1px solid #dbeafe;">
                    <h3 style="margin-bottom:0.5rem;">Factura ${e.invoiceNum || 'S/N'}</h3>
                    <p style="margin:0; color:#64748b;">No hay snapshot detallado para esta propuesta. Se muestra resumen.</p>
                </div>
            `;
        }

        const energyRowsHtml = (s.energyRows || []).map(r => `
            <tr>
                <td>P${r.period}</td>
                <td>${Number(r.kwh || 0).toFixed(2)} kWh</td>
                <td>${Number(r.oldUnit || 0).toFixed(6)} €/kWh</td>
                <td>${Number(r.newUnit || 0).toFixed(6)} €/kWh</td>
                <td>${Number(r.tollUnit || 0).toFixed(6)} €/kWh</td>
                <td>${formatCurrency(r.oldTotalAmount || 0)}</td>
                <td>${formatCurrency(r.newTotalAmount || 0)}</td>
                <td style="font-weight:700; color:${Number(r.delta || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.delta || 0)}</td>
            </tr>
        `).join('');

        const powerRowsHtml = (s.powerRows || []).map(r => `
            <tr>
                <td>P${r.period}</td>
                <td>${Number(r.kw || 0).toFixed(2)} kW</td>
                <td>${Number(r.days || 0)}</td>
                <td>${Number(r.oldUnit || 0).toFixed(6)} €/kW/dia</td>
                <td>${Number(r.newUnit || 0).toFixed(6)} €/kW/dia</td>
                <td>${formatCurrency(r.oldAmount || 0)}</td>
                <td>${formatCurrency(r.newAmount || 0)}</td>
                <td style="font-weight:700; color:${Number(r.delta || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.delta || 0)}</td>
            </tr>
        `).join('');

        const blockClass = idx === 0 ? 'pdf-avoid-break' : 'pdf-break-before';
        return `
            <div class="card ${blockClass}" style="padding:1rem; margin-bottom:1rem; border:1px solid #dbeafe;">
                <h3 style="margin-bottom:0.5rem;">Factura ${e.invoiceNum || 'S/N'}</h3>
                <p style="margin:0 0 0.65rem; color:#334155;"><strong>Cliente:</strong> ${e.clientName || 'N/D'} | <strong>Suministro:</strong> ${getShortSupplyAddress(e.supplyAddress || 'N/D')}<br><strong>Tarifa:</strong> ${e.tariffType || 'N/D'} | <strong>CUPS:</strong> ${e.cups || 'N/D'}</p>

                <h4 style="margin:0.75rem 0 0.5rem;">1) Energia por periodos</h4>
                <div style="overflow-x:auto; margin-bottom:0.75rem;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Periodo</th><th>Consumo</th><th>Energia antes</th><th>Energia despues</th><th>Peajes/cargos</th><th>Total antes</th><th>Total despues</th><th>Diferencia</th></tr>
                        </thead>
                        <tbody>
                            ${energyRowsHtml || '<tr><td colspan="8">No hay periodos de energia disponibles.</td></tr>'}
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Subtotal energia comercializada</td><td>${formatCurrency(s.oldCommodityEnergy || 0)}</td><td>${formatCurrency(s.newCommodityEnergy || 0)}</td><td style="color:${(Number(s.oldCommodityEnergy || 0) - Number(s.newCommodityEnergy || 0)) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency((Number(s.oldCommodityEnergy || 0) - Number(s.newCommodityEnergy || 0)))}</td></tr>
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Subtotal peajes/cargos energia</td><td>${formatCurrency(s.tollEnergyCost || 0)}</td><td>${formatCurrency(s.tollEnergyCost || 0)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="5" style="text-align:right;">Total energia facturada</td><td>${formatCurrency(s.oldEnergyReference || 0)}</td><td>${formatCurrency(s.newEnergy || 0)}</td><td style="color:${Number(s.energySaving || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.energySaving || 0)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <h4 style="margin:0.75rem 0 0.5rem;">2) Potencia por periodos</h4>
                <div style="overflow-x:auto; margin-bottom:0.75rem;">
                    <table class="modal-table">
                        <thead>
                            <tr><th>Periodo</th><th>Potencia</th><th>Dias</th><th>Precio antes</th><th>Precio despues</th><th>Coste antes</th><th>Coste despues</th><th>Impacto</th></tr>
                        </thead>
                        <tbody>
                            ${powerRowsHtml || '<tr><td colspan="8">No hay periodos de potencia disponibles.</td></tr>'}
                            <tr style="font-weight:700; background:#f8fafc;"><td colspan="6" style="text-align:right;">Total potencia</td><td>${formatCurrency(s.newPower || 0)}</td><td style="color:${Number(s.powerImpact || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.powerImpact || 0)}</td></tr>
                        </tbody>
                    </table>
                </div>

                <h4 style="margin:0.75rem 0 0.5rem;">3) Factura completa simulada</h4>
                <div style="overflow-x:auto;">
                    <table class="modal-table">
                        <thead><tr><th>Concepto</th><th>Antes</th><th>Despues</th><th>Diferencia</th></tr></thead>
                        <tbody>
                            <tr><td>Energia comercializada</td><td>${formatCurrency(s.oldCommodityEnergy || 0)}</td><td>${formatCurrency(s.newCommodityEnergy || 0)}</td><td>${formatCurrency((Number(s.oldCommodityEnergy || 0) - Number(s.newCommodityEnergy || 0)))}</td></tr>
                            <tr><td>Peajes/cargos energia</td><td>${formatCurrency(s.tollEnergyCost || 0)}</td><td>${formatCurrency(s.tollEnergyCost || 0)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Energia total facturada</td><td>${formatCurrency(s.oldEnergyReference || 0)}</td><td>${formatCurrency(s.newEnergy || 0)}</td><td>${formatCurrency(s.energySaving || 0)}</td></tr>
                            <tr><td>Potencia</td><td>${formatCurrency(s.oldPowerReference || 0)}</td><td>${formatCurrency(s.newPower || 0)}</td><td>${formatCurrency(s.powerImpact || 0)}</td></tr>
                            <tr><td>Otros conceptos</td><td>${formatCurrency(s.others || 0)}</td><td>${formatCurrency(s.others || 0)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Alquiler</td><td>${formatCurrency(s.alquiler || 0)}</td><td>${formatCurrency(s.alquiler || 0)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Reactiva</td><td>${formatCurrency(s.reactive || 0)}</td><td>${formatCurrency(s.reactive || 0)}</td><td>${formatCurrency(0)}</td></tr>
                            <tr><td>Impuesto electrico (IEE)</td><td>${formatCurrency(s.oldIee || 0)}</td><td>${formatCurrency(s.newIee || 0)}</td><td>${formatCurrency((Number(s.oldIee || 0) - Number(s.newIee || 0)))}</td></tr>
                            <tr><td>${s.taxName || 'Impuesto'} (${(Number(s.taxRate || 0) * 100).toFixed(2)}%)</td><td>${formatCurrency(s.oldTaxAmount || 0)}</td><td>${formatCurrency(s.newTaxAmount || 0)}</td><td>${formatCurrency((Number(s.oldTaxAmount || 0) - Number(s.newTaxAmount || 0)))}</td></tr>
                            <tr style="font-weight:700; background:#eef2ff;"><td>Total factura</td><td>${formatCurrency(s.oldTotal || 0)}</td><td>${formatCurrency(s.newTotal || 0)}</td><td style="color:${Number(s.totalSaving || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(s.totalSaving || 0)}</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    }).join('');

    if (regeneratedCount > 0) {
        saveProposalsLog();
    }

    const rows = entries.map(e => `
        <tr>
            <td>${e.invoiceNum || 'S/N'}</td>
            <td>${e.cups || 'N/D'}</td>
            <td>${getShortSupplyAddress(e.supplyAddress || 'N/D')}</td>
            <td>${formatCurrency(e.oldTotal || 0)}</td>
            <td>${formatCurrency(e.simulatedTotal || 0)}</td>
            <td style="font-weight:700; color:${Number(e.totalSaving || 0) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(e.totalSaving || 0)}</td>
        </tr>
    `).join('');

    const modal = document.getElementById('comparison-transparency-modal');
    const body = document.getElementById('comparison-transparency-body');
    if (!modal || !body) {
        alert('No se pudo abrir el visor de informe.');
        return;
    }

    body.innerHTML = `
        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem;">
            <h3 style="margin:0 0 0.35rem;">Informe guardado ${isBatch ? 'conjunto' : 'individual'}</h3>
            <p style="margin:0 0 0.25rem;"><strong>Cliente:</strong> ${first.clientName || 'N/D'} | <strong>Tarifa:</strong> ${first.tariffType || 'N/D'}</p>
            <p style="margin:0 0 0.25rem;"><strong>Comercializadora actual:</strong> ${first.currentCommercializer || 'N/D'} | <strong>Propuesta:</strong> ${first.proposedCommercializer || 'N/D'}</p>
            <p style="margin:0;"><strong>Estado:</strong> ${first.status || 'propuesta'} | <strong>Fecha:</strong> ${new Date(first.createdAt).toLocaleString('es-ES')}</p>
        </div>

        <div style="display:grid; grid-template-columns:repeat(3,minmax(180px,1fr)); gap:0.65rem; margin-bottom:0.75rem;">
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Ahorro energía agregado</div><div style="font-size:1.1rem; font-weight:700; color:${energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(energySaving)}</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Total actual agregado</div><div style="font-size:1.1rem; font-weight:700;">${formatCurrency(oldTotal)}</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Total simulado agregado</div><div style="font-size:1.1rem; font-weight:700;">${formatCurrency(simulatedTotal)}</div></div>
        </div>

        <div class="card" style="padding:0.85rem; margin-bottom:0.75rem;">
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead><tr><th>Factura</th><th>CUPS</th><th>Suministro</th><th>Total antes</th><th>Total simulado</th><th>Ahorro total</th></tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>

        ${detailedBlocks}
    `;

    modalGuardUntil.compareTransparency = Date.now() + 250;
    modal.classList.remove('hidden');
}

function renderCompareSelectorList() {
    const list = document.getElementById('compare-selector-list');
    if (!list) return;

    const baseInv = compareBaseInvoice || invoices[compareCurrentInvoiceIndex];
    if (!baseInv) {
        list.innerHTML = '<p style="color:#999;">No hay factura base para comparar.</p>';
        return;
    }

    const compatibleCommercializers = commercializers
        .map((c, idx) => ({ c, idx }))
        .filter(item => !item.c.tariffType || baseInv.tariffType?.startsWith(String(item.c.tariffType).trim()));

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
    const inv = compareBaseInvoice || invoices[invoiceIdx];
    const comm = commercializers[commercializerIdx];
    if (!inv || !comm) return;

    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

    const compareInvoices = getCompareInvoices(inv);
    const metrics = computeComparisonMetrics(compareInvoices, comm);
    const scopeLabel = compareScope === 'client-tariff'
        ? `Multisuministro / Multipunto (${inv.clientName || 'Cliente'} | Tarifa ${inv.tariffType || 'N/D'})`
        : 'Suministro individual';

    const rowsHtml = metrics.invoiceRows.map(r => `
        <tr>
            <td>${r.invoiceNum}</td>
            <td>
                <div>${getShortSupplyAddress(r.supplyAddress)}</div>
                <small style="color:#64748b;">CUPS: ${r.cups}</small>
            </td>
            <td>${formatBillingPeriod(r.period)}</td>
            <td>${r.consumption.toFixed(2)} kWh</td>
            <td>${formatCurrency(r.oldEnergy)}</td>
            <td>${formatCurrency(r.proposedEnergy)}</td>
            <td style="font-weight:600; color:${r.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(r.energySaving)}</td>
            <td>${formatCurrency(r.oldTotal)}</td>
            <td>${formatCurrency(r.simulatedTotal)}</td>
        </tr>
    `).join('');

    const html = `
        ${buildReportHeaderHtml(`Comparativa con ${comm.name}`, scopeLabel)}
        <h3>Comparativa con ${comm.name}</h3>
        <p><strong>Cliente:</strong> ${inv.clientName || 'Desconocido'} | <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'} | <strong>Alcance:</strong> ${scopeLabel}</p>
        <div style="display:grid; grid-template-columns: repeat(4, minmax(180px, 1fr)); gap:0.75rem; margin:0.75rem 0 1rem;">
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Precio energia actual</div><div style="font-size:1.1rem; font-weight:700;">${metrics.oldAvgPrice.toFixed(6)} €/kWh</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Precio energia propuesta</div><div style="font-size:1.1rem; font-weight:700;">${metrics.newAvgPrice.toFixed(6)} €/kWh</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Ahorro energia</div><div style="font-size:1.1rem; font-weight:700; color:${metrics.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.energySaving)}</div></div>
            <div class="card" style="padding:0.75rem;"><div style="font-size:0.8rem; color:#64748b;">Factura simulada</div><div style="font-size:1.1rem; font-weight:700;">${formatCurrency(metrics.newTotalInvoiceSim)}</div></div>
        </div>
        <p style="color:#64748b; margin:0 0 0.75rem;">La vista rapida prioriza energia; usa "Ver informe transparente" para revisar tambien impacto de potencia, impuestos y total final antes/despues.</p>
        <div style="margin-bottom:0.75rem;">
            <button class="btn primary" onclick="applyCommercializerProposal(${invoiceIdx}, ${commercializerIdx}, '${compareScope}')">Aplicar propuesta: ${comm.name}</button>
            <button class="btn secondary" onclick="openComparisonTransparencyModal(${invoiceIdx}, ${commercializerIdx}, '${compareScope}')" style="margin-left:0.5rem;">Ver informe transparente</button>
        </div>
        <div style="overflow-x:auto;">
            <table class="modal-table">
                <thead><tr><th>Factura</th><th>Suministro</th><th>Periodo factura</th><th>Consumo</th><th>Energia antes</th><th>Energia despues</th><th>Ahorro energia</th><th>Total antes</th><th>Total simulado</th></tr></thead>
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
    const inv = compareBaseInvoice || invoices[invoiceIdx];
    if (!inv) return;

    const compareSection = document.getElementById('comparison-results');
    if (!compareSection) return;

    const compareInvoices = getCompareInvoices(inv);
    const scopeLabel = compareScope === 'client-tariff'
        ? `Multisuministro / Multipunto (${inv.clientName || 'Cliente'} | Tarifa ${inv.tariffType || 'N/D'})`
        : 'Suministro individual';
    const comms = commercializerIndices.map(idx => commercializers[idx]).filter(Boolean);

    const rankingRows = comms.map(c => {
        const m = computeComparisonMetrics(compareInvoices, c);
        const idx = commercializers.findIndex(x => x.id === c.id);
        return { comm: c, metrics: m, idx };
    }).sort((a, b) => b.metrics.energySaving - a.metrics.energySaving);

    const baselineBySupply = compareInvoices.map(item => {
        const allowedPeriods = getActivePeriodsByTariff(item.tariffType, item.energyPeriodItems || []);
        const energyItems = (item.energyPeriodItems || []).filter(p => allowedPeriods.includes(Number(p.period)));
        const consumption = energyItems.reduce((sum, p) => sum + Number(p.kwh || 0), 0);
        const energyCost = Number(item.energyCost || 0) > 0
            ? Number(item.energyCost || 0)
            : energyItems.reduce((sum, p) => sum + (Number(p.kwh || 0) * Number(p.unitPriceKwh || 0)), 0);
        const powerCost = Number(item.powerCost || 0);
        const total = Number(item.totalCalculated || 0);
        return {
            invoiceNum: item.invoiceNum || 'S/N',
            cups: item.cups || 'N/D',
            supplyAddress: item.supplyAddress || 'N/D',
            period: item.period || 'N/D',
            consumption,
            energyCost,
            powerCost,
            total
        };
    });

    const baselineTotals = baselineBySupply.reduce((acc, row) => {
        acc.consumption += row.consumption;
        acc.energy += row.energyCost;
        acc.power += row.powerCost;
        acc.total += row.total;
        return acc;
    }, { consumption: 0, energy: 0, power: 0, total: 0 });

    const baselineRowsHtml = baselineBySupply.map(row => `
        <tr>
            <td>${row.invoiceNum}</td>
            <td>
                <div>${getShortSupplyAddress(row.supplyAddress)}</div>
                <small style="color:#64748b;">CUPS: ${row.cups}</small>
            </td>
            <td>${formatBillingPeriod(row.period)}</td>
            <td>${row.consumption.toFixed(2)} kWh</td>
            <td>${formatCurrency(row.energyCost)}</td>
            <td>${formatCurrency(row.powerCost)}</td>
            <td>${formatCurrency(row.total)}</td>
        </tr>
    `).join('');

    const bestOption = rankingRows[0] || null;
    const bestScenarioBySupply = bestOption
        ? compareInvoices.map(item => buildInvoiceTransparencySimulation(item, bestOption.comm))
        : [];

    const bestTotals = bestScenarioBySupply.reduce((acc, row) => {
        acc.oldTotal += row.oldTotal;
        acc.newTotal += row.newTotal;
        acc.oldEnergy += row.oldEnergyReference;
        acc.newEnergy += row.newEnergy;
        acc.oldPower += row.oldPowerReference;
        acc.newPower += row.newPower;
        return acc;
    }, { oldTotal: 0, newTotal: 0, oldEnergy: 0, newEnergy: 0, oldPower: 0, newPower: 0 });

    const bestRowsHtml = bestScenarioBySupply.map(row => `
        <tr>
            <td>${row.invoiceNum}</td>
            <td>
                <div>${getShortSupplyAddress(row.supplyAddress)}</div>
                <small style="color:#64748b;">CUPS: ${row.cups}</small>
            </td>
            <td>${formatCurrency(row.oldEnergyReference)}</td>
            <td>${formatCurrency(row.newEnergy)}</td>
            <td style="color:${row.powerImpact >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(row.powerImpact)}</td>
            <td>${formatCurrency(row.oldTotal)}</td>
            <td>${formatCurrency(row.newTotal)}</td>
            <td style="font-weight:700; color:${row.totalSaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(row.totalSaving)}</td>
        </tr>
    `).join('');

    const rowsHtml = rankingRows.map(({ comm, metrics, idx }) => `
        <tr>
            <td><strong>${comm.name}</strong></td>
            <td>${(comm.tariffType || inv.tariffType || 'N/D')}</td>
            <td>${metrics.oldAvgPrice.toFixed(6)} €/kWh</td>
            <td>${metrics.newAvgPrice.toFixed(6)} €/kWh</td>
            <td style="font-weight:700; color:${metrics.energySaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.energySaving)}</td>
            <td>${formatCurrency(metrics.oldTotalInvoice)}</td>
            <td>${formatCurrency(metrics.newTotalInvoiceSim)}</td>
            <td style="font-weight:700; color:${metrics.totalSaving >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(metrics.totalSaving)}</td>
            <td>
                <button class="btn primary btn-sm" onclick="applyCommercializerProposal(${invoiceIdx}, ${idx}, '${compareScope}')">Aplicar</button>
                <button class="btn secondary btn-sm" onclick="openComparisonTransparencyModal(${invoiceIdx}, ${idx}, '${compareScope}')" style="margin-left:0.35rem;">Informe</button>
            </td>
        </tr>
    `).join('');

    const html = `
        ${buildReportHeaderHtml('Comparativa Multisuministro (Multipunto)', scopeLabel)}
        <h3>Comparativa Multisuministro (Multipunto) de Comercializadoras</h3>
        <p><strong>Cliente:</strong> ${inv.clientName || 'Desconocido'} | <strong>Tarifa:</strong> ${inv.tariffType || 'N/D'} | <strong>Alcance:</strong> ${scopeLabel}</p>
        <div class="card" style="padding:1rem; margin:0.75rem 0;">
            <h4 style="margin-bottom:0.5rem;">Resumen total actual del cliente (multipunto)</h4>
            <div style="display:grid; grid-template-columns: repeat(4, minmax(160px, 1fr)); gap:0.65rem;">
                <div><small style="color:#64748b;">Suministros</small><div style="font-weight:700;">${baselineBySupply.length}</div></div>
                <div><small style="color:#64748b;">Consumo total</small><div style="font-weight:700;">${baselineTotals.consumption.toFixed(2)} kWh</div></div>
                <div><small style="color:#64748b;">Coste energia</small><div style="font-weight:700;">${formatCurrency(baselineTotals.energy)}</div></div>
                <div><small style="color:#64748b;">Total factura agregado</small><div style="font-weight:700;">${formatCurrency(baselineTotals.total)}</div></div>
            </div>
        </div>

        <div class="card" style="padding:1rem; margin-bottom:0.75rem;">
            <h4 style="margin-bottom:0.5rem;">Detalle individual actual por suministro</h4>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr>
                            <th>Factura</th>
                            <th>Suministro</th>
                            <th>Periodo</th>
                            <th>Consumo</th>
                            <th>Energia actual</th>
                            <th>Potencia actual</th>
                            <th>Total actual</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${baselineRowsHtml || '<tr><td colspan="7">No hay suministros para mostrar.</td></tr>'}
                        <tr style="font-weight:700; background:#f8fafc;">
                            <td colspan="3" style="text-align:right;">Totales cliente</td>
                            <td>${baselineTotals.consumption.toFixed(2)} kWh</td>
                            <td>${formatCurrency(baselineTotals.energy)}</td>
                            <td>${formatCurrency(baselineTotals.power)}</td>
                            <td>${formatCurrency(baselineTotals.total)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>

        ${bestOption ? `
        <div class="card" style="padding:1rem; margin-bottom:0.75rem; border:1px solid #dbeafe;">
            <h4 style="margin-bottom:0.5rem;">Escenario lider (${bestOption.comm.name}) - Antes vs Despues real</h4>
            <p style="color:#64748b; margin:0 0 0.65rem;">Este bloque agrega todos los puntos del cliente y conserva el detalle por suministro, incluyendo impacto de potencia.</p>
            <div style="display:grid; grid-template-columns: repeat(3, minmax(160px, 1fr)); gap:0.65rem; margin-bottom:0.75rem;">
                <div><small style="color:#64748b;">Energia antes/despues</small><div style="font-weight:700;">${formatCurrency(bestTotals.oldEnergy)} / ${formatCurrency(bestTotals.newEnergy)}</div></div>
                <div><small style="color:#64748b;">Potencia antes/despues</small><div style="font-weight:700;">${formatCurrency(bestTotals.oldPower)} / ${formatCurrency(bestTotals.newPower)}</div></div>
                <div><small style="color:#64748b;">Total antes/despues</small><div style="font-weight:700; color:${(bestTotals.oldTotal - bestTotals.newTotal) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(bestTotals.oldTotal)} / ${formatCurrency(bestTotals.newTotal)}</div></div>
            </div>
            <div style="overflow-x:auto;">
                <table class="modal-table">
                    <thead>
                        <tr>
                            <th>Factura</th>
                            <th>Suministro</th>
                            <th>Energia antes</th>
                            <th>Energia despues</th>
                            <th>Impacto potencia</th>
                            <th>Total antes</th>
                            <th>Total despues</th>
                            <th>Ahorro total</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${bestRowsHtml || '<tr><td colspan="8">No hay detalle de escenario lider.</td></tr>'}
                        <tr style="font-weight:700; background:#eef2ff;">
                            <td colspan="5" style="text-align:right;">Totales escenario lider</td>
                            <td>${formatCurrency(bestTotals.oldTotal)}</td>
                            <td>${formatCurrency(bestTotals.newTotal)}</td>
                            <td style="color:${(bestTotals.oldTotal - bestTotals.newTotal) >= 0 ? '#059669' : '#dc2626'};">${formatCurrency(bestTotals.oldTotal - bestTotals.newTotal)}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </div>
        ` : ''}

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
                        <th>Accion</th>
                    </tr>
                </thead>
                <tbody>
                    ${rowsHtml || '<tr><td colspan="9">No hay datos para comparar.</td></tr>'}
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
async function deleteHistoryItem(index) {
    if (confirm('¿Estás seguro de que quieres eliminar esta factura del historial?')) {
        const removed = dbInvoices.splice(index, 1)[0];
        if (!removed) {
            renderHistory();
            return;
        }

        invoices = invoices.filter(inv => !isSameInvoiceRecord(inv, removed));
        await deleteInvoicePdfFromStore(removed);
        localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));

        const cloudResult = await cloudDeleteInvoice(removed);
        if (!cloudResult.ok) {
            alert(`Factura eliminada localmente, pero NO en cloud. Puede reaparecer al refrescar.\nDetalle: ${cloudResult.message}`);
        }

        renderHistory();
        renderClients();
        console.log(`[History] Eliminada factura en índice ${index}. Resultado cloud:`, cloudResult);
    }
}

async function clearAllHistory() {
    if (confirm('¿Estás seguro de que quieres vaciar TODO el historial? Esta acción no se puede deshacer.')) {
        dbInvoices = [];
        invoices = [];
        window.pendingPdfFiles = new Map();
        localStorage.removeItem('audit_pro_db');
        await clearInvoicePdfStore();
        const cloudResult = await clearCloudHistory();
        const dashboard = document.getElementById('dashboard');
        if (dashboard) dashboard.classList.add('hidden');
        switchView('audit-view');
        renderHistory();
        renderClients();

        if (!cloudResult.ok) {
            alert(`Historial local vaciado, pero NO se pudo borrar en cloud. Por eso puede reaparecer al refrescar.\nDetalle: ${cloudResult.message}`);
        }

        console.log('[History] Historial local/sesion vaciados. Resultado cloud:', cloudResult);
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

function applyCommercializerProposal(invoiceIdx, commercializerIdx, scopeMode = 'single') {
    const baseInv = compareBaseInvoice || invoices[invoiceIdx];
    const comm = commercializers[commercializerIdx];
    if (!baseInv || !comm) {
        alert('No se pudo aplicar la propuesta.');
        return;
    }

    const targets = getCompareInvoicesByScope(baseInv, scopeMode);
    if (targets.length === 0) {
        alert('No hay suministros para aplicar la propuesta.');
        return;
    }

    const batchId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const batchCreatedAt = new Date().toISOString();

    targets.forEach(inv => {
        const key = buildSupplyKey(inv);
        const metrics = computeInvoiceProposalMetrics(inv, comm);
        const simulation = buildInvoiceTransparencySimulation(inv, comm);
        const proposalId = `prop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        supplyProposals[key] = {
            commercializerId: comm.id,
            commercializerName: comm.name,
            tariffType: inv.tariffType || comm.tariffType || 'N/D',
            appliedAt: new Date().toISOString(),
            scope: scopeMode
        };

        proposalsLog.push({
            proposalId,
            batchId,
            batchSupplyCount: targets.length,
            createdAt: batchCreatedAt,
            updatedAt: batchCreatedAt,
            status: 'propuesta',
            scope: scopeMode,
            invoiceNum: inv.invoiceNum || 'S/N',
            fileName: inv.fileName || '',
            clientName: inv.clientName || 'N/D',
            cups: inv.cups || 'N/D',
            supplyAddress: inv.supplyAddress || 'N/D',
            tariffType: inv.tariffType || comm.tariffType || 'N/D',
            currentCommercializer: inv.comercializadora || 'N/D',
            proposedCommercializer: comm.name,
            oldAvgPrice: metrics.oldAvgPrice,
            newAvgPrice: metrics.newAvgPrice,
            oldEnergyCost: metrics.oldEnergy,
            newEnergyCost: metrics.newEnergy,
            energySaving: metrics.energySaving,
            oldTotal: metrics.oldTotal,
            simulatedTotal: metrics.newTotalSim,
            totalSaving: metrics.totalSaving,
            simulationSnapshot: serializeSimulationSnapshot(simulation)
        });
    });

    saveSupplyProposals();
    saveProposalsLog();
    renderClients();
    renderProposals();

    alert(`Propuesta aplicada: ${comm.name} en ${targets.length} suministro(s).`);
}

async function openClientSupplyInvoice(rowIndex) {
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
    const file = await getInvoicePdfFile(inv);
    let viewerHtml = '';

    if (Array.isArray(inv.invoicePreviewPages) && inv.invoicePreviewPages.length > 0) {
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
        const fullPdfAction = file
            ? `<div class="card" style="padding:0.75rem; margin-bottom:0.75rem;"><button class="btn secondary" onclick="openClientSupplyPdfOriginal(${rowIndex})">Abrir PDF original completo</button></div>`
            : '';
        viewerHtml = `${fullPdfAction}${note}${pagesHtml}`;
    } else if (file) {
        viewerHtml = '<div id="client-pdf-pages" class="card" style="padding:0.75rem; min-height: 280px;">Cargando factura completa...</div>';
    } else if (inv.invoicePreview) {
        viewerHtml = `<img src="${inv.invoicePreview}" alt="Preview factura" style="width:100%; max-width:980px; border:1px solid #e2e8f0; border-radius:8px; display:block;">`;
    } else {
        viewerHtml = '<div class="card" style="padding:1rem;">No hay PDF disponible para esta factura. Si la acabas de cargar, vuelve a procesarla para guardarla de forma persistente.</div>';
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

    if (file && (!Array.isArray(inv.invoicePreviewPages) || inv.invoicePreviewPages.length === 0)) {
        const pagesContainer = document.getElementById('client-pdf-pages');
        if (pagesContainer) {
            renderPdfFileAllPages(file, pagesContainer).catch(err => {
                console.error('[Clients] Error renderizando vista previa PDF:', err);
                pagesContainer.innerHTML = '<div class="card" style="padding:1rem;">No se pudo renderizar la factura completa.</div>';
            });
        }
    }
}

async function openClientSupplyPdfOriginal(rowIndex) {
    const row = clientSupplyRows[rowIndex];
    const inv = row?.invoice;
    const file = inv ? await getInvoicePdfFile(inv) : null;
    if (!file) {
        alert('No se encontro el PDF original disponible para esta factura.');
        return;
    }
    const url = URL.createObjectURL(file);
    window.open(url, '_blank');
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
    renderProposals();

    // Cargar Comercializadoras
    renderCommercializersList();
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
    cloudSaveAppState('commercializers', commercializers);
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

window.addEventListener('click', (event) => {
    const modal = document.getElementById('comparison-transparency-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.compareTransparency) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeComparisonTransparencyModal();
    }
});

window.addEventListener('click', (event) => {
    const modal = document.getElementById('client-supply-audit-modal');
    if (!modal || modal.classList.contains('hidden')) return;
    if (Date.now() < modalGuardUntil.clientAudit) return;
    const content = modal.querySelector('.modal-content');
    if (content && !content.contains(event.target)) {
        closeClientSupplyAuditModal();
    }
});

// Exponer funciones globales para onclick handlers
window.openDetailModalFromHistory = openDetailModalFromHistory;
window.openClientSupplyInvoice = openClientSupplyInvoice;
window.openClientSupplyPdfOriginal = openClientSupplyPdfOriginal;
window.openClientSupplyAuditModal = openClientSupplyAuditModal;
window.toggleAuditCorrections = toggleAuditCorrections;
window.saveAuditCorrections = saveAuditCorrections;
window.closeClientSupplyAuditModal = closeClientSupplyAuditModal;
window.closeClientSupplyInvoiceModal = closeClientSupplyInvoiceModal;
window.openCompareFromClientSupply = openCompareFromClientSupply;
window.startCompareFromTab = startCompareFromTab;
window.applyCommercializerProposal = applyCommercializerProposal;
window.openComparisonTransparencyModal = openComparisonTransparencyModal;
window.closeComparisonTransparencyModal = closeComparisonTransparencyModal;
window.openComparisonTransparencyPrintView = openComparisonTransparencyPrintView;
window.downloadComparisonTransparencyHtml = downloadComparisonTransparencyHtml;
window.downloadComparisonTransparencyPdf = downloadComparisonTransparencyPdf;
window.updateProposalStatus = updateProposalStatus;
window.openStoredProposalReport = openStoredProposalReport;
window.deleteProposalEntry = deleteProposalEntry;
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