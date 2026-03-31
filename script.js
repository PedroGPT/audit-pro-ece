// --- GOOGLE DRIVE CONFIGURATION ---
const DEVELOPER_KEY = 'AIzaSyACZ4t052cFJU_Nw1rJ0c5w-MjOkQ538n8';
const CLIENT_ID = '401814876123-0h2kp6oj36p1oiugodc8vgacohmf8ibo.apps.googleusercontent.com';
const APP_ID = '401814876123';

const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let invoices = [];
let dbInvoices = [];
let pendingInvoices = [];
window.pendingPdfFiles = new Map();

let savedComparisons = [];

// --- SUPABASE CLOUD SYNC (CORREGIDO PARA EVITAR DUPLICIDAD) ---
const SUPABASE_URL = (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) ? process.env.SUPABASE_URL : 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = (typeof process !== 'undefined' && process.env && process.env.SUPABASE_ANON_KEY) ? process.env.SUPABASE_ANON_KEY : 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';
let supabaseClient = null;

// Función segura para inicializar el cliente sin chocar con la librería global
function initSupabase() {
    if (typeof window !== 'undefined' && window.supabase && window.supabase.createClient && !supabaseClient) {
        try {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
            console.log("Supabase Cloud Client Initialized ✓");
        } catch (e) {
            console.error("Error al crear el cliente de Supabase:", e);
        }
    }
}

// Intentar inicialización inmediata y una diferida por si el CDN es lento
initSupabase();
setTimeout(initSupabase, 1000);

// BOE Constants
const boePeajesExtPower = [0.063851, 0.003157, 0.002016, 0.001716, 0.001601, 0.001509];
const boeCargosExtPower = [0.004124, 0.000431, 0.000287, 0.000227, 0.000192, 0.000183];
const boePeajesExtEnergy = [0.030588, 0.024765, 0.015031, 0.010178, 0.008434, 0.006256];
const boeCargosExtEnergy = [0.028766, 0.019432, 0.009021, 0.004561, 0.003412, 0.002134];
let customLogoData = "";

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
}

function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
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
    tokenClient.callback = async (resp) => {
        if (resp.error !== undefined) throw (resp);
        createPicker(resp.access_token);
    };
    tokenClient.requestAccessToken({ prompt: gapi.client.getToken() === null ? 'consent' : '' });
}

function createPicker(accessToken) {
    const view = new google.picker.View(google.picker.ViewId.DOCS);
    view.setMimeTypes("application/pdf");
    const picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .addView(view)
        .setDeveloperKey(DEVELOPER_KEY)
        .setCallback(pickerCallback)
        .build();
    picker.setVisible(true);
}

async function pickerCallback(data) {
    if (data.action === google.picker.Action.PICKED) {
        const doc = data[google.picker.Document][0];
        const fileId = doc[google.picker.Document.ID];
        const accessToken = gapi.client.getToken().access_token;
        const response = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const blob = await response.blob();
        const file = new File([blob], doc[google.picker.Document.NAME], { type: 'application/pdf' });
        processFiles([file]);
    }
}

async function processFiles(files) {
    invoices = [];
    for (const file of files) {
        const data = await parsePDF(file);
        if (data) {
            data._sourceFileName = file.name;
            invoices.push(data);
        }
    }
    if (invoices.length > 0) {
        await saveToDatabase(invoices);
        renderDashboard();
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
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text })
        });
        const data = await response.json();
        let inv = JSON.parse(data.choices[0].message.content.replace(/```json\n?|```/g, '').trim());
        inv.fileName = fileName;
        return inv;
    } catch (e) {
        console.error(e);
        return null;
    }
}

// --- PERSISTENCIA (SIN CONFLICTOS) ---
window.saveToDatabase = async function (newInvoices) {
    const stored = localStorage.getItem('audit_pro_db');
    let currentDb = stored ? JSON.parse(stored) : [];

    newInvoices.forEach(inv => {
        const idx = currentDb.findIndex(d => d.invoiceNum === inv.invoiceNum);
        if (idx >= 0) currentDb[idx] = inv;
        else currentDb.push(inv);
    });

    if (supabaseClient) {
        try {
            await supabaseClient.from('invoices').upsert(newInvoices);
        } catch (e) { console.error("Error nube:", e); }
    }

    localStorage.setItem('audit_pro_db', JSON.stringify(currentDb));
    dbInvoices = currentDb;
    renderHistory();
}

window.renderDashboard = function () {
    const resultsTableBody = document.querySelector('#results-table tbody');
    if (!resultsTableBody) return;
    resultsTableBody.innerHTML = invoices.map(inv => `
        <tr>
            <td>${inv.invoiceNum || 'S/N'}</td>
            <td>${inv.period || 'S/P'}</td>
            <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
        </tr>
    `).join('');
}

window.renderHistory = function () {
    const historyContainer = document.getElementById('history-list');
    if (!historyContainer) return;
    historyContainer.innerHTML = dbInvoices.map(inv => `<div>${inv.clientName} - ${formatCurrency(inv.totalCalculated)}</div>`).join('');
}

function formatCurrency(a) { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0); }

// --- INICIALIZACIÓN FINAL ---
document.addEventListener('DOMContentLoaded', () => {
    initSupabase();
    if (supabaseClient) {
        supabaseClient.from('invoices').select('*').then(({ data }) => {
            if (data) { dbInvoices = data; renderHistory(); }
        });
    }
    loadCustomProviders();
});