export default async function handler(req, res) {
    // Manejo de seguridad para navegadores
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Método no permitido" });
    }

    try {
        const { prompt } = req.body;

        if (!process.env.OPENAI_API_KEY) {
            return res.status(500).json({ error: "La API KEY no está configurada en Vercel" });
        }

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Responde solo con JSON: {invoiceNum, period, totalCalculated, clientName}" },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        // Si explota, que nos diga por qué
        return res.status(500).json({ error: "Fallo del servidor: " + error.message });
    }
}