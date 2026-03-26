const https = require('https');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'GROQ_API_KEY not configured' });

  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);

    const systemPrompt = body.system || 'You are a helpful business consultant.';
    const userPrompt = body.prompt || body.question || '';

    const payload = JSON.stringify({
      model: 'llama-3.3-70b-versatile',   // <-- active model
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 1024
    });

    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Groq API error ${response.statusCode}: ${raw}`));
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error('Invalid JSON from Groq'));
          }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });

    const reply = data.choices?.[0]?.message?.content;
    if (reply) {
      res.status(200).json({ output: reply });
    } else {
      res.status(500).json({ error: 'No reply from Groq', raw: data });
    }

  } catch (e) {
    console.error('Groq error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
