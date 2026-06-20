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

  // ====== VERIFY FIREBASE TOKEN ======
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

  // ====== PARSE REQUEST BODY ======
  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const { prompt, system, question, conversationId, user, business, type, topic, history } = body;
  const userPrompt = prompt || question;
  if (!userPrompt) {
    return res.status(400).json({ error: 'No prompt provided' });
  }

  // ====== DETECT IF WE NEED STRUCTURED OUTPUT ======
  const isBlueprintRequest = userPrompt.toLowerCase().includes('blueprint') ||
    userPrompt.toLowerCase().includes('business idea') ||
    userPrompt.toLowerCase().includes('target audience') ||
    userPrompt.toLowerCase().includes('business plan') ||
    userPrompt.toLowerCase().includes('marketing plan') ||
    userPrompt.toLowerCase().includes('financial forecast') ||
    userPrompt.toLowerCase().includes('competitor analysis');

  const isRoadmapRequest = userPrompt.toLowerCase().includes('roadmap') ||
    userPrompt.toLowerCase().includes('step-by-step') ||
    userPrompt.toLowerCase().includes('phases');

  let needStructuredOutput = isBlueprintRequest || isRoadmapRequest;

  // ====== BUILD MESSAGES (FIXED) ======
  const messages = [
    { role: 'system', content: system || 'You are a helpful business consultant.' }
  ];

  // Add conversation history if provided (last 10 messages)
  if (history && history.length > 0) {
    const recent = history.slice(-10);
    let lastRole = 'system'; // start with system

    for (const msg of recent) {
      // Skip messages without content
      const content = msg.text || msg.content;
      if (!content) continue;

      // Determine role
      let role = msg.role === 'user' ? 'user' : 'assistant';
      if (role === 'user' && lastRole === 'user') {
        // If we have two user messages in a row, insert a placeholder assistant message
        messages.push({ role: 'assistant', content: 'I understand. Please continue.' });
        lastRole = 'assistant';
      }
      if (role === 'assistant' && lastRole === 'assistant') {
        // If we have two assistant messages in a row, skip the duplicate
        continue;
      }

      messages.push({ role, content });
      lastRole = role;
    }
  }

  // Add the current user prompt
  if (messages.length > 0 && messages[messages.length - 1].role === 'user') {
    // If the last message is already a user, we need to insert an assistant message
    // (shouldn't happen with the logic above, but just in case)
    messages.push({ role: 'assistant', content: 'I understand. Let me think about that.' });
  }
  messages.push({ role: 'user', content: userPrompt });

  // ====== ADD STRUCTURED OUTPUT INSTRUCTIONS ======
  let structuredPrompt = '';
  if (isBlueprintRequest) {
    structuredPrompt = `
    IMPORTANT: You must extract structured business insights from the conversation and return them in a JSON object with the following schema:
    {
      "blueprint": {
        "businessIdea": "string - the core business idea",
        "targetAudience": "string - who the business serves",
        "problem": "string - the problem being solved",
        "solution": "string - how the business solves the problem",
        "revenueModel": "string - how the business makes money",
        "marketingStrategy": "string - how the business attracts customers"
      }
    }
    Only include the "blueprint" field if you can confidently extract at least 3 of these fields from the conversation. Otherwise, omit it. Also provide your main response as "text" field in the JSON.`;
  } else if (isRoadmapRequest) {
    structuredPrompt = `
    IMPORTANT: You must generate a structured roadmap and return it in a JSON object with the following schema:
    {
      "roadmap": {
        "phases": [
          {
            "phaseName": "string - name of the phase",
            "steps": [
              { "stepName": "string - actionable step", "completed": false }
            ]
          }
        ]
      }
    }
    The roadmap should have 3-5 phases, each with 2-4 actionable steps. Also provide your main response as "text" field in the JSON.`;
  }

  if (structuredPrompt) {
    // Only add to the system message if it's not already there
    if (!messages[0].content.includes('IMPORTANT:')) {
      messages[0].content += '\n\n' + structuredPrompt;
    }
  }

  // ====== CALL GROQ API ======
  const groqApiKey = process.env.GROQ_API_KEY;
  if (!groqApiKey) {
    return res.status(500).json({ error: 'GROQ_API_KEY not configured' });
  }

  const payload = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages,
    temperature: 0.7,
    max_tokens: 2500,
    response_format: needStructuredOutput ? { type: 'json_object' } : undefined
  });

  let reply, blueprint, roadmap;

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

    const content = groqResponse.choices?.[0]?.message?.content;
    if (!content) throw new Error('No reply from Groq');

    // ====== PARSE RESPONSE ======
    if (needStructuredOutput) {
      try {
        const parsed = JSON.parse(content);
        reply = parsed.text || 'I have prepared the requested information.';
        if (parsed.blueprint) {
          blueprint = parsed.blueprint;
        }
        if (parsed.roadmap) {
          roadmap = parsed.roadmap;
        }
        if (!parsed.text) {
          reply = content;
        }
      } catch (e) {
        reply = content;
        console.warn('Failed to parse JSON response:', e.message);
      }
    } else {
      reply = content;
    }

  } catch (err) {
    console.error('Groq error:', err.message);
    return res.status(500).json({ error: err.message });
  }

  // ====== GET OR CREATE CONVERSATION ======
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
    const convDoc = await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId).get();
    if (!convDoc.exists) {
      return res.status(403).json({ error: 'Conversation not found' });
    }
  }

  // ====== SAVE USER MESSAGE ======
  const userMessage = { role: 'user', content: userPrompt, timestamp: new Date().toISOString() };
  await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId)
    .update({
      messages: admin.firestore.FieldValue.arrayUnion(userMessage),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

  // ====== SAVE ASSISTANT MESSAGE ======
  const assistantMessage = { role: 'assistant', content: reply, timestamp: new Date().toISOString() };
  await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId)
    .update({
      messages: admin.firestore.FieldValue.arrayUnion(assistantMessage),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

  // ====== UPDATE TITLE ======
  const convDoc = await db.collection('users').doc(userId).collection('conversations').doc(activeConversationId).get();
  if (convDoc.data().title === 'New Chat') {
    const newTitle = userPrompt.slice(0, 30) + (userPrompt.length > 30 ? '…' : '');
    await convDoc.ref.update({ title: newTitle });
  }

  // ====== SAVE BLUEPRINT & ROADMAP TO USER DOCUMENT ======
  if (blueprint) {
    try {
      await db.collection('users').doc(userId).set({
        blueprint: blueprint,
        blueprintUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.warn('Failed to save blueprint:', err.message);
    }
  }

  if (roadmap) {
    try {
      await db.collection('users').doc(userId).set({
        roadmap: roadmap,
        roadmapUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } catch (err) {
      console.warn('Failed to save roadmap:', err.message);
    }
  }

  // ====== RESPONSE ======
  const response = {
    output: reply,
    conversationId: activeConversationId
  };

  if (blueprint) response.blueprint = blueprint;
  if (roadmap) response.roadmap = roadmap;

  res.status(200).json(response);
};
