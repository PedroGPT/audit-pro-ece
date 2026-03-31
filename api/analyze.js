export const config = {
    runtime: 'edge', // Esto hace que sea ultra rápido y no falle por librerías
};

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
    }

    const API_KEY = process.env.OPENAI_API_KEY;
    if (!API_KEY) {
        return new Response(JSON.stringify({ error: 'Falta la llave en Vercel' }), { status: 500 });
    }

    try {
        const { prompt } = await req.json();

        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Eres un extractor de facturas. Responde SOLO JSON: {invoiceNum, period, totalCalculated, clientName}" },
                    { role: "user", content: prompt }
                ],
                response_format: { type: "json_object" }
            })
        });

        const data = await response.json();
        return new Response(JSON.stringify(data), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}