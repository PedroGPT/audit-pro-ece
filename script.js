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
let pendingInvoices = [];
window.pendingPdfFiles = new Map(); // In-memory map of dropped PDF File objects for viewing

let savedComparisons = [];

// --- SUPABASE CLOUD SYNC ---
// Cambiamos el nombre de la variable a 'supabaseClient' para evitar conflictos con el objeto global de la librería
const SUPABASE_URL = (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) ? process.env.SUPABASE_URL : 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = (typeof process !== 'undefined' && process.env && process.env.SUPABASE_ANON_KEY) ? process.env.SUPABASE_ANON_KEY : 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';
let supabaseClient = null;

// El CDN de @supabase/supabase-js@2 expone el objeto como window.supabase
if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient && SUPABASE_URL && SUPABASE_KEY) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
    console.log("Supabase Cloud Client Initialized ✓");
} else if (typeof window !== 'undefined' && SUPABASE_URL && SUPABASE_KEY) {
    // Intentar inicialización diferida (el CDN puede no haber cargado aún)
    setTimeout(() => {
        if (window.supabase && window.supabase.createClient && !supabaseClient) {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log("Supabase Cloud Client Initialized (delayed) ✓");
        }
    }, 500);
}

// BOE Constants for Calculations (Global Scope)
const boePeajesExtPower = [0.063851, 0.003157, 0.002016, 0.001716, 0.001601, 0.001509];
const boeCargosExtPower = [0.004124, 0.000431, 0.000287, 0.000227, 0.000192, 0.000183];
const boePeajesExtEnergy = [0.030588, 0.024765, 0.015031, 0.010178, 0.008434, 0.006256];
const boeCargosExtEnergy = [0.028766, 0.019432, 0.009021, 0.004561, 0.003412, 0.002134];
let customLogoData = "";

// Market Prices Configuration
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

    Object.keys(MARKET_PRICES).forEach(id => {
        if (MARKET_PRICES[id].pp1 === undefined) {
            MARKET_PRICES[id].pp1 = 0; MARKET_PRICES[id].pp2 = 0; MARKET_PRICES[id].pp3 = 0;
            MARKET_PRICES[id].pp4 = 0; MARKET_PRICES[id].pp5 = 0; MARKET_PRICES[id].pp6 = 0;
        }
    });
}

function switchView(viewId) {
    console.log(`[Navigation] Switching to ${viewId}`);
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
    });
}

// --- GOOGLE DRIVE LOGIC ---
function gapiLoaded() { gapi.load('client:picker', initializeGapiClient); }

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
        callback: '',
    });
    gisInited = true;
}

function handleAuthClick() {
    if (!window.gapi || !window.google) {
        alert("Error de carga de librerías de Google.");
        return;
    }
    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) throw (resp);
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
            window.renderDashboard && window.renderDashboard();
        } catch (err) {
            console.error(err);
            alert("Error al descargar archivos desde Drive.");
        } finally {
            if (loadingIndicator) loadingIndicator.classList.add('hidden');
            if (dashboard) dashboard.classList.remove('hidden');
        }
    }
}

async function processFiles(files) {
    const loadingIndicator = document.getElementById('loading');
    const dashboard = document.getElementById('dashboard');
    if (loadingIndicator) loadingIndicator.classList.remove('hidden');
    if (dashboard) dashboard.classList.add('hidden');
    invoices = [];
    try {
        for (const file of files) {
            window.pendingPdfFiles.set(file.name, file);
            const data = await parsePDF(file);
            if (data) {
                data._sourceFileName = file.name;
                invoices.push(data);
            }
        }
        if (invoices.length > 0) {
            saveToDatabase(invoices);
            switchView('audit-view');
            window.renderDashboard();
        } else {
            alert("No se pudo extraer información.");
        }
    } catch (error) {
        console.error(error);
        alert("Error crítico: " + error.message);
    } finally {
        if (loadingIndicator) loadingIndicator.classList.add('hidden');
    }
}

async function parsePDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        fullText += textContent.items.map(item => item.str).join(" ") + "\n";
    }
    return await extractInvoiceDataWithAI(fullText, file.name);
}

