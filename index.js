const axios = require('axios');

// تأكد من وضع VERCEL_TOKEN في متغيرات البيئة (Environment Variables) لخادمك
const VERCEL_TOKEN = process.env.VERCEL_TOKEN; 

// =========================================================================
// 🪄 الدالة السحرية: المتربص (النسخة النهائية الآمنة 100%)
// =========================================================================
function transformPythonCodeForVercel(userCode) {
  let code = userCode;

  // 1. إجبار الكود على العمل في Vercel وتخطي شرط التشغيل المحلي
  code = code.replace(/if\s+__name__\s*==\s*['"]__main__['"]\s*:/g, "if True:");
  
  // 2. استبدال التوكن النصي بمتغير البيئة الذي سنحقنه في Vercel
  code = code.replace(/['"]BOT_TOKEN['"]/g, "os.environ.get('BOT_TOKEN')");

  // 3. الجزء العلوي: المتربص الذكي (يسرق البوت كاملاً بدون حلقات مفرغة)
  const topInjector = `
# ==========================================
# FLOWFORGE MAGIC ADAPTER (TOP)
# ==========================================
import os
import asyncio
import nest_asyncio
import telegram.ext

nest_asyncio.apply()

# هنا سنخزن البوت الخاص بالمستخدم بكامل أوامره
FLOWFORGE_APP = None

# سنقوم باعتراض أمر التشغيل، ونسرق البوت وهو جاهز!
def _mock_run_polling(self, *args, **kwargs):
    global FLOWFORGE_APP
    FLOWFORGE_APP = self
    print("[FlowForge] Bot hijacked successfully! Polling disabled.")

# تطبيق الفخ
telegram.ext.Application.run_polling = _mock_run_polling
telegram.ext.Application.run_webhook = _mock_run_polling
# ==========================================
`;

  // 4. الجزء السفلي: تشغيل Webhook وتمرير الرسائل للبوت الذي اصطدناه
  const bottomInjector = `
# ==========================================
# FLOWFORGE MAGIC ADAPTER (BOTTOM)
# ==========================================
from flask import Flask, request, jsonify
from telegram import Update

app = Flask(__name__)

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>', methods=['POST', 'GET'])
def webhook_handler(path):
    if request.method == 'POST':
        if not FLOWFORGE_APP:
            return jsonify({"error": "Bot instance not found"}), 500
            
        try:
            req_data = request.get_json(force=True)
            async def process_update():
                # تشغيل البوت المسروق بأمان تام لكل رسالة
                async with FLOWFORGE_APP:
                    update = Update.de_json(req_data, FLOWFORGE_APP.bot)
                    await FLOWFORGE_APP.process_update(update)
                    
            asyncio.run(process_update())
            return jsonify({"status": "success"}), 200
        except Exception as e:
            return jsonify({"status": "error", "message": str(e)}), 500
            
    return "🚀 FlowForge Zero-Config Engine is ACTIVE and RUNNING!"
# ==========================================
`;

  return topInjector + '\n\n' + code + '\n\n' + bottomInjector;
}
// =========================================================================


// =========================================================================
// 🚀 نظام الرفع (Deployment API) لـ Vercel
// =========================================================================
module.exports = async (req, res) => {
  // السماح بطلبات CORS لتطبيق Flutter
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'POST' && req.url === '/api/v1/deploy') {
    const { projectName, botToken, pythonCode } = req.body;
    
    if (!projectName || !botToken || !pythonCode) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    }

    try {
      const safeName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50) + '-' + Date.now();
      console.log(`[+] بدء معالجة مشروع جديد: ${safeName}`);

      // 🌟 السحر: تحويل كود المستخدم العادي لكود Vercel
      const safeCode = transformPythonCodeForVercel(pythonCode); 

      // 1. إنشاء المشروع
      console.log(`[+] جاري إنشاء المشروع في Vercel...`);
      const newProject = await axios.post('https://api.vercel.com/v10/projects',
        { name: safeName },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );
      const projectId = newProject.data.id;

      // 2. حقن توكن البوت
      console.log(`[+] جاري حقن التوكن البيئي...`);
      await axios.post(`https://api.vercel.com/v10/projects/${projectId}/env`,
        { 
          key: 'BOT_TOKEN', 
          value: botToken, 
          type: 'encrypted', 
          target: ['production', 'preview', 'development'] 
        },
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

      // 3. رفع الملفات
      console.log(`[+] جاري رفع الملفات ونشر التطبيق...`);
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

      // 4. استخراج الرابط وربط Webhook
      console.log(`[+] جاري استخراج النطاق (Domain)...`);
      let domain = null;
      
      // ننتظر قليلاً ونحاول جلب الرابط
      for (let i = 0; i < 8; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        try {
          const projectData = await axios.get(`https://api.vercel.com/v10/projects/${projectId}`,
            { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
          );
          
          if (projectData.data.targets && projectData.data.targets.production) {
             domain = projectData.data.targets.production.url;
          } else {
             domain = projectData.data.alias?.[0]?.domain || `${safeName}.vercel.app`;
          }

          if (domain) {
            const webhookUrl = `https://${domain}`;
            await axios.get(`https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`);
            console.log(`[+] تم ربط Webhook بنجاح: ${webhookUrl}`);
            break;
          }
        } catch (e) {
          console.log(`[-] محاولة العثور على النطاق...`);
        }
      }

      return res.status(200).json({ 
        success: true, 
        message: 'تم نشر البوت بنجاح! 🚀',
        domain: domain 
      });

    } catch (err) {
      console.error('Deploy error:', err.response ? err.response.data : err.message);
      return res.status(500).json({ error: 'فشل النشر', details: err.message });
    }
  }

  // الرد الافتراضي
  res.status(200).send('FlowForge Vercel API is running smoothly! 🟢');
};

