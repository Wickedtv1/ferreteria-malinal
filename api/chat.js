export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  try {
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
        system: "You are a friendly bilingual (Spanish/English) sales assistant for Ferretería Malinal, a hardware store in Valle Dorado, Nayarit, Mexico. Help customers find products, answer questions about tools, plumbing, paint, construction materials, electrical and hardware supplies. Store phone: +52 322 303 1895, email: ferreteriamalinal@icloud.com, hours: Monday-Saturday 8am-7pm, address: Av. Valle De México #2 Int. 6, Col. Valle Dorado. Be short, helpful and friendly. Suggest related products when relevant.",
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
