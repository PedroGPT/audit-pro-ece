module.exports = async (req, res) => {
    // IMPORTANTE: En Vercel Serverless no se puede escribir en disco local permanentemente.
    // Esta función servirá para recibir el logo y, en el futuro, guardarlo en Supabase Storage.
    // De momento, devolvemos un mensaje informativo.
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: "Method not allowed" });
    }

    try {
        const { image } = req.body;
        if (!image) {
            return res.status(400).json({ error: "No image data provided" });
        }

        // En un futuro paso, aquí conectaremos con Supabase para persistencia real.
        res.json({ 
            success: true, 
            message: "Logo recibido en Cloud. Nota: En entornos Serverless se requiere almacenamiento externo (Supabase) para persistencia permanente." 
        });

    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};
