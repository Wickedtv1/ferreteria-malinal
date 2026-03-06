const ODOO_URL = 'https://ferreteriamalinal.odoo.com';
const ODOO_DB = 'ferreteriamalinal';

async function odooCall(model, method, args, kwargs = {}) {
    const apiKey = process.env.ODOO_API_KEY;
    const res = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
                  jsonrpc: '2.0', method: 'call', id: 1,
                  params: {
                            model, method, args, kwargs,
                            context: { lang: 'es_MX' }
                  }
          }),
          // Use API key via basic auth (Odoo 16+ supports apikey as password)
    });
    const data = await res.json();
    if (data.error) throw new Error(JSON.stringify(data.error));
    return data.result;
}

async function odooAuthenticate() {
    const apiKey = process.env.ODOO_API_KEY;
    const res = await fetch(`${ODOO_URL}/web/session/authenticate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
                  jsonrpc: '2.0', method: 'call', id: 1,
                  params: { db: ODOO_DB, login: 'ferreteriamalinal@icloud.com', password: apiKey }
          })
    });
    const data = await res.json();
    return data.result;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();

  try {
        const apiKey = process.env.ODOO_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

      const { action, search, limit = 80, offset = 0, category } = req.method === 'POST'
          ? req.body
              : req.query;

      // Build domain filter
      let domain = [['sale_ok', '=', true], ['active', '=', true]];
        if (search) {
                domain.push('|');
                domain.push(['name', 'ilike', search]);
                domain.push(['default_code', 'ilike', search]);
        }

      // Use Odoo JSON-RPC with API key authentication
      const authHeader = 'Basic ' + Buffer.from(`ferreteriamalinal@icloud.com:${apiKey}`).toString('base64');

      if (action === 'search' || action === 'list' || !action) {
              // Search/list products
          const searchRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
                    method: 'POST',
                    headers: {
                                'Content-Type': 'application/json',
                                'Authorization': authHeader
                    },
                    body: JSON.stringify({
                                jsonrpc: '2.0', method: 'call', id: 1,
                                params: {
                                              model: 'product.template',
                                              method: 'search_read',
                                              args: [domain],
                                              kwargs: {
                                                              fields: ['id', 'name', 'default_code', 'list_price', 'qty_available',
                                                                                              'description_sale', 'categ_id', 'image_128', 'active'],
                                                              limit: parseInt(limit),
                                                              offset: parseInt(offset),
                                                              order: 'name asc'
                                              }
                                }
                    })
          });
              const data = await searchRes.json();
              if (data.error) return res.status(400).json({ error: data.error.message || 'Odoo error' });

          const products = (data.result || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    sku: p.default_code || '',
                    price: p.list_price,
                    stock: p.qty_available,
                    description: p.description_sale || '',
                    category: p.categ_id ? p.categ_id[1] : 'General',
                    image: p.image_128 ? `data:image/png;base64,${p.image_128}` : null
          }));

          return res.status(200).json({ products, count: products.length });
      }

      if (action === 'check') {
              // Check specific product availability (for AI / WhatsApp)
          const { product_id, product_name } = req.method === 'POST' ? req.body : req.query;
              let checkDomain = [['active', '=', true]];
              if (product_id) checkDomain.push(['id', '=', parseInt(product_id)]);
              else if (product_name) {
                        checkDomain.push('|');
                        checkDomain.push(['name', 'ilike', product_name]);
                        checkDomain.push(['default_code', 'ilike', product_name]);
              }

          const checkRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                    body: JSON.stringify({
                                jsonrpc: '2.0', method: 'call', id: 1,
                                params: {
                                              model: 'product.template',
                                              method: 'search_read',
                                              args: [checkDomain],
                                              kwargs: {
                                                              fields: ['id', 'name', 'default_code', 'list_price', 'qty_available', 'description_sale'],
                                                              limit: 10
                                              }
                                }
                    })
          });
              const checkData = await checkRes.json();
              if (checkData.error) return res.status(400).json({ error: checkData.error.message });

          const results = (checkData.result || []).map(p => ({
                    id: p.id,
                    name: p.name,
                    sku: p.default_code || '',
                    price: p.list_price,
                    stock: p.qty_available,
                    in_stock: p.qty_available > 0,
                    description: p.description_sale || ''
          }));

          return res.status(200).json({ results, found: results.length });
      }

      if (action === 'order') {
              // Create a sale order in Odoo (from checkout or WhatsApp)
          const { customer_name, customer_phone, customer_email, items, notes } = req.body;
              if (!items || !items.length) return res.status(400).json({ error: 'No items provided' });

          // Find or create partner
          const partnerSearchRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                    body: JSON.stringify({
                                jsonrpc: '2.0', method: 'call', id: 1,
                                params: {
                                              model: 'res.partner',
                                              method: 'search_read',
                                              args: [[['phone', '=', customer_phone]]],
                                              kwargs: { fields: ['id', 'name'], limit: 1 }
                                }
                    })
          });
              const partnerData = await partnerSearchRes.json();
              let partnerId;

          if (partnerData.result && partnerData.result.length > 0) {
                    partnerId = partnerData.result[0].id;
          } else {
                    // Create new partner
                const createPartnerRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                            body: JSON.stringify({
                                          jsonrpc: '2.0', method: 'call', id: 1,
                                          params: {
                                                          model: 'res.partner',
                                                          method: 'create',
                                                          args: [{ name: customer_name || 'Cliente Web', phone: customer_phone, email: customer_email || '' }],
                                                          kwargs: {}
                                          }
                            })
                });
                    const createData = await createPartnerRes.json();
                    partnerId = createData.result;
          }

          // Build order lines
          const orderLines = items.map(item => [0, 0, {
                    product_id: item.product_id,
                    product_uom_qty: item.quantity,
                    price_unit: item.price
          }]);

          // Create sale order
          const orderRes = await fetch(`${ODOO_URL}/web/dataset/call_kw`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': authHeader },
                    body: JSON.stringify({
                                jsonrpc: '2.0', method: 'call', id: 1,
                                params: {
                                              model: 'sale.order',
                                              method: 'create',
                                              args: [{
                                                              partner_id: partnerId,
                                                              order_line: orderLines,
                                                              note: notes || 'Pedido desde sitio web',
                                                              origin: 'Website / WhatsApp'
                                              }],
                                              kwargs: {}
                                }
                    })
          });
              const orderData = await orderRes.json();
              if (orderData.error) return res.status(400).json({ error: orderData.error.message });

          return res.status(200).json({ success: true, order_id: orderData.result, partner_id: partnerId });
      }

      return res.status(400).json({ error: 'Unknown action. Use: list, search, check, order' });

  } catch (err) {
        console.error('Products API error:', err);
        return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
