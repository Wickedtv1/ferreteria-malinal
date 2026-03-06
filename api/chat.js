const ODOO_URL = 'https://ferreteriamalinal.odoo.com';

async function searchOdooInventory(query) {
    try {
          const apiKey = process.env.ODOO_API_KEY;
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
    if (req.method !== 'POST') {
          return res.status(405).json({ error: 'Method not allowed' });
    }

  const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
          return res.status(400).json({ error: 'Invalid request' });
    }

  try {
        // Check if the latest user message is asking about a product
      const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
        let inventoryContext = '';

      if (lastUserMsg) {
              const text = lastUserMsg.content;
              const productKeywords = /tienen|hay|stock|precio|costo|cuanto|disponible|tienes|busco|necesito|quiero|cuantos|existe|venden/i;
              if (productKeywords.test(text)) {
                        // Extract likely product name - remove question words
                const cleaned = text
                          .replace(/tienen|hay|el|la|los|las|un|una|del|de|en|stock|precio|costo|cuanto|disponible|tienes|busco|necesito|quiero|cuantos|existe|venden|\?/gi, '')
                          .trim();
                        if (cleaned.length > 2) {
                                    const results = await searchOdooInventory(cleaned);
                                    if (results && results.length > 0) {
                                                  inventoryContext = '\n\n[INVENTARIO EN TIEMPO REAL - usa esta info para responder]:\n' +
                                                                  results.map(p =>
                                                                                    `• ${p.name}${p.sku ? ` (SKU: ${p.sku})` : ''} - Precio: ${p.price} - Stock: ${p.stock > 0 ? p.stock + ' unidades disponibles' : 'SIN STOCK'}`
                                                                                            ).join('\n');
                                    } else if (results !== null) {
                                                  inventoryContext = '\n\n[INVENTARIO: No se encontraron productos que coincidan con "' + cleaned + '" en nuestro sistema.]';
                                    }
                        }
              }
      }

      // Build system prompt with live inventory context
      const systemPrompt = `Eres un asistente de ventas bilingüe (español/inglés) de Ferretería Malinal, una ferretería en Valle Dorado, Nayarit, México. Ayuda a los clientes a encontrar productos, responde preguntas sobre herramientas, plomería, pintura, materiales de construcción, eléctrico y artículos de ferretería. Teléfono: +52 322 303 1895, correo: ferreteriamalinal@icloud.com, horario: Lunes-Sábado 8am-7pm, dirección: Av. Valle De México #2 Int. 6, Col. Valle Dorado. Sé breve, útil y amigable. Sugiere productos relacionados cuando sea relevante. Si un cliente pregunta por un producto, menciona el precio y disponibilidad exactos del inventario. Si el producto no tiene stock, ofrece alternativas o sugiere que contacten a la tienda.${inventoryContext}`;

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
                        messages: messages
              })
      });

      if (!response.ok) {
              const error = await response.text();
              return res.status(response.status).json({ error: 'API error', details: error });
      }

      const data = await response.json();
        return res.status(200).json(data);

  } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({ error: 'Internal server error' });
  }
}
