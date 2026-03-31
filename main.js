// --- CONFIGURACIÓN GLOBAL ---
const DEVELOPER_KEY = 'AIzaSyACZ4t052cFJU_Nw1rJ0c5w-MjOkQ538n8';
const CLIENT_ID = '401814876123-0h2kp6oj36p1oiugodc8vgacohmf8ibo.apps.googleusercontent.com';
const APP_ID = '401814876123';
const SCOPES = 'https://www.googleapis.com/auth/drive.readonly';

let tokenClient;
let gapiInited = false;
let gisInited = false;
let invoices = [];
let dbInvoices = [];
window.pendingPdfFiles = new Map();

// --- SUPABASE CLOUD SYNC ---
const SUPABASE_URL = 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';
let supabaseClient = null;

if (typeof window !== 'undefined' && window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// BOE Constants (Manteniendo tu lógica original)
const boePeajesExtPower = [0.063851, 0.003157, 0.002016, 0.001716, 0.001601, 0.001509];
const boeCargosExtPower = [0.004124, 0.000431, 0.000287, 0.000227, 0.000192, 0.000183];

// Market Prices
const DEFAULT_MARKET_PRICES = {
    "fenie": { name: "Fenie Energía", p1: 0, p2: 0, p3: 0, p4: 0, p5: 0, p6: 0, pp1: 0, pp2: 0, pp3: 0, pp4: 0, pp5: 0, pp6: 0 },
    "repsol": { name: "Repsol", p1: 0.138, p2: 0.115, p3: 0.105, p4: 0, p5: 0, p6: 0, pp1: 0.038, pp2: 0.005, pp3: 0, pp4: 0, pp5: 0, pp6: 0 },
    "iberdrola": { name: "Iberdrola", p1: 0.150, p2: 0.130, p3: 0.120, p4: 0, p5: 0, p6: 0, pp1: 0.040, pp2: 0.006, pp3: 0, pp4: 0, pp5: 0, pp6: 0 }
};
let MARKET_PRICES = { ...DEFAULT_MARKET_PRICES };

// --- NAVEGACIÓN ---
function switchView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    const target = document.getElementById(viewId);
    if (target) target.classList.remove('hidden');
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-view') === viewId);
    });
}

// --- EXTRACCIÓN CON IA (CORREGIDA PARA VERCEL) ---
async function extractInvoiceDataWithAI(text, fileName) {
    try {
        const response = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text }) // Simplificado para la nueva API
        });

        const data = await response.json();

        // Manejo de respuesta de OpenAI
        let rawContent = data.choices ? data.choices[0].message.content : data;
        let inv = typeof rawContent === 'string'
            ? JSON.parse(rawContent.replace(/```json\n?|```/g, '').trim())
            : rawContent;

        // Cálculos automáticos de tu lógica original
        inv.consumption = (inv.consumptionItems || []).reduce((a, b) => a + (parseFloat(b) || 0), 0);
        inv.totalCalculated = (parseFloat(inv.energyCost) || 0) + (parseFloat(inv.powerCost) || 0) + (parseFloat(inv.othersCost) || 0);
        inv.fileName = fileName;
        inv._auditStatus = 'OK';

        return inv;
    } catch (e) {
        console.error("Error IA:", e);
        return null;
    }
}

// --- PROCESAMIENTO DE ARCHIVOS ---
async function processFiles(files) {
    const loadingIndicator = document.getElementById('loading');
    const dashboard = document.getElementById('dashboard');
    if (loadingIndicator) loadingIndicator.classList.remove('hidden');

    invoices = [];
    for (const file of files) {
        window.pendingPdfFiles.set(file.name, file); // Para el visor de papel
        const arrayBuffer = await file.arrayBuffer();
        const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
        let fullText = "";
        for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();
            fullText += textContent.items.map(item => item.str).join(" ") + "\n";
        }
        const data = await extractInvoiceDataWithAI(fullText, file.name);
        if (data) invoices.push(data);
    }

    if (invoices.length > 0) {
        saveToDatabase(invoices);
        switchView('audit-view');
        renderDashboard();
    }
    if (loadingIndicator) loadingIndicator.classList.add('hidden');
    if (dashboard) dashboard.classList.remove('hidden');
}

// --- RENDERIZADO (RECUPERANDO TU TABLA Y BOTONES) ---
function renderDashboard() {
    // Actualizar Tarjetas (Stats Grid)
    if (invoices.length > 0) {
        const last = invoices[0];
        document.getElementById('total-kwh').innerText = `${last.consumption.toFixed(0)} kWh`;
        document.getElementById('avg-price').innerText = `${(last.totalCalculated / (last.consumption || 1)).toFixed(4)} €/kWh`;
    }

    const tbody = document.querySelector('#results-table tbody');
    if (!tbody) return;
    tbody.innerHTML = invoices.map((inv) => `
        <tr>
            <td>
                <strong>${inv.invoiceNum || 'S/N'}</strong><br>
                <small>${inv.clientName || inv.fileName}</small>
            </td>
            <td>${inv.period || 'N/D'}</td>
            <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
            <td class="text-right">
                 <button class="btn primary btn-sm" onclick="switchView('compare-view')">Ver Comparativa</button>
            </td>
        </tr>
    `).join('');
}

// --- UTILIDADES ---
function formatCurrency(a) { return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0); }

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
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
    const stored = localStorage.getItem('audit_pro_db');
    if (stored) {
        dbInvoices = JSON.parse(stored);
        // Aquí podrías llamar a renderHistory() si existe
    }
});