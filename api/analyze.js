export default async function handler(req, res) {
    // Si la petición no es POST, devolvemos error
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Método no permitido" });
    }

    const API_KEY = process.env.OPENAI_API_KEY;

    if (!API_KEY) {
        return res.status(500).json({ error: "No se encontró la API KEY en Vercel" });
    }

    try {
        const { prompt } = req.body;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    {
                        role: "system",
                        content: "Eres un extractor de datos. Responde SOLO con un objeto JSON: {invoiceNum, period, totalCalculated, clientName}"
                    },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}