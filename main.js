// --- CARGA SEGURA DE SUPABASE (EVITA DUPLICIDAD) ---
let supabaseClient = null;
const SUPABASE_URL = 'https://uxngxqyrqxtigrcdbliu.supabase.co';
const SUPABASE_KEY = 'sb_publishable__G6Fw6PRn8OSHwg7G3h25w_0Mq7ByRJ';

async function loadSupabaseLibrary() {
    if (window.supabase) return; // Si ya existe, no la cargamos de nuevo
    return new Promise((resolve) => {
        const script = document.createElement('script');
        script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
        script.onload = () => {
            if (window.supabase && !supabaseClient) {
                supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
                console.log("Supabase inicializado correctamente ✓");
            }
            resolve();
        };
        document.head.appendChild(script);
    });
}

// --- CONFIGURACIÓN GOOGLE DRIVE ---
const DEVELOPER_KEY = 'AIzaSyACZ4t052cFJU_Nw1rJ0c5w-MjOkQ538n8';
const CLIENT_ID = '401814876123-0h2kp6oj36p1oiugodc8vgacohmf8ibo.apps.googleusercontent.com';
let tokenClient, invoices = [], dbInvoices = [];

// --- UTILIDADES ---
function formatCurrency(a) {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }).format(a || 0);
}

// --- PERSISTENCIA Y DATOS ---
window.saveToDatabase = async function (newInvoices) {
    if (supabaseClient) {
        try {
            await supabaseClient.from('invoices').upsert(newInvoices);
        } catch (e) { console.error("Error al sincronizar con la nube:", e); }
    }
    // Guardado local de respaldo
    const stored = localStorage.getItem('audit_pro_db');
    let currentDb = stored ? JSON.parse(stored) : [];
    newInvoices.forEach(inv => {
        const idx = currentDb.findIndex(d => d.invoiceNum === inv.invoiceNum);
        if (idx >= 0) currentDb[idx] = inv; else currentDb.push(inv);
    });
    localStorage.setItem('audit_pro_db', JSON.stringify(currentDb));
    dbInvoices = currentDb;
    renderHistory();
}

async function processFiles(files) {
    document.getElementById('loading').classList.remove('hidden');
    invoices = [];
    for (const file of files) {
        const text = await parsePDF(file);
        const data = await extractWithAI(text, file.name);
        if (data) invoices.push(data);
    }
    document.getElementById('loading').classList.add('hidden');
    if (invoices.length > 0) {
        await saveToDatabase(invoices);
        document.getElementById('dashboard').classList.remove('hidden');
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

async function extractWithAI(text, fileName) {
    try {
        const res = await fetch('/api/analyze', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: text })
        });
        const data = await res.json();
        let inv = JSON.parse(data.choices[0].message.content.replace(/```json\n?|```/g, '').trim());
        inv.fileName = fileName;
        return inv;
    } catch (e) { return null; }
}

// --- RENDERIZADO UI ---
window.renderDashboard = function () {
    const tbody = document.querySelector('#results-table tbody');
    if (tbody) {
        tbody.innerHTML = invoices.map(inv => `
            <tr>
                <td>${inv.invoiceNum || 'S/N'}</td>
                <td>${inv.period || 'S/P'}</td>
                <td class="text-right">${formatCurrency(inv.totalCalculated)}</td>
            </tr>`).join('');
    }
}

window.renderHistory = function () {
    const div = document.getElementById('history-list');
    if (div) {
        div.innerHTML = dbInvoices.map(inv => `
            <div class="card" style="margin-bottom:0.5rem; padding:1rem; background:white; border-radius:8px; border:1px solid #e2e8f0;">
                <strong>${inv.clientName || 'Sin Nombre'}</strong> - ${formatCurrency(inv.totalCalculated)}
            </div>`).join('');
    }
}

// --- ARRANQUE DE LA APLICACIÓN ---
document.addEventListener('DOMContentLoaded', async () => {
    // 1. Cargar Supabase dinámicamente
    await loadSupabaseLibrary();

    // 2. Cargar datos iniciales
    if (supabaseClient) {
        const { data } = await supabaseClient.from('invoices').select('*');
        if (data) dbInvoices = data;
    } else {
        const stored = localStorage.getItem('audit_pro_db');
        if (stored) dbInvoices = JSON.parse(stored);
    }
    renderHistory();

    // 3. Configurar navegación
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => {
            const viewId = btn.getAttribute('data-view');
            document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
            const target = document.getElementById(viewId);
            if (target) target.classList.remove('hidden');
            document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        };
    });

    // 4. Configurar botones de archivos
    const fileInput = document.getElementById('file-input');
    const selectBtn = document.getElementById('select-files-btn');
    if (selectBtn) selectBtn.onclick = () => fileInput.click();
    if (fileInput) fileInput.onchange = (e) => processFiles(e.target.files);
});