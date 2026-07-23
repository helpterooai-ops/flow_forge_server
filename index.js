require('dotenv').config();
const axios = require('axios');

const TELEGRAM_API = 'https://api.telegram.org/bot' + process.env.BOT_TOKEN;

// --------------------- جلسات المستخدمين ---------------------
const sessions = new Map();

// --------------------- خريطة تجريبية ---------------------
const testMap = {
  nodes: [
    {
      id: '1', type: 'message', title: 'مرحباً بك في بوت FlowForge!', subtitle: 'سأقوم بأخذ اسمك الآن',
      variableName: '', prompt: '', isPaused: false, fallbackNodeId: null, color: '', x: 0, y: 0
    },
    {
      id: '2', type: 'input', title: 'أدخل اسمك', subtitle: '',
      variableName: 'customer_name', prompt: 'ما اسمك الكريم؟', isPaused: false, fallbackNodeId: null, color: '', x: 0, y: 0
    },
    {
      id: '3', type: 'message', title: 'أهلاً بك يا {customer_name}', subtitle: 'كيف يمكنني مساعدتك؟',
      variableName: '', prompt: '', isPaused: false, fallbackNodeId: null, color: '', x: 0, y: 0
    }
  ],
  connections: [
    { id: 'c1', from: '1', to: '2' },
    { id: 'c2', from: '2', to: '3' }
  ]
};

// استخراج العقدة التالية من الاتصالات
function getNextNodeId(currentNodeId, connections) {
  const conn = connections.find(c => c.from === currentNodeId);
  return conn ? conn.to : null;
}

function getNodeById(nodeId, nodes) {
  return nodes.find(n => n.id === nodeId);
}

// --------------------- معالجة الرسائل ---------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook ready');
  }

  res.status(200).end();

  const { message } = req.body;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userText = message.text;
  const storeId = req.url.split('/')[2];

  const flow = (storeId === 'test') ? testMap : null;
  if (!flow) return;

  const nodes = flow.nodes;
  const connections = flow.connections;

  if (!sessions.has(chatId)) {
    sessions.set(chatId, { currentNodeId: nodes[0].id, variables: {} });
  }

  const session = sessions.get(chatId);
  const currentNode = getNodeById(session.currentNodeId, nodes);
  if (!currentNode) return;

  try {
    switch (currentNode.type) {
      case 'message': {
        const text = replaceVariables(currentNode.title, session.variables);
        await sendMessage(chatId, text);
        const nextId = getNextNodeId(currentNode.id, connections);
        if (nextId) session.currentNodeId = nextId;
        break;
      }
      case 'input': {
        if (currentNode.variableName) {
          session.variables[currentNode.variableName] = userText;
        }
        if (currentNode.prompt) {
          const promptText = replaceVariables(currentNode.prompt, session.variables);
          await sendMessage(chatId, promptText);
        }
        const nextInputId = getNextNodeId(currentNode.id, connections);
        if (nextInputId) session.currentNodeId = nextInputId;
        break;
      }
      case 'intent': {
        const options = connections
          .filter(c => c.from === currentNode.id)
          .map(c => { const target = getNodeById(c.to, nodes); return target ? target.title : ''; })
          .filter(Boolean);
        const intent = await classifyIntent(userText, options);
        if (intent) {
          const matchedConn = connections.find(c => c.from === currentNode.id && getNodeById(c.to, nodes)?.title === intent);
          if (matchedConn) {
            session.currentNodeId = matchedConn.to;
          } else {
            await sendMessage(chatId, 'لم أفهم قصدك، حاول مرة أخرى.');
          }
        } else {
          await sendMessage(chatId, 'عذراً، فشل التصنيف.');
        }
        break;
      }
      default:
        await sendMessage(chatId, 'نوع عقدة غير معروف.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  }
};

// --------------------- دوال مساعدة ---------------------
async function sendMessage(chatId, text) {
  await axios.post(TELEGRAM_API + '/sendMessage', { chat_id: chatId, text: text });
}

function replaceVariables(template, variables) {
  return template.replace(/\{(\w+)\}/g, (_, key) => variables[key] || '');
}

async function classifyIntent(userText, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  const prompt = 'أنت مصنف نوايا. الخيارات المتاحة: ' + options.join('، ') +
    '. صنف رسالة المستخدم التالية إلى أحد هذه الخيارات. أعد JSON فقط بالشكل: {"intent": "اسم_النية"}\n\nالرسالة: "' + userText + '"';
  
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + apiKey;
  const response = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }]
  });

  const data = response.data;
  try {
    const raw = data.candidates[0].content.parts[0].text;
    const parsed = JSON.parse(raw.trim());
    return parsed.intent;
  } catch (e) {
    console.error('Gemini parsing error:', e);
    return null;
  }
}
