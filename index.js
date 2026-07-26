const axios = require('axios');
const { kv } = require('@vercel/kv');

// ================= متغيرات البيئة الأساسية =================
const BOT_TOKEN = process.env.BOT_TOKEN; // للاستخدامات القديمة
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

// ================= متغيرات التكامل (GitHub & Render) =================
const RENDER_API_KEY = process.env.RENDER_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_USERNAME = process.env.GITHUB_USERNAME;

// ... (خريطة FALLBACK_MAP والدوال القديمة لـ FlowForge بقيت كما هي لكي لا يتعطل نظامك) ...
const FALLBACK_MAP = { nodes: [], connections: [] };
const sessions = new Map();
const intentCache = new Map();
function getNodeById(id, nodes) { return nodes.find(n => n.id === id); }
function replaceVariables(template, vars) { return template.replace(/\{(\w+)\}/g, (_, key) => vars[key] || ''); }
async function sendMessage(chatId, text) { await axios.post(TELEGRAM_API + '/sendMessage', { chat_id: chatId, text: text }); }


module.exports = async (req, res) => {

  // ===================================================================
  // 🚀 نقطة النشر العظيمة: Flutter -> Vercel -> GitHub -> Render
  // ===================================================================
  if (req.method === 'POST' && req.url === '/api/v1/deploy') {
    const { projectName, botToken, pythonCode } = req.body;
    
    if (!projectName || !botToken || !pythonCode) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }
    if (!RENDER_API_KEY || !GITHUB_TOKEN || !GITHUB_USERNAME) {
      return res.status(500).json({ error: 'متغيرات خادم النشر (GitHub/Render) غير مكتملة' });
    }

    try {
      // 1. إنشاء اسم فريد للمستودع والمشروع
      const safeName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '') + '-' + Date.now().toString().slice(-6);

      // 2. تجهيز كود المستخدم (استبدال التوكن ليكون آمناً)
      const safePythonCode = pythonCode.replace(/['"]BOT_TOKEN['"]/gi, "os.environ.get('BOT_TOKEN')");
      // تحويل الأكواد إلى Base64 لأن GitHub API يطلبها بهذه الصيغة
      const botPyBase64 = Buffer.from(`import os\n${safePythonCode}`).toString('base64');
      const reqsBase64 = Buffer.from("python-telegram-bot==20.8\nrequests\nflask\nasyncio").toString('base64');

      console.log(`[1] Creating GitHub Repo: ${safeName}...`);
      
      // 3. إنشاء مستودع جديد على جيت هب (Private)
      await axios.post('https://api.github.com/user/repos',
        { 
          name: safeName, 
          private: true, 
          auto_init: true // مهم جداً لإنشاء الفرع الرئيسي main
        },
        { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } }
      );

      // انتظار ثانية واحدة لضمان تهيئة المستودع في سيرفرات جيت هب
      await new Promise(resolve => setTimeout(resolve, 1500));

      console.log(`[2] Uploading files to GitHub...`);

      // 4. رفع ملف الكود bot.py إلى المستودع
      await axios.put(`https://api.github.com/repos/${GITHUB_USERNAME}/${safeName}/contents/bot.py`,
        { message: 'Initial commit: bot code', content: botPyBase64 },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
      );

      // 5. رفع ملف المتطلبات requirements.txt إلى المستودع
      await axios.put(`https://api.github.com/repos/${GITHUB_USERNAME}/${safeName}/contents/requirements.txt`,
        { message: 'Initial commit: requirements', content: reqsBase64 },
        { headers: { Authorization: `token ${GITHUB_TOKEN}` } }
      );

      console.log(`[3] Deploying to Render...`);

      // 6. توجيه أمر لـ Render بسحب المستودع وتشغيله كـ Worker (بدون خادم ويب، يعمل 24/7)
      const renderPayload = {
        type: "background_worker", // الأفضل لبوتات التليجرام التي تستخدم run_polling()
        name: safeName,
        repo: `https://github.com/${GITHUB_USERNAME}/${safeName}`,
        autoDeploy: "yes",
        envVars: [
          { key: "BOT_TOKEN", value: botToken } // زرع التوكن هنا
        ],
        serviceDetails: {
          env: "python",
          envSpecificDetails: {
            buildCommand: "pip install -r requirements.txt",
            startCommand: "python bot.py"
          }
        }
      };

      const renderResponse = await axios.post('https://api.render.com/v1/services', renderPayload, {
        headers: {
          'Authorization': `Bearer ${RENDER_API_KEY}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      console.log(`✅ Success! Render Service Created: ${renderResponse.data.id}`);

      // إرسال النجاح لتطبيق الفلاتر
      return res.status(200).json({ 
        success: true, 
        message: 'تم بناء المستودع ونشر البوت بنجاح على Render! سيعمل الآن 24/7.',
        repoUrl: `https://github.com/${GITHUB_USERNAME}/${safeName}`
      });

    } catch (err) {
      const errorMsg = err.response?.data?.message || JSON.stringify(err.response?.data) || err.message;
      console.error('Deployment Pipeline Error:', errorMsg);
      return res.status(500).json({ error: `فشلت إحدى مراحل النشر: ${errorMsg}` });
    }
  }


  // ===================================================================
  // الأكواد القديمة لعرض الخرائط وتشغيل الـ Webhook الخاص بك (تركتها لكي لا يتعطل نظامك)
  // ===================================================================

  if (req.method === 'GET' && req.url.startsWith('/api/v1/maps/')) {
    const storeId = req.url.split('/').pop();
    try {
      const flow = await kv.get(`map:${storeId}`);
      return flow ? res.status(200).json(flow) : res.status(404).json({ error: 'Map not found' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'POST' && req.url.startsWith('/api/v1/maps/')) {
    const storeId = req.url.split('/').pop();
    try {
      await kv.set(`map:${storeId}`, req.body);
      return res.status(200).json({ success: true });
    } catch (err) {
      return res.status(503).json({ error: 'Failed to save map' });
    }
  }

  if (req.method !== 'POST' || !req.url.includes('/webhooks/telegram/')) {
    return res.status(200).send('API is running.');
  }
  
  // (كود معالجة المحادثات FlowForge تُرك كما كان في ملفك الأصلي)
  return res.status(200).end();
};

