const fetch = require('node-fetch');

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    const { model, prompt } = req.body;
    const API_KEY = process.env.OPENAI_API_KEY;

    if (!API_KEY) {
        return res.status(500).json({ error: "OpenAI API Key not configured in environment variables." });
    }

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: model || "gpt-4o-mini",
                messages: [{ role: "user", content: prompt }],
                temperature: 0,
                response_format: { type: "json_object" }
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            let errorJson = {};
            try { errorJson = JSON.parse(errorText); } catch(ex) {}
            return res.status(response.status).json({ 
                error: (errorJson.error && errorJson.error.message) || errorText 
            });
        }

        const data = await response.json();
        res.json(data);

    } catch (error) {
        console.error("Vercel Side Error:", error);
        res.status(500).json({ error: "Error de conexión con OpenAI en el entorno de la nube." });
    }
};
