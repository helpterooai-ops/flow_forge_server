require('dotenv').config();
const axios = require('axios');

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// --------------------- جلسات المستخدمين ---------------------
const sessions = new Map();

// --------------------- خريطة تجريبية ---------------------
const testMap = {
  nodes: [
    {
      id: '1',
      type: 'message',
      title: 'مرحباً بك في بوت FlowForge!',
      subtitle: 'سأقوم بأخذ اسمك الآن',
      variableName: '',
      prompt: '',
      isPaused: false,
      fallbackNodeId: null,
      color: '',
      x: 0, y: 0
    },
    {
      id: '2',
      type: 'input',
      title: 'أدخل اسمك',
      subtitle: '',
      variableName: 'customer_name',
      prompt: 'ما اسمك الكريم؟',
      isPaused: false,
      fallbackNodeId: null,
      color: '',
      x: 0, y: 0
    },
    {
      id: '3',
      type: 'message',
      title: 'أهلاً بك يا {customer_name}',
      subtitle: 'كيف يمكنني مساعدتك؟',
      variableName: '',
      prompt: '',
      isPaused: false,
      fallbackNodeId: null,
      color: '',
      x: 0, y: 0
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

// البحث عن عقدة بمعرفها
function getNodeById(nodeId, nodes) {
  return nodes.find(n => n.id === nodeId);
}

// --------------------- معالجة الرسائل ---------------------
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).send('Webhook ready');
  }

  // ✅ الرد فوراً بـ 200 OK (لتجنب إعادة الإرسال)
  res.status(200).end();

  const { message } = req.body;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const userText = message.text;
  const storeId = req.url.split('/')[2]; // الحصول على معرف المتجر

  // استخدام الخريطة التجريبية للمتجر "test" فقط
  const flow = (storeId === 'test') ? testMap : null;
  if (!flow) return;

  const nodes = flow.nodes;
  const connections = flow.connections;

  // استرداد جلسة المستخدم أو إنشاء واحدة
  if (!sessions.has(chatId)) {
    // بداية جديدة: نبدأ من أول عقدة
    const startNodeId = nodes[0].id;
    sessions.set(chatId, {
      currentNodeId: startNodeId,
      variables: {}
    });
  }

  const session = sessions.get(chatId);
  const currentNode = getNodeById(session.currentNodeId, nodes);

  if (!currentNode) {
    await sendMessage(chatId, 'عذراً، حدث خطأ في المحادثة.');
    return;
  }

  try {
    // ------------------ التعامل حسب نوع العقدة ------------------
    switch (currentNode.type) {
      case 'message':
        // إرسال النص الموجود في العقدة (بعد استبدال المتغيرات)
        const text = replaceVariables(currentNode.title, session.variables);
        await sendMessage(chatId, text);
        // الانتقال إلى العقدة التالية
        const nextId = getNextNodeId(currentNode.id, connections);
        if (nextId) {
          session.currentNodeId = nextId;
        }
        break;

      case 'input':
        // حفظ القيمة المُدخلة من المستخدم في المتغير
        if (currentNode.variableName) {
          session.variables[currentNode.variableName] = userText;
        }
        // إرسال رسالة تأكيد (يمكن أن تكون فارغة)
        if (currentNode.prompt) {
          const promptText = replaceVariables(currentNode.prompt, session.variables);
          await sendMessage(chatId, promptText);
        }
        // الانتقال إلى العقدة التالية
        const nextInputId = getNextNodeId(currentNode.id, connections);
        if (nextInputId) {
          session.currentNodeId = nextInputId;
        }
        break;

      case 'intent':
        // تجميع الخيارات الممكنة (عناوين العقد المرتبطة)
        const options = connections
          .filter(c => c.from === currentNode.id)
          .map(c => {
            const targetNode = getNodeById(c.to, nodes);
            return targetNode ? targetNode.title : '';
          })
          .filter(Boolean);
        
        // استدعاء Gemini لتصنيف النية
        const intent = await classifyIntent(userText, options);
        if (intent) {
          const matchedConn = connections.find(
            c => c.from === currentNode.id && getNodeById(c.to, nodes)?.title === intent
          );
          if (matchedConn) {
            session.currentNodeId = matchedConn.to;
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
  }
};

// --------------------- دوال مساعدة ---------------------

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}

function replaceVariables(template, variables) {
  return template.replace(/\{(\w+)\}/g, (_, key) => variables[key] || '');
}

async function classifyIntent(userText, options) {
  const apiKey = process.env.GEMINI_API_KEY;
  const prompt = `أنت مصنف نوايا. الخيارات المتاحة: ${options.join('، ')}.


  const response = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
    {
      contents: [{ parts: [{ text: prompt }] }]
    }
  );

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
