const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const PORT = 3001; // Changed to 3001 to avoid conflict with npx serve

// API Key from environment variable
const API_KEY = process.env.OPENAI_API_KEY;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, '.'))); // Serve static files from current directory

// Proxy Endpoint
app.post('/api/analyze', async (req, res) => {
    try {
        const { prompt, model } = req.body;
        console.log('API /api/analyze request:', { promptLength: prompt?.length, model });

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
                // Nota: response_format puede no ser compatible con todas las versiones, lo dejamos por si
                response_format: { type: "json_object" }
            })
        });

        const responseText = await response.text();
        console.log('OpenAI response status', response.status);

        if (!response.ok) {
            console.error("OpenAI API Error:", responseText);
            return res.status(response.status).json({ error: responseText });
        }

        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseErr) {
            console.warn('OpenAI response no es JSON, devolviendo texto crudo.');
            return res.status(500).json({ error: 'OpenAI retornó texto no JSON', raw: responseText });
        }

        console.log('OpenAI response data keys', Object.keys(data));
        res.json(data);

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Save Logo Endpoint
app.post('/api/save-logo', async (req, res) => {
    try {
        const { image } = req.body;
        if (!image) {
            return res.status(400).json({ error: "No image data provided" });
        }

        // Remove header data:image/png;base64,...
        const base64Data = image.replace(/^data:image\/\w+;base64,/, "");
        const buffer = Buffer.from(base64Data, 'base64');

        const filePath = path.join(__dirname, 'logo.png');

        fs.writeFile(filePath, buffer, (err) => {
            if (err) {
                console.error("Error saving logo:", err);
                return res.status(500).json({ error: "Failed to save logo" });
            }
            res.json({ success: true, message: "Logo saved successfully" });
        });

    } catch (error) {
        console.error("Server Error:", error);
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
