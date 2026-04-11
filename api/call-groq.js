// api/call-groq.js
const https = require('https');
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// Initialize Firebase Admin SDK (for rate limiting storage)
const adminJson = process.env.FIREBASE_ADMIN_JSON;
if (!adminJson) {
  console.error('FIREBASE_ADMIN_JSON not set');
} else {
  try {
    const serviceAccount = JSON.parse(adminJson);
    initializeApp({ credential: cert(serviceAccount) });
  } catch (err) {
    console.error('Failed to parse FIREBASE_ADMIN_JSON:', err.message);
  }
}
const db = getFirestore();

module.exports = async function handler(req, res) {
  // CORS – restrict to your frontend domain
  const allowedOrigin = 'https://my-business-ai.vercel.app';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Verify Firebase ID token
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const idToken = authHeader.split('Bearer ')[1];

  const firebaseApiKey = process.env.FIREBASE_API_KEY;
  if (!firebaseApiKey) {
    return res.status(500).json({ error: 'FIREBASE_API_KEY not configured' });
  }

  let userId;
  try {
    const verifyData = JSON.stringify({ idToken });
    const verifyRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:lookup?key=${firebaseApiKey}`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(verifyData)
        }
      };
      const request = https.request(options, (response) => {
        let raw = '';
        response.on('data', chunk => raw += chunk);
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(new Error(`Token verification failed: ${response.statusCode}`));
            return;
          }
          try {
            const parsed = JSON.parse(raw);
            if (parsed.users && parsed.users.length > 0) {
              resolve(parsed.users[0]);
            } else {
              reject(new Error('No user found'));
            }
          } catch (e) { reject(e); }
        });
      });
      request.on('error', reject);
      request.write(verifyData);
      request.end();
    });
    userId = verifyRes.localId;
  } catch (err) {
    console.error('Token verification error:', err.message);
    return res.status(401).json({ error: 'Invalid token' });
  }

  // 2. Rate limiting (10 requests per minute per user)
  const rateLimitRef = db.collection('rateLimits').doc(userId);
  const now = Date.now();
  const oneMinuteAgo = now - 60 * 1000;

  try {
    await db.runTransaction(async (transaction) => {
      const doc = await transaction.get(rateLimitRef);
      let timestamps = doc.exists ? doc.data().timestamps || [] : [];
      timestamps = timestamps.filter(ts => ts > oneMinuteAgo);
      if (timestamps.length >= 10) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      timestamps.push(now);
      transaction.set(rateLimitRef, { timestamps }, { merge: true });
    });
  } catch (err) {
    if (err.message === 'RATE_LIMIT_EXCEEDED') {
      return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
    }
    console.error('Rate limit error:', err);
    // fall through – allow request if rate check fails (avoid blocking users)
  }

  // 3. Parse request body
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { prompt, system, question } = body;
  const userPrompt = prompt || question;
  if (!userPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // 4. Call Groq API
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  const messages = [
    { role: 'system', content: system || 'You are a helpful business consultant.' },
    { role: 'user', content: userPrompt }
  ];

  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.7,
    max_tokens: 1024
  });

  try {
    const data = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.groq.com',
        path: '/openai/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
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
          } catch (e) { reject(new Error('Invalid JSON from Groq')); }
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
      res.status(500).json({ error: 'No reply from Groq' });
    }
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: 'AI generation failed' });
  }
};
