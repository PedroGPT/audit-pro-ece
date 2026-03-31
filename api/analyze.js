export default async function handler(req, res) {
    // Manejo de seguridad básico
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Usar POST" });

    const API_KEY = process.env.OPENAI_API_KEY;

    try {
        const { prompt } = req.body;

        // Usamos fetch nativo sin importar nada externo
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Extrae JSON: {invoiceNum, period, totalCalculated, clientName}" },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();

        // Si OpenAI nos da error, lo mostramos para saber qué pasa
        if (data.error) {
            return res.status(500).json({ error: data.error.message });
        }

        return res.status(200).json(data);

    } catch (error) {
        return res.status(500).json({ error: "Error interno: " + error.message });
    }
}