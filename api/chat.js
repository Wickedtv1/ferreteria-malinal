const ODOO_URL = 'https://ferreteriamalinal.odoo.com';

// Rate limiting - simple in-memory store
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 10; // max 10 requests per minute per IP

function isRateLimited(ip) {
    const now = Date.now();
    const record = rateLimitMap.get(ip) || { count: 0, start: now };
    if (now - record.start > RATE_LIMIT_WINDOW) {
        rateLimitMap.set(ip, { count: 1, start: now });
        return false;
    }
    if (record.count >= RATE_LIMIT_MAX) return true;
    record.count++;
    rateLimitMap.set(ip, record);
    return false;
}

async function searchOdooInventory(query) {
    try {
        const apiKey = process.env.ODOO_API_KEY;
        if (!apiKey) return null;
        const authHeader = 'Basic ' + Buffer.from(`ferreteriamalinal@icloud.com:${apiKey}`).toString('base64');
        const domain = [
            ['active', '=', true],
            '|',
            ['name', 'ilike', query],
            ['default_code', 'ilike', query]
        ];
        const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
            body: JSON.stringify({
                jsonrpc: '2.0', method: 'call', id: 1,
                params: {
                    model: 'product.template',
                    method: 'search_read',
                    args: [domain],
                    kwargs: {
                        fields: ['name', 'default_code', 'list_price', 'qty_available', 'description_sale'],
                        limit: 8,
                        order: 'name asc'
                    }
                }
            })
        });
        const data = await res.json();
        if (data.error || !data.result) return null;
        return data.result.map(p => ({
            name: p.name,
            sku: p.default_code || '',
            price: `$${p.list_price.toFixed(2)}`,
            stock: p.qty_available,
            in_stock: p.qty_available > 0
        }));
    } catch (e) {
        return null;
    }
}

export default async function handler(req, res) {
    // CORS - only allow your domain
    const allowedOrigins = ['https://ferreteriamalinal.com', 'https://ferreteria-malinal.vercel.app'];
    const origin = req.headers.origin || '';
    const isAllowed = allowedOrigins.includes(origin) || origin.includes('vercel.app');
    res.setHeader('Access-Control-Allow-Origin', isAllowed ? origin : allowedOrigins[0]);
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    // Rate limiting
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    if (isRateLimited(ip)) {
        return res.status(429).json({ error: 'Too many requests. Please wait a moment.' });
    }

    // Check API key exists
    if (!process.env.ANTHROPIC_API_KEY) {
        return res.status(500).json({ error: 'Service unavailable' });
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
        return res.status(400).json({ error: 'Invalid request' });
    }

    // Limit message count and length to prevent abuse
    if (messages.length > 20) {
        return res.status(400).json({ error: 'Too many messages' });
    }

    const sanitizedMessages = messages
        .filter(m => m.role && m.content && typeof m.content === 'string')
        .map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: m.content.slice(0, 1000) // max 1000 chars per message
        }))
        .slice(-10); // only last 10 messages

    try {
        const lastUserMsg = [...sanitizedMessages].reverse().find(m => m.role === 'user');
        let inventoryContext = '';

        if (lastUserMsg) {
            const text = lastUserMsg.content;
            const productKeywords = /tienen|hay|stock|precio|costo|cuanto|disponible|tienes|busco|necesito|quiero|cuantos|existe|venden/i;
            if (productKeywords.test(text)) {
                const cleaned = text
                    .replace(/tienen|hay|el|la|los|las|un|una|del|de|en|stock|precio|costo|cuanto|disponible|tienes|busco|necesito|quiero|cuantos|existe|venden|\?/gi, '')
                    .trim();
                if (cleaned.length > 2) {
                    const results = await searchOdooInventory(cleaned);
                    if (results && results.length > 0) {
                        inventoryContext = '\n\n[INVENTARIO EN TIEMPO REAL]:\n' +
                            results.map(p =>
                                `• ${p.name}${p.sku ? ` (SKU: ${p.sku})` : ''} - Precio: ${p.price} - Stock: ${p.stock > 0 ? p.stock + ' unidades disponibles' : 'SIN STOCK'}`
                            ).join('\n');
                    } else if (results !== null) {
                        inventoryContext = '\n\n[INVENTARIO: No se encontraron productos que coincidan con "' + cleaned + '"]';
                    }
                }
            }
        }

        const systemPrompt = `Eres un asistente de ventas bilingüe (español/inglés) de Ferretería Malinal, una ferretería en Valle Dorado, Nayarit, México. Ayuda a los clientes a encontrar productos, responde preguntas sobre herramientas, plomería, pintura, materiales de construcción, eléctrico y artículos de ferretería. Teléfono: +52 322 303 1895, correo: ferreteriamalinal@icloud.com, horario: Lunes-Sábado 8am-7pm, dirección: Av. Valle De México #2 Int. 6, Col. Valle Dorado. Sé breve, útil y amigable. Sugiere productos relacionados cuando sea relevante.${inventoryContext}`;

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 1024,
                system: systemPrompt,
                messages: sanitizedMessages
            })
        });

        if (!response.ok) {
            // Don't leak error details to public
            console.error('Anthropic API error:', response.status);
            return res.status(500).json({ error: 'Service error. Please try again.' });
        }

        const data = await response.json();
        return res.status(200).json(data);

    } catch (error) {
        console.error('Chat error:', error.message);
        return res.status(500).json({ error: 'Internal server error' });
    }
}
