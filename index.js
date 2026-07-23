const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

const sessions = new Map();

// ----- الخريطة التجريبية الجديدة مع Intent -----
const testMap = {
  nodes: [
    { id: '1', type: 'message', title: 'مرحباً بك في بوت FlowForge!', prompt: '', variableName: '', isPaused: false, fallbackNodeId: null },
    { id: '2', type: 'input',   title: 'أدخل اسمك', prompt: 'ما اسمك الكريم؟', variableName: 'customer_name', isPaused: false, fallbackNodeId: null },
    { id: '3', type: 'intent',  title: 'تصنيف الطلب', prompt: 'كيف يمكنني مساعدتك يا {customer_name}؟', variableName: '', isPaused: false, fallbackNodeId: 'fallback' },
    { id: '4', type: 'message', title: 'حسناً، إليك تفاصيل المساعدة التي طلبتها.', prompt: '', variableName: '', isPaused: false, fallbackNodeId: null },
    { id: 'fallback', type: 'message', title: 'عذراً، لم أفهم قصدك. يمكنك طلب "مساعدة" أو "حالة الطلب".', prompt: '', variableName: '', isPaused: false, fallbackNodeId: null }
  ],
  connections: [
    { from: '1', to: '2' },
    { from: '2', to: '3' },
    { from: '3', to: '4', condition: 'طلب مساعدة' },
    { from: '3', to: 'fallback', condition: 'fallback' }
  ]
};

// ----- الدوال المساعدة -----
function getNodeById(id, nodes) {
  return nodes.find(n => n.id === id);
}

function replaceVariables(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || '');
}

async function sendMessage(chatId, text) {
  console.log('Sending to', chatId, ':', text);
  await axios.post(TELEGRAM_API + '/sendMessage', {
    chat_id: chatId,
    text: text
  });
}

// استدعاء Gemini مع طلب مخرج JSON
async function classifyIntent(userText, options) {
  const prompt = `أنت مصنف نوايا دقيق. صنف رسالة المستخدم إلى أحد هذه النوايا: [${options.join(', ')}].
أعد JSON فقط بدون أي نص آخر، بالشكل:
{"intent":"اسم_النية","confidence":0.9}

الرسالة: "${userText}"`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  const response = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.0 }
  });

  const raw = response.data.candidates[0].content.parts[0].text;
  const cleaned = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Gemini parse error:', cleaned);
    return null;
  }
}

// ----- المعالج الرئيسي -----
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Webhook ready');

  const { message } = req.body;
  if (!message || !message.text) return res.status(200).end();

  const chatId = message.chat.id;
  const userText = message.text;
  const storeId = req.url.split('/').pop();
  if (storeId !== 'test') return res.status(200).end();

  const flow = testMap;
  const { nodes, connections } = flow;

  if (!sessions.has(chatId)) {
    sessions.set(chatId, { currentNodeId: nodes[0].id, variables: {} });
  }
  const session = sessions.get(chatId);
  const currentNode = getNodeById(session.currentNodeId, nodes);
  if (!currentNode) {
    await sendMessage(chatId, 'حدث خطأ في المحادثة.');
    return res.status(200).end();
  }

  try {
    switch (currentNode.type) {
      case 'message':
        await sendMessage(chatId, replaceVariables(currentNode.title, session.variables));
        const nextMsg = getConnectionTarget(currentNode.id, connections, nodes, null);
        if (nextMsg) session.currentNodeId = nextMsg.id;
        if (nextMsg && nextMsg.type === 'input' && nextMsg.prompt) {
          await sendMessage(chatId, replaceVariables(nextMsg.prompt, session.variables));
        } else if (nextMsg && nextMsg.type === 'intent' && nextMsg.prompt) {
          await sendMessage(chatId, replaceVariables(nextMsg.prompt, session.variables));
        }
        break;

      case 'input':
        if (currentNode.variableName) {
          session.variables[currentNode.variableName] = userText;
        }
        const nextInp = getConnectionTarget(currentNode.id, connections, nodes, null);
        if (nextInp) session.currentNodeId = nextInp.id;
        if (nextInp && nextInp.type === 'message') {
          await sendMessage(chatId, replaceVariables(nextInp.title, session.variables));
        } else if (nextInp && nextInp.type === 'intent' && nextInp.prompt) {
          await sendMessage(chatId, replaceVariables(nextInp.prompt, session.variables));
        }
        break;

      case 'intent':
        // جمع الخيارات المتاحة من الاتصالات التي لها شرط (condition)
        const options = connections
          .filter(c => c.from === currentNode.id && c.condition && c.condition !== 'fallback')
          .map(c => c.condition);
        const fallbackConn = connections.find(c => c.from === currentNode.id && c.condition === 'fallback');
        
        const result = await classifyIntent(userText, options);
        if (result && result.confidence >= 0.6 && options.includes(result.intent)) {
          const matched = connections.find(c => c.from === currentNode.id && c.condition === result.intent);
          if (matched) {
            const nextNode = getNodeById(matched.to, nodes);
            if (nextNode) {
              session.currentNodeId = nextNode.id;
              await sendMessage(chatId, replaceVariables(nextNode.title, session.variables));
            }
          }
        } else {
          // ثقة منخفضة أو غير معروف -> Fallback
          if (fallbackConn) {
            const fallbackNode = getNodeById(fallbackConn.to, nodes);
            if (fallbackNode) {
              session.currentNodeId = fallbackNode.id;
              await sendMessage(chatId, replaceVariables(fallbackNode.title, session.variables));
            }
          } else {
            await sendMessage(chatId, 'لم أفهم قصدك، حاول مجدداً.');
          }
        }
        break;

      default:
        await sendMessage(chatId, 'نوع عقدة غير معروف.');
    }
  } catch (err) {
    console.error('Error:', err.response?.data || err.message);
    await sendMessage(chatId, 'حدث خطأ غير متوقع.');
  }

  res.status(200).end();
};

// استخراج العقدة التالية بناءً على الاتصالات (بدون شرط للمسارات المباشرة)
function getConnectionTarget(nodeId, connections, nodes) {
  const conn = connections.find(c => c.from === nodeId && !c.condition);
  return conn ? getNodeById(conn.to, nodes) : null;
}
