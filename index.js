const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

// ---------- ذاكرة التخزين المؤقت للتصنيف ----------
const intentCache = new Map();   // key: userId::userText, value: { intent, confidence }

// ---------- الخريطة التجريبية ----------
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

// ---------- دوال مساعدة ----------
function getNodeById(id, nodes) { return nodes.find(n => n.id === id); }
function replaceVariables(t, v) { return t.replace(/\{(\w+)\}/g, (_, k) => v[k] || ''); }

async function sendMessage(chatId, text) {
  await axios.post(TELEGRAM_API + '/sendMessage', { chat_id: chatId, text: text });
}

// ---------- تصنيف بالكلمات المفتاحية (مجاني 100%) ----------
function quickKeywordMatch(text) {
  const t = text.trim().toLowerCase();
  if (/مساعدة|دعم|ساعد|الغى|الغي|الغاء/.test(t)) return 'طلب مساعدة';
  if (/حالة|طلبي|تتبع|رقم الطلب|وين الطلب/.test(t)) return 'حالة الطلب';
  if (/شكوى|مشكلة|سيء|غاضب/.test(t)) return 'شكوى';
  return null;
}

// ---------- استدعاء Gemini مع ذاكرة مؤقتة ----------
async function classifyIntentGemini(userText, options, userId) {
  // تحقق من الذاكرة المؤقتة أولاً
  const cacheKey = `${userId}::${userText}`;
  if (intentCache.has(cacheKey)) {
    return intentCache.get(cacheKey);
  }

  // برومبت مختصر
  const prompt = `صنف النية للرسالة. الخيارات: ${options.join(', ')}. أعد JSON: {"intent":"...","confidence":0.0}`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const { data } = await axios.post(url, {
      contents: [{ parts: [{ text: `${prompt}\nالرسالة: "${userText}"` }] }],
      generationConfig: { temperature: 0.0, maxOutputTokens: 60 }
    }, { timeout: 5000 });

    const raw = data.candidates[0].content.parts[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);

    // نخزّن للاستخدام المستقبلي (حتى 100 عنصر)
    if (intentCache.size > 100) intentCache.clear();
    intentCache.set(cacheKey, result);

    return result;
  } catch (err) {
    console.error('Gemini error:', err.response?.status, err.message);
    return null;
  }
}

function getConnectionTarget(nodeId, connections, nodes) {
  const conn = connections.find(c => c.from === nodeId && !c.condition);
  return conn ? getNodeById(conn.to, nodes) : null;
}

// ---------- المعالج الرئيسي ----------
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

  // جلسة
  if (!sessions.has(chatId)) sessions.set(chatId, { currentNodeId: nodes[0].id, variables: {} });
  const session = sessions.get(chatId);
  const currentNode = getNodeById(session.currentNodeId, nodes);
  if (!currentNode) {
    await sendMessage(chatId, 'عذراً، فقدت مكانك في المحادثة. اكتب /start للبدء من جديد.');
    return res.status(200).end();
  }

  try {
    switch (currentNode.type) {
      case 'message':
        await sendMessage(chatId, replaceVariables(currentNode.title, session.variables));
        const nextMsg = getConnectionTarget(currentNode.id, connections, nodes);
        if (nextMsg) {
          session.currentNodeId = nextMsg.id;
          if (nextMsg.prompt) await sendMessage(chatId, replaceVariables(nextMsg.prompt, session.variables));
        }
        break;

      case 'input':
        if (currentNode.variableName) session.variables[currentNode.variableName] = userText;
        const nextInp = getConnectionTarget(currentNode.id, connections, nodes);
        if (nextInp) {
          session.currentNodeId = nextInp.id;
          if (nextInp.type === 'message') {
            await sendMessage(chatId, replaceVariables(nextInp.title, session.variables));
          } else if (nextInp.prompt) {
            await sendMessage(chatId, replaceVariables(nextInp.prompt, session.variables));
          }
        }
        break;

      case 'intent': {
        const options = connections
          .filter(c => c.from === currentNode.id && c.condition && c.condition !== 'fallback')
          .map(c => c.condition);
        const fallbackConn = connections.find(c => c.from === currentNode.id && c.condition === 'fallback');

        // 1) فلتر الكلمات
        let intent = quickKeywordMatch(userText);
        let confidence = 1.0;

        // 2) Gemini (مع ذاكرة مؤقتة)
        if (!intent) {
          const geminiRes = await classifyIntentGemini(userText, options, chatId);
          if (geminiRes && geminiRes.confidence >= 0.7 && options.includes(geminiRes.intent)) {
            intent = geminiRes.intent;
            confidence = geminiRes.confidence;
          }
        }

        // 3) اتخذ الإجراء
        if (intent && options.includes(intent)) {
          const matched = connections.find(c => c.from === currentNode.id && c.condition === intent);
          if (matched) {
            session.currentNodeId = matched.to;
            const targetNode = getNodeById(matched.to, nodes);
            if (targetNode) {
              if (targetNode.type === 'message') {
                await sendMessage(chatId, replaceVariables(targetNode.title, session.variables));
              } else if (targetNode.prompt) {
                await sendMessage(chatId, replaceVariables(targetNode.prompt, session.variables));
              }
            }
          }
        } else {
          // Fallback
          if (fallbackConn) {
            const fbNode = getNodeById(fallbackConn.to, nodes);
            if (fbNode) {
              session.currentNodeId = fbNode.id;
              await sendMessage(chatId, replaceVariables(fbNode.title, session.variables));
            }
          } else {
            await sendMessage(chatId, 'لم أفهم قصدك، حاول مجدداً.');
          }
        }
        break;
      }
    }
  } catch (err) {
    console.error('Unexpected error:', err.message);
    await sendMessage(chatId, 'حدث خطأ غير متوقع. حاول مرة أخرى.');
  }

  res.status(200).end();
};
