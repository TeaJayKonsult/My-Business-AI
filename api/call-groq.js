// api/call-groq.js
const https = require('https');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

module.exports = async function handler(req, res) {
  // CORS – allow your frontend domain (or keep * for now)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Get Supabase auth token from Authorization header
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.split('Bearer ')[1];

  // Verify token and get user
  const { data: { user }, error: userError } = await supabaseAdmin.auth.getUser(token);
  if (userError || !user) {
    console.error('Auth error:', userError);
    return res.status(401).json({ error: 'Invalid token' });
  }
  const userId = user.id;

  // Parse request body
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
    const { data: newConv, error: convError } = await supabaseAdmin
      .from('conversations')
      .insert({ user_id: userId, title: 'New Chat' })
      .select('id')
      .single();
    if (convError) {
      console.error('Create conversation error:', convError);
      return res.status(500).json({ error: 'Failed to create conversation' });
    }
    activeConversationId = newConv.id;
  } else {
    // Verify conversation belongs to user
    const { data: conv, error: checkError } = await supabaseAdmin
      .from('conversations')
      .select('id')
      .eq('id', activeConversationId)
      .eq('user_id', userId)
      .single();
    if (checkError || !conv) {
      return res.status(403).json({ error: 'Conversation not found or access denied' });
    }
  }

  // Save user message
  await supabaseAdmin
    .from('messages')
    .insert({ conversation_id: activeConversationId, role: 'user', content: userPrompt });

  // Call Groq API
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
          } catch (e) {
            reject(new Error('Invalid JSON from Groq'));
          }
        });
      });
      request.on('error', reject);
      request.write(payload);
      request.end();
    });
    const reply = groqResponse.choices?.[0]?.message?.content;
    if (!reply) {
      throw new Error('No reply from Groq');
    }

    // Save assistant message
    await supabaseAdmin
      .from('messages')
      .insert({ conversation_id: activeConversationId, role: 'assistant', content: reply });

    // Update conversation's updated_at and maybe title (if first user message)
    if (!conversationId) {
      // New conversation: set title from first user message
      const newTitle = userPrompt.slice(0, 30) + (userPrompt.length > 30 ? '…' : '');
      await supabaseAdmin
        .from('conversations')
        .update({ title: newTitle, updated_at: new Date().toISOString() })
        .eq('id', activeConversationId);
    } else {
      await supabaseAdmin
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', activeConversationId);
    }

    res.status(200).json({ output: reply, conversationId: activeConversationId });
  } catch (err) {
    console.error('Groq error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
