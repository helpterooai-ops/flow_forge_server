const axios = require('axios');

// في Vercel المتغيرات تُحقن تلقائياً، لا حاجة لـ dotenv
const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

// --------------------- جلسات المستخدمين ---------------------
const sessions = new Map();

// --------------------- خريطة تجريبية ---------------------
const testMap = {
  nodes: [
    {
      id: '1', type: 'message',
      title: 'مرحباً بك في بوت FlowForge!',
      subtitle: '', variableName: '', prompt: '', isPaused: false, fallbackNodeId: null,
      color: '', x: 0, y: 0
    },
    {
      id: '2', type: 'input',
      title: 'أدخل اسمك',
      subtitle: '',
      variableName: 'customer_name',
      prompt: 'ما اسمك الكريم؟',
      isPaused: false, fallbackNodeId: null,
      color: '', x: 0, y: 0
    },
    {
      id: '3', type: 'message',
      title: 'أهلاً بك يا {customer_name}',
      subtitle: '', variableName: '', prompt: '', isPaused: false, fallbackNodeId: null,
      color: '', x: 0, y: 0
    }
  ],
  connections: [
    { id: 'c1', from: '1', to: '2' },
    { id: 'c2', from: '2', to: '3' }
  ]
};

function getNextNodeId(nodeId, connections) {
  const conn = connections.find(c => c.from === nodeId);
  return conn ? conn.to : null;
}

function getNodeById(nodeId, nodes) {
  return nodes.find(n => n.id === nodeId);
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

async function classifyIntent(userText, options) {
  const prompt = 'أنت مصنف نوايا. الخيارات المتاحة: ' + options.join('، ') +
    '. صنف رسالة المستخدم التالية إلى أحد هذه الخيارات. أعد JSON فقط بالشكل: {"intent": "اسم_النية"}\n\nالرسالة: "' + userText + '"';
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + GEMINI_API_KEY;
  const resp = await axios.post(url, {
    contents: [{ parts: [{ text: prompt }] }]
  });
  const data = resp.data;
  const raw = data.candidates[0].content.parts[0].text;
  const parsed = JSON.parse(raw.trim());
  return parsed.intent;
}

// --------------------- معالج الطلب ---------------------
module.exports = async (req, res) => {
  // السماح فقط بطلبات POST
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook ready');
  }

  const { message } = req.body;
  if (!message || !message.text) {
    return res.status(200).end();
  }

  const chatId = message.chat.id;
  const userText = message.text;
  const storeId = req.url.split('/')[2];

  const flow = (storeId === 'test') ? testMap : null;
  if (!flow) {
    return res.status(200).end();
  }

  const nodes = flow.nodes;
  const connections = flow.connections;

  // تهيئة الجلسة
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { currentNodeId: nodes[0].id, variables: {} });
  }
  const session = sessions.get(chatId);
  const currentNode = getNodeById(session.currentNodeId, nodes);
  if (!currentNode) {
    await sendMessage(chatId, 'عذراً، حدث خطأ في المحادثة.');
    return res.status(200).end();
  }

  try {
    switch (currentNode.type) {
      case 'message':
        await sendMessage(chatId, replaceVariables(currentNode.title, session.variables));
        // الانتقال إلى العقدة التالية
        const nextMsgId = getNextNodeId(currentNode.id, connections);
        if (nextMsgId) {
          session.currentNodeId = nextMsgId;
          // إذا كانت العقدة التالية "إدخال"، نرسل السؤال فوراً
          const nextNode = getNodeById(nextMsgId, nodes);
          if (nextNode && nextNode.type === 'input' && nextNode.prompt) {
            await sendMessage(chatId, replaceVariables(nextNode.prompt, session.variables));
          }
        }
        break;

      case 'input':
        // حفظ القيمة المدخلة
        if (currentNode.variableName) {
          session.variables[currentNode.variableName] = userText;
        }
        // الانتقال إلى العقدة التالية
        const nextInpId = getNextNodeId(currentNode.id, connections);
        if (nextInpId) {
          session.currentNodeId = nextInpId;
          // إذا كانت العقدة التالية "رسالة"، نرسلها فوراً
          const nextNode = getNodeById(nextInpId, nodes);
          if (nextNode && nextNode.type === 'message') {
            await sendMessage(chatId, replaceVariables(nextNode.title, session.variables));
            // ثم ننتقل مجدداً إلى التي تليها إن وجدت
            const afterNextId = getNextNodeId(nextNode.id, connections);
            if (afterNextId) {
              session.currentNodeId = afterNextId;
              const afterNext = getNodeById(afterNextId, nodes);
              if (afterNext && afterNext.type === 'input' && afterNext.prompt) {
                await sendMessage(chatId, replaceVariables(afterNext.prompt, session.variables));
              }
            }
          }
        }
        break;

      case 'intent':
        const options = connections
          .filter(c => c.from === currentNode.id)
          .map(c => getNodeById(c.to, nodes)?.title)
          .filter(Boolean);
        const intent = await classifyIntent(userText, options);
        if (intent) {
          const matchedConn = connections.find(
            c => c.from === currentNode.id && getNodeById(c.to, nodes)?.title === intent
          );
          if (matchedConn) {
            session.currentNodeId = matchedConn.to;
            const newCurrent = getNodeById(matchedConn.to, nodes);
            if (newCurrent) {
              if (newCurrent.type === 'message') {
                await sendMessage(chatId, replaceVariables(newCurrent.title, session.variables));
              } else if (newCurrent.type === 'input' && newCurrent.prompt) {
                await sendMessage(chatId, replaceVariables(newCurrent.prompt, session.variables));
              }
            }
          } else {
            await sendMessage(chatId, 'لم أفهم قصدك، حاول مرة أخرى.');
          }
        } else {
          await sendMessage(chatId, 'عذراً، فشل التصنيف.');
        }
        break;

      default:
        await sendMessage(chatId, 'نوع عقدة غير معروف.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    await sendMessage(chatId, 'حدث خطأ غير متوقع.');
  }

  // ✅ نرسل 200 OK بعد الانتهاء من كل المعالجة
  res.status(200).end();
};
