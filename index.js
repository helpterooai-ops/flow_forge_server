const axios = require('axios');
const { kv } = require('@vercel/kv');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

const FALLBACK_MAP = {
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

const sessions = new Map();
const intentCache = new Map();

function getNodeById(id, nodes) { return nodes.find(n => n.id === id); }
function replaceVariables(template, vars) { return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || ''); }
async function sendMessage(chatId, text) { await axios.post(TELEGRAM_API + '/sendMessage', { chat_id: chatId, text: text }); }

function quickKeywordMatch(userText) {
  const t = userText.trim().toLowerCase();
  if (t.includes('مساعدة') || t.includes('دعم') || t.includes('ساعد') || t.includes('الغى') || t.includes('الغي')) return 'طلب مساعدة';
  if (t.includes('حالة') || t.includes('طلبي') || t.includes('تتبع') || t.includes('رقم الطلب')) return 'حالة الطلب';
  return null;
}

async function classifyIntent(userText, options, userId) {
  const cacheKey = `${userId}::${userText}`;
  if (intentCache.has(cacheKey)) return intentCache.get(cacheKey);
  const allOptions = [...options, 'none'];
  const prompt = `صنف النية للرسالة. إذا لم تطابق أي نية، اختر "none". النوايا المتاحة: [${allOptions.join(', ')}]. أعد JSON فقط: {"intent":"...","confidence":0.9}\n\nالرسالة: "${userText}"`;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-lite:generateContent?key=${GEMINI_API_KEY}`;
    const response = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.0 } }, { timeout: 5000 });
    const raw = response.data.candidates[0].content.parts[0].text;
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const result = JSON.parse(cleaned);
    if (result.intent === 'none' || result.confidence < 0.6) {
      const noneResult = { intent: 'none', confidence: 0 };
      if (intentCache.size > 100) intentCache.clear();
      intentCache.set(cacheKey, noneResult);
      return noneResult;
    }
    if (intentCache.size > 100) intentCache.clear();
    intentCache.set(cacheKey, result);
    return result;
  } catch (err) { console.error('Gemini error:', err.message); return null; }
}

function getConnectionTarget(nodeId, connections, nodes) {
  const conn = connections.find(c => c.from === nodeId && !c.condition);
  return conn ? getNodeById(conn.to, nodes) : null;
}

// ✅ المحول الذكي المضمون
function transformPythonCodeForVercel(userCode) {
  let code = userCode;

  // استبدال 'BOT_TOKEN' مرة واحدة فقط (حولها إلى os.environ.get)
  code = code.replace(/['"]BOT_TOKEN['"]/g, "os.environ.get('BOT_TOKEN')");

  // تعطيل run_polling
  code = code.replace(/\.run_polling\(\)/g, 'pass  # disabled by FlowForge');

  // حقن الأعلى (Flask + تطبيق البوت)
  const top = `
import os, asyncio, json
import nest_asyncio
nest_asyncio.apply()
from flask import Flask, request
from telegram import Update
from telegram.ext import Application, ApplicationBuilder   # ✅ تمت الإضافة

# إنشاء تطبيق Flask
app = Flask(__name__)

# المسار الرئيسي
@app.route('/api/bot', methods=['POST'])
def webhook():
    data = request.get_json()
    update = Update.de_json(data, bot_instance.bot)
    asyncio.run(bot_instance.process_update(update))
    return 'OK'

@app.route('/')
def home():
    return 'Bot is running!'

# تحويل كود المستخدم: إيجاد البوت وإنشاء متغير bot_instance
`;

  // استبدال إنشاء التطبيق بالتقاطه
  code = code.replace(
    /(\w+)\s*=\s*ApplicationBuilder\(\)\.token\(.*?\)\.build\(\)/g,
    '$1 = ApplicationBuilder().token(os.environ.get("BOT_TOKEN")).build()\nbot_instance = $1'
  );

  // إذا لم يتم العثور على bot_instance، أضف سطراً افتراضياً
  if (!code.includes('bot_instance')) {
    code += '\nbot_instance = ApplicationBuilder().token(os.environ.get("BOT_TOKEN")).build()\n';
  }

  return top + '\n' + code;
}

module.exports = async (req, res) => {

  // ========== نقطة نشر بوت بايثون ==========
  if (req.method === 'POST' && req.url === '/api/v1/deploy') {
    const { projectName, botToken, pythonCode } = req.body;
    if (!projectName || !botToken || !pythonCode) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    if (!VERCEL_TOKEN) {
      return res.status(500).json({ error: 'VERCEL_TOKEN غير مهيأ على الخادم' });
    }

    try {
      const safeName = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/---/g, '-').slice(0, 80) + '-' + Date.now();
      const safeCode = transformPythonCodeForVercel(pythonCode);

      const newProject = await axios.post('https://api.vercel.com/v10/projects',
        { name: safeName },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );
      const projectId = newProject.data.id;

      await axios.post(`https://api.vercel.com/v10/projects/${projectId}/env`,
        { key: 'BOT_TOKEN', value: botToken, type: 'encrypted', target: ['production', 'preview', 'development'] },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );

      const vercelJsonConfig = {
        builds: [{ src: "bot.py", use: "@vercel/python" }],
        routes: [{ src: "/(.*)", dest: "bot.py" }]
      };

      const files = [
        { file: 'bot.py', data: safeCode },
        { file: 'requirements.txt', data: 'python-telegram-bot==20.8\nflask\nnest-asyncio==1.6.0' },
        { file: 'vercel.json', data: JSON.stringify(vercelJsonConfig) }
      ];

      await axios.post('https://api.vercel.com/v13/deployments',
        {
          name: safeName,
          project: projectId,
          target: 'production',
          files: files,
          env: { BOT_TOKEN: botToken },
          projectSettings: { framework: null }
        },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );

      let domain = null;
      for (let i = 0; i < 6; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
          const projectData = await axios.get(`https://api.vercel.com/v10/projects/${projectId}`,
            { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
          );
          domain = projectData.data.alias?.[0]?.domain || `${safeName}.vercel.app`;
          if (domain) {
            await axios.get(`https://api.telegram.org/bot${botToken}/setWebhook?url=https://${domain}/api/bot`);
            break;
          }
        } catch (e) {}
      }

      if (!domain) {
        return res.status(500).json({ error: 'لم يتم الحصول على نطاق المشروع' });
      }

      return res.status(200).json({ success: true, domain: domain });
    } catch (err) {
      const detail = JSON.stringify(err.response?.data || err.message);
      console.error('Deploy error:', detail);
      return res.status(500).json({ error: `فشل النشر: ${detail}` });
    }
  }

  // ========== عرض الخريطة (GET) ==========
  if (req.method === 'GET' && req.url.startsWith('/api/v1/maps/')) {
    const storeId = req.url.split('/').pop();
    try {
      const flow = await kv.get(`map:${storeId}`);
      if (flow) {
        return res.status(200).json(flow);
      } else {
        return res.status(404).json({ error: 'Map not found' });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ========== نشر خريطة جديدة (POST) ==========
  if (req.method === 'POST' && req.url.startsWith('/api/v1/maps/')) {
    const storeId = req.url.split('/').pop();
    const flowData = req.body;
    if (!flowData || !flowData.nodes || !flowData.connections) {
      return res.status(400).json({ error: 'Invalid map data' });
    }
    try {
      await kv.set(`map:${storeId}`, flowData);
      console.log(`✅ Map stored in Upstash KV for store ${storeId}`);
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('KV save error:', err.message);
      return res.status(503).json({ error: 'Failed to save map' });
    }
  }

  // ========== Webhook تيليجرام ==========
  if (req.method !== 'POST' || !req.url.includes('/webhooks/telegram/')) {
    return res.status(200).send('Webhook ready');
  }

  const { message } = req.body;
  if (!message || !message.text) return res.status(200).end();

  const chatId = message.chat.id;
  const userText = message.text;
  const storeId = req.url.split('/').pop();

  if (userText.trim().toLowerCase() === '/start') {
    sessions.delete(chatId);
    await sendMessage(chatId, 'أهلاً بك! تم إعادة تشغيل المحادثة.');
  }

  let flow = null;
  try {
    flow = await kv.get(`map:${storeId}`);
  } catch (err) {
    console.error('KV read error:', err.message);
  }

  if (!flow) {
    if (storeId === 'test') flow = FALLBACK_MAP;
    else {
      await sendMessage(chatId, 'المتجر غير جاهز بعد.');
      return res.status(200).end();
    }
  }

  const { nodes, connections } = flow;

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
          if (nextInp.type === 'message') await sendMessage(chatId, replaceVariables(nextInp.title, session.variables));
          else if (nextInp.prompt) await sendMessage(chatId, replaceVariables(nextInp.prompt, session.variables));
        }
        break;
      case 'intent': {
        const options = connections.filter(c => c.from === currentNode.id && c.condition && c.condition !== 'fallback').map(c => c.condition);
        const fallbackConn = connections.find(c => c.from === currentNode.id && c.condition === 'fallback');
        let intent = quickKeywordMatch(userText);
        if (!intent) {
          const geminiResult = await classifyIntent(userText, options, chatId);
          if (geminiResult && geminiResult.intent !== 'none' && geminiResult.confidence >= 0.6 && options.includes(geminiResult.intent))
            intent = geminiResult.intent;
          else intent = null;
        }
        if (intent && options.includes(intent)) {
          const matched = connections.find(c => c.from === currentNode.id && c.condition === intent);
          if (matched) {
            const nextNode = getNodeById(matched.to, nodes);
            if (nextNode) {
              session.currentNodeId = nextNode.id;
              await sendMessage(chatId, replaceVariables(nextNode.title, session.variables));
            }
          }
        } else {
          if (fallbackConn) {
            const fallbackNode = getNodeById(fallbackConn.to, nodes);
            if (fallbackNode) {
              session.currentNodeId = fallbackNode.id;
              await sendMessage(chatId, replaceVariables(fallbackNode.title, session.variables));
            }
          } else await sendMessage(chatId, 'لم أفهم قصدك، حاول مجدداً.');
        }
        break;
      }
      default: await sendMessage(chatId, 'نوع عقدة غير معروف.');
    }
  } catch (err) {
    console.error('Error:', err.message);
    await sendMessage(chatId, 'حدث خطأ غير متوقع.');
  }
  res.status(200).end();
};
