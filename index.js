const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

// جلسات المستخدمين
const sessions = new Map();

// الخريطة التجريبية
const testMap = {
  nodes: [
    {
      id: '1', type: 'message',
      title: 'مرحباً بك في بوت FlowForge!',
      variableName: '', prompt: '', isPaused: false, fallbackNodeId: null
    },
    {
      id: '2', type: 'input',
      title: 'أدخل اسمك',
      variableName: 'customer_name',
      prompt: 'ما اسمك الكريم؟',
      isPaused: false, fallbackNodeId: null
    },
    {
      id: '3', type: 'message',
      title: 'أهلاً بك يا {customer_name}',
      variableName: '', prompt: '', isPaused: false, fallbackNodeId: null
    }
  ],
  connections: [
    { id: 'c1', from: '1', to: '2' },
    { id: 'c2', from: '2', to: '3' }
  ]
};

// دوال مساعدة
function getNextNodeId(currentNodeId, connections) {
  const conn = connections.find(c => c.from === currentNodeId);
  return conn ? conn.to : null;
}

function getNodeById(nodeId, nodes) {
  return nodes.find(n => n.id === nodeId);
}

function replaceVariables(template, variables) {
  return template.replace(/\{(\w+)\}/g, (_, key) => variables[key] || '');
}

async function sendMessage(chatId, text) {
  console.log('Sending to', chatId, ':', text);
  await axios.post(TELEGRAM_API + '/sendMessage', {
    chat_id: chatId,
    text: text
  });
}

// معالج الطلب الرئيسي
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook ready');
  }

  const { message } = req.body;
  if (!message || !message.text) {
    return res.status(200).end();
  }

  const chatId = message.chat.id;
  const userText = message.text;

  // ✅ استخراج storeId بشكل صحيح: آخر جزء من المسار
  const storeId = req.url.split('/').pop();

  // تجاهل المتاجر غير المعروفة
  if (storeId !== 'test') {
    return res.status(200).end();
  }

  const flow = testMap;
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
        // إرسال النص (بعد استبدال المتغيرات)
        await sendMessage(chatId, replaceVariables(currentNode.title, session.variables));

        // الانتقال للعقدة التالية
        const nextId = getNextNodeId(currentNode.id, connections);
        if (nextId) {
          session.currentNodeId = nextId;
          // إذا كانت العقدة التالية من نوع input، نرسل سؤال الإدخال فوراً
          const nextNode = getNodeById(nextId, nodes);
          if (nextNode && nextNode.type === 'input' && nextNode.prompt) {
            await sendMessage(chatId, nextNode.prompt);
          }
        }
        break;

      case 'input':
        // حفظ إجابة المستخدم
        if (currentNode.variableName) {
          session.variables[currentNode.variableName] = userText;
        }
        // الانتقال للعقدة التالية
        const nextInputId = getNextNodeId(currentNode.id, connections);
        if (nextInputId) {
          session.currentNodeId = nextInputId;
          const nextNode = getNodeById(nextInputId, nodes);
          if (nextNode) {
            if (nextNode.type === 'message') {
              await sendMessage(chatId, replaceVariables(nextNode.title, session.variables));
            } else if (nextNode.type === 'input' && nextNode.prompt) {
              await sendMessage(chatId, nextNode.prompt);
            }
          }
        }
        break;

      default:
        await sendMessage(chatId, 'نوع عقدة غير معروف.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    await sendMessage(chatId, 'حدث خطأ غير متوقع.');
  }

  // إرسال 200 OK بعد الانتهاء
  res.status(200).end();
};
