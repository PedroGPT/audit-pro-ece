// --- CONFIGURACIÓN GLOBAL ---
const SUPABASE_URL = 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';

let supabaseClient = null;
let invoices = [];
let dbInvoices = [];

// --- 1. CARGA SEGURA DE SUPABASE ---
async function loadSupabaseLibrary() {
    if (window.supabase) return;
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.onload = () => {
            if (window.supabase && !supabaseClient) {
                supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
                console.log("¡VERSIÓN ACTUALIZADA Y REAL ✓!");
            }
            resolve();
        };
        document.head.appendChild(script);
    });
}

// --- 2. UTILIDADES ---
function formatCurrency(a) {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0);
}

// --- 3. EXTRACCIÓN REAL CON IA (MODO DIAGNÓSTICO) ---
async function extractWithAI(text, fileName) {
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text })
        });

        const data = await res.json();

        if (!res.ok) {
            // ESTO TE DIRÁ EL ERROR REAL (Saldo, Llave, etc.)
            const errorMsg = data.error || "Error desconocido en la API";
            alert("DIAGNÓSTICO DE OPENAI:\n" + errorMsg);
            throw new Error(errorMsg);
        }

        // Limpiamos la respuesta de la IA
        let content = data.choices[0].message.content.replace(/```json\n?|```/g, '').trim();
        let inv = JSON.parse(content);

        inv.fileName = fileName;
        return inv;
    } catch (e) {
        console.error("Detalle del error:", e);
        return {
            invoiceNum: "ERROR LECTURA",
            period: "Ver Alerta",
            totalCalculated: 0,
            clientName: fileName
        };
    }
}

// --- 4. PROCESAMIENTO DE ARCHIVOS ---
async function processFiles(files) {
    const loadingEl = document.getElementById('loading');
    const dashboardEl = document.getElementById('dashboard');

    if (loadingEl) loadingEl.classList.remove('hidden');

    invoices = [];
    for (const file of files) {
        try {
            console.log("Analizando archivo:", file.name);
            const text = await parsePDF(file);
            const data = await extractWithAI(text, file.name);
            if (data) invoices.push(data);
        } catch (e) {
            console.error("Error en " + file.name + ":", e);
        }
    }

    if (loadingEl) loadingEl.classList.add('hidden');

    if (invoices.length > 0) {
        await saveToDatabase(invoices);
        if (dashboardEl) dashboardEl.classList.remove('hidden');
        renderDashboard();
    }
}

async function parsePDF(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        fullText += content.items.map(item => item.str).join(" ") + "\n";
    }
    return fullText;
}

// --- 5. PERSISTENCIA ---
async function saveToDatabase(newInvoices) {
    if (supabaseClient) {
        try {
            await supabaseClient.from('invoices').upsert(newInvoices);
        } catch (e) { console.error("Error Supabase:", e); }
    }
    const stored = localStorage.getItem('audit_pro_db');
    let currentDb = stored ? JSON.parse(stored) : [];
    newInvoices.forEach(inv => currentDb.unshift(inv));
    localStorage.setItem('audit_pro_db', JSON.stringify(currentDb));
    dbInvoices = currentDb;
    renderHistory();
}

// --- 6. RENDERIZADO UI ---
function renderDashboard() {
    const tbody = document.querySelector('#results-table tbody');
    if (tbody) {
        tbody.innerHTML = invoices.map(inv => `
            <tr>
                <td>${inv.invoiceNum || 'N/A'}</td>
                <td>${inv.period || 'N/A'}</td>
                <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
            </tr>`).join('');
    }
}

function renderHistory() {
    const div = document.getElementById('history-list');
    if (div) {
        div.innerHTML = dbInvoices.map(inv => `
            <div class="card" style="margin-bottom:0.5rem; padding:1rem; background:white; border-radius:8px; border:1px solid #e2e8f0; color: black;">
                <strong>${inv.clientName || inv.fileName}</strong> - ${formatCurrency(inv.totalCalculated)}
            </div>`).join('');
    }
}

// --- 7. ARRANQUE ---
document.addEventListener('DOMContentLoaded', async () => {
    await loadSupabaseLibrary();

    const stored = localStorage.getItem('audit_pro_db');
    if (stored) {
        dbInvoices = JSON.parse(stored);
        renderHistory();
    }

    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => {
            const viewId = btn.getAttribute('data-view');
            document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
            document.getElementById(viewId).classList.remove('hidden');
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });

    const fileInput = document.getElementById('file-input');
    const selectBtn = document.getElementById('select-files-btn');

    if (selectBtn && fileInput) {
        selectBtn.onclick = () => fileInput.click();
        fileInput.onchange = (e) => processFiles(e.target.files);
    }
});