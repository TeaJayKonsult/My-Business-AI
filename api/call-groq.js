// api/call-groq.js
const https = require('https');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_JSON);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

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

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const { prompt, system, question, conversationId } = body;
  const userPrompt = prompt || question;
  if (!userPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // Get or create conversation
  let activeConversationId = conversationId;
  if (!activeConversationId) {
    const convRef = db.collection('users').doc(userId).collection('conversations').doc();
    activeConversationId = convRef.id;
    await convRef.set({
      title: 'New Chat',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      messages: []
    });
  } else {
    // Verify conversation belongs to user
    const convDoc = await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId).get();
    if (!convDoc.exists) {
      return res.status(403).json({ error: 'Conversation not found' });
    }
  }

  // Save user message
  const userMessage = { role: 'user', content: userPrompt, timestamp: new Date().toISOString() };
  await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId)
    .update({
      messages: admin.firestore.FieldValue.arrayUnion(userMessage),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

  // Call Groq
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
    const groqResponse = await new Promise((resolve, reject) => {
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
    const reply = groqResponse.choices?.[0]?.message?.content;
    if (!reply) throw new Error('No reply from Groq');

    // Save assistant message
    const assistantMessage = { role: 'assistant', content: reply, timestamp: new Date().toISOString() };
    await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId)
      .update({
        messages: admin.firestore.FieldValue.arrayUnion(assistantMessage),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });

    // Update title if it's the first user message
    const convDoc = await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId).get();
    if (convDoc.data().title === 'New Chat') {
      const newTitle = userPrompt.slice(0, 30) + (userPrompt.length > 30 ? '…' : '');
      await convDoc.ref.update({ title: newTitle });
    }

    res.status(200).json({ output: reply, conversationId: activeConversationId });
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
