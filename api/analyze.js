export default async function handler(req, res) {
    // Solo permitir POST
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Método no permitido" });
    }

    const API_KEY = process.env.OPENAI_API_KEY;

    if (!API_KEY) {
        return res.status(500).json({ error: "Falta la OPENAI_API_KEY en Vercel." });
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
                        content: "Eres un extractor de datos de facturas. Responde SOLO en JSON con estos campos: invoiceNum, period, totalCalculated (número), clientName."
                    },
                    { role: "user", content: prompt }
                ],
                temperature: 0,
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();

        if (!response.ok) {
            return res.status(response.status).json({ error: data.error?.message || "Error OpenAI" });
        }

        return res.status(200).json(data);

    } catch (error) {
        console.error("Error en el servidor:", error);
        return res.status(500).json({ error: "Error interno del servidor al conectar con la IA." });
    }
}