async function extractInvoiceDataWithAI(text, fileName) {
    const prompt = `Extrae los datos de esta factura de luz española. Devuelve un JSON estricto... (PROMPT OMITIDO POR BREVEDAD)`;
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: "gpt-4o-mini", prompt: prompt })
        });
        const data = await response.json();
        let inv = JSON.parse(data.choices[0].message.content.replace(/```json\n?|```/g, '').trim());

        // Cálculos básicos de auditoría
        inv.consumption = (inv.consumptionItems || []).reduce((a, b) => a + b, 0);
        inv.totalCalculated = (inv.energyCost || 0) + (inv.powerCost || 0) + (inv.othersCost || 0);
        inv.fileName = fileName;
        inv._auditStatus = 'OK';

        return inv;
    } catch (e) {
        console.error(e);
        return null;
    }
}

// --- PERSISTENCIA Y SINCRONIZACIÓN (CORREGIDO) ---
window.saveToDatabase = async function (newInvoices) {
    const stored = localStorage.getItem('audit_pro_db');
    let currentDb = stored ? JSON.parse(stored) : [];

    newInvoices.forEach(inv => {
        inv.clientName = normalizeClientName(inv.clientName);
        const existingIdx = currentDb.findIndex(d => (d.invoiceNum === inv.invoiceNum) || (d.cups === inv.cups && d.period === inv.period));
        if (existingIdx >= 0) currentDb[existingIdx] = inv;
        else currentDb.push(inv);
    });

    // CLOUD SYNC: Usamos supabaseClient
    if (supabaseClient) {
        try {
            const { error } = await supabaseClient
                .from('invoices')
                .upsert(newInvoices.map(inv => ({
                    ...inv,
                    last_updated: new Date().toISOString()
                })));
            if (error) console.error("Error en Supabase:", error);
            else console.log("Sincronización en la nube exitosa ✓");
        } catch (e) {
            console.error("Error de conexión con la nube.");
        }
    }

    localStorage.setItem('audit_pro_db', JSON.stringify(currentDb));
    dbInvoices = currentDb;
    renderHistory();
}

window.deleteInvoice = async function (cups, period) {
    if (!confirm('¿Borrar factura?')) return;

    if (supabaseClient) {
        try {
            await supabaseClient
                .from('invoices')
                .delete()
                .match({ cups: cups, period: period });
        } catch (e) { console.error(e); }
    }

    dbInvoices = dbInvoices.filter(inv => !(inv.cups === cups && inv.period === period));
    localStorage.setItem('audit_pro_db', JSON.stringify(dbInvoices));
    renderHistory();
}

// --- UI RENDERING (EJEMPLOS) ---
window.renderDashboard = function () {
    const resultsTableBody = document.querySelector('#results-table tbody');
    if (!resultsTableBody) return;
    resultsTableBody.innerHTML = invoices.map((inv, idx) => `
        <tr>
            <td>${inv.invoiceNum}</td>
            <td>${inv.period}</td>
            <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
            <td class="text-right">
                 <button class="btn primary btn-sm" onclick="selectForComparison('${inv.invoiceNum}')">Comparar</button>
            </td>
        </tr>
    `).join('');
}

window.renderHistory = function () {
    const historyContainer = document.getElementById('history-list');
    if (!historyContainer) return;
    historyContainer.innerHTML = `<table><tbody>${dbInvoices.map(inv => `
        <tr>
            <td>${inv.clientName}</td>
            <td>${inv.cups}</td>
            <td>${formatCurrency(inv.totalCalculated)}</td>
            <td><button onclick="deleteInvoice('${inv.cups}', '${inv.period}')">Borrar</button></td>
        </tr>`).join('')}</tbody></table>`;
}

// --- UTILIDADES ---
function formatCurrency(a) { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0); }
function formatNumber(a, d = 2) { return new Intl.NumberFormat('es-ES', { minimumFractionDigits: d }).format(a || 0); }
function normalizeClientName(n) { return (n || 'N/D').toUpperCase().trim(); }

// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    // Intentar carga inicial de nube
    if (supabaseClient) {
        supabaseClient.from('invoices').select('*').then(({ data, error }) => {
            if (!error && data) {
                dbInvoices = data;
                renderHistory();
            }
        });
    }

    // Cargar LocalStorage
    const stored = localStorage.getItem('audit_pro_db');
    if (stored && dbInvoices.length === 0) {
        dbInvoices = JSON.parse(stored);
        renderHistory();
    }

    loadCustomProviders();
});
