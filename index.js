const axios = require('axios');
const { kv } = require('@vercel/kv');

const BOT_TOKEN = process.env.BOT_TOKEN;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;

// (أبقيت دوال FlowForge السابقة كما هي لتصنيف النوايا والخرائط)
const FALLBACK_MAP = { /* ... */ };
const sessions = new Map();
const intentCache = new Map();

// =========================================================================
// السحر الحقيقي: دالة الحقن الذكي (Zero Configuration for User)
// =========================================================================
function transformPythonCodeForVercel(userCode) {
  let code = userCode;

  // 1. تحويل جملة تشغيل بايثون التقليدية لتعمل على بيئة Vercel
  code = code.replace(/if\s+__name__\s*==\s*['"]__main__['"]\s*:/g, "if True:");

  // 2. استبدال كلمة BOT_TOKEN بمتغير البيئة
  code = code.replace(/['"]BOT_TOKEN['"]/g, "os.environ.get('BOT_TOKEN')");

  // 3. الجزء العلوي: حقن كود يصطاد البوت ويعطل دوال Polling تلقائياً (Monkey Patching)
  const topInjector = `
# --- FLOWFORGE VERCEL ADAPTER (TOP) ---
import os
import asyncio
import nest_asyncio
nest_asyncio.apply()
import telegram.ext

# اصطياد البوت عند إنشائه من قبل المستخدم
_original_build = telegram.ext.ApplicationBuilder.build
FLOWFORGE_APP_INSTANCE = None

def _flowforge_build(self):
    global FLOWFORGE_APP_INSTANCE
    app = _original_build(self)
    FLOWFORGE_APP_INSTANCE = app
    return app

telegram.ext.ApplicationBuilder.build = _flowforge_build

# إبطال مفعول run_polling لكي لا توقف سيرفر Vercel
def _mock_run_polling(self, *args, **kwargs):
    pass
telegram.ext.Application.run_polling = _mock_run_polling
# ----------------------------------------
`;

  // 4. الجزء السفلي: حقن خادم Flask ليعمل Webhook بناءً على البوت الذي تم اصطياده
  const bottomInjector = `
# --- FLOWFORGE VERCEL ADAPTER (BOTTOM) ---
from flask import Flask, request, jsonify
from telegram import Update

app = Flask(__name__)

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>', methods=['POST', 'GET'])
def webhook_handler(path):
    if request.method == 'POST':
        if not FLOWFORGE_APP_INSTANCE:
            return jsonify({"error": "Bot instance not found"}), 500
            
        try:
            req_data = request.get_json(force=True)
            async def process_update():
                async with FLOWFORGE_APP_INSTANCE:
                    update = Update.de_json(req_data, FLOWFORGE_APP_INSTANCE.bot)
                    await FLOWFORGE_APP_INSTANCE.process_update(update)
            asyncio.run(process_update())
            return jsonify({"status": "success"}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
            
    return "🚀 FlowForge Zero-Config Bot is running on Vercel!"
# -------------------------------------------
`;

  // دمج الكود: العلوي + كود المستخدم + السفلي
  return topInjector + '\n' + code + '\n' + bottomInjector;
}
// =========================================================================

module.exports = async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/deploy') {
    const { projectName, botToken, pythonCode } = req.body;
    
    if (!projectName || !botToken || !pythonCode) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }

    try {
      const safeName = projectName.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/---/g, '-').slice(0, 80) + '-' + Date.now();
      
      // هنا نقوم بحقن الكود السحري
      const safeCode = transformPythonCodeForVercel(pythonCode); 

      // 1. إنشاء المشروع
      const newProject = await axios.post('https://api.vercel.com/v10/projects',
        { name: safeName },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );
      const projectId = newProject.data.id;

      // 2. حقن التوكن كمتغير بيئي
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
        { file: 'requirements.txt', data: 'python-telegram-bot==20.8\nFlask==3.0.0\nnest-asyncio==1.6.0' },
        { file: 'vercel.json', data: JSON.stringify(vercelJsonConfig) }
      ];

      // 3. النشر
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
            // تفعيل Webhook تلقائياً
            await axios.get(`https://api.telegram.org/bot${botToken}/setWebhook?url=https://${domain}/api/bot`);
            break;
          }
        } catch (e) {}
      }

      return res.status(200).json({ success: true, domain: domain });
    } catch (err) {
      console.error('Deploy error:', err.message);
      return res.status(500).json({ error: 'فشل النشر' });
    }
  }

  // --- بقية الأكواد الخاصة بالـ Webhook الأساسي الخاص بك ---
  res.status(200).send('FlowForge Vercel API is running');
};

