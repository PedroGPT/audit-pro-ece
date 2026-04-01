export default async function handler(req, res) {
    // 1. Cabeceras para evitar bloqueos
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: "Enviar POST" });

    try {
        // 2. Verificación de la Llave (Sin esto, Vercel da Error 500)
        const apiKey = process.env.OPENAI_API_KEY;
        if (!apiKey) {
            return res.status(200).json({
                error: "Configuración incompleta",
                details: "Falta la OPENAI_API_KEY en las variables de Vercel"
            });
        }

        const { prompt } = req.body;

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Eres un extractor de facturas electricas. Responde solo JSON valido, sin markdown ni texto extra. Debes devolver todos los campos solicitados por el usuario." },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" },
                temperature: 0
            })
        });

        const data = await response.json();
        return res.status(200).json(data);

    } catch (err) {
        return res.status(200).json({ error: "Error de conexión", details: err.message });
    }
}