const axios = require('axios');

// متغيرات البيئة الأساسية لخادمك
const VERCEL_TOKEN = process.env.VERCEL_TOKEN; 

// =========================================================================
// 🪄 الدالة السحرية: المتربص (Monkey Patching & Zero-Config Adapter)
// =========================================================================
function transformPythonCodeForVercel(userCode) {
  let code = userCode;

  // 1. كسر حماية التشغيل المحلي ليعمل على خوادم Vercel
  // نبحث عن if __name__ == '__main__': ونحولها إلى if True: لكي يتم تنفيذ الدوال
  code = code.replace(/if\s+__name__\s*==\s*['"]__main__['"]\s*:/g, "if True:");

  // 2. استبدال كلمة "BOT_TOKEN" التي يكتبها المستخدم بمتغير البيئة الحقيقي
  code = code.replace(/['"]BOT_TOKEN['"]/g, "os.environ.get('BOT_TOKEN')");

  // 3. الجزء العلوي (Top Injector): التربص واصطياد المعالجات
  const topInjector = `
# ==========================================
# FLOWFORGE VERCEL ADAPTER (TOP INJECTOR)
# ==========================================
import os
import asyncio
import nest_asyncio
import telegram.ext

# السماح بتشغيل asyncio متداخل في بيئة Vercel
nest_asyncio.apply()

# مصفوفة سرية لتخزين جميع المعالجات (Handlers) التي سيكتبها المستخدم
_FLOWFORGE_HANDLERS = []
_FLOWFORGE_TOKEN = os.environ.get('BOT_TOKEN')

# التربص بدالة add_handler واصطياد الأوامر
_original_add_handler = telegram.ext.Application.add_handler

def _mock_add_handler(self, handler, group=0):
    # نسخ المعالج إلى مصفوفتنا السرية
    _FLOWFORGE_HANDLERS.append((handler, group))
    # تشغيل الدالة الأصلية حتى لا يشك الكود بشيء
    _original_add_handler(self, handler, group)

# حقن دالتنا الملغمة في قلب مكتبة تليجرام
telegram.ext.Application.add_handler = _mock_add_handler

# إبطال مفعول run_polling تماماً لكي لا يُدخل Vercel في غيبوبة (Timeout)
def _mock_run_polling(self, *args, **kwargs):
    print("FlowForge: run_polling disabled. Webhook activated.")
    pass

telegram.ext.Application.run_polling = _mock_run_polling
# ==========================================
`;

  // 4. الجزء السفلي (Bottom Injector): التغليف بـ Flask وتأسيس Webhook قوي
  const bottomInjector = `
# ==========================================
# FLOWFORGE VERCEL ADAPTER (BOTTOM INJECTOR)
# ==========================================
from flask import Flask, request, jsonify
from telegram import Update

# إنشاء خادم Flask في الخلفية
app = Flask(__name__)

@app.route('/', defaults={'path': ''})
@app.route('/<path:path>', methods=['POST', 'GET'])
def webhook_handler(path):
    if request.method == 'POST':
        try:
            req_data = request.get_json(force=True)
            
            async def process_update():
                # بناء بوت جديد "نظيف" لكل رسالة لتجنب أخطاء الذاكرة (500 Error)
                temp_app = telegram.ext.ApplicationBuilder().token(_FLOWFORGE_TOKEN).build()
                
                # حقن المعالجات التي اصطدناها من كود المستخدم في البوت الجديد
                for handler, group in _FLOWFORGE_HANDLERS:
                    temp_app.add_handler(handler, group)
                
                # معالجة الرسالة بأمان ثم إغلاق الاتصال
                async with temp_app:
                    update = Update.de_json(req_data, temp_app.bot)
                    await temp_app.process_update(update)
                    
            # تشغيل العملية في بيئة Vercel
            asyncio.run(process_update())
            return jsonify({"status": "success"}), 200
            
        except Exception as e:
            print(f"FlowForge Error: {str(e)}")
            return jsonify({"status": "error", "message": str(e)}), 500
            
    # واجهة المتصفح للتأكد من عمل السيرفر
    return "🚀 FlowForge Zero-Config Bot Engine is Running on Vercel!"
# ==========================================
`;

  // دمج الكود النهائي: المحول العلوي + كود المستخدم + المحول السفلي
  return topInjector + '\n\n' + code + '\n\n' + bottomInjector;
}
// =========================================================================


// =========================================================================
// 🚀 نظام الرفع (Deployment API) للتعامل مع Vercel
// =========================================================================
module.exports = async (req, res) => {
  // نقطة النهاية (Endpoint) التي سيضربها تطبيق Flutter الخاص بك
  if (req.method === 'POST' && req.url === '/api/v1/deploy') {
    const { projectName, botToken, pythonCode } = req.body;
    
    if (!projectName || !botToken || !pythonCode) {
      return res.status(400).json({ error: 'جميع الحقول (projectName, botToken, pythonCode) مطلوبة' });
    }

    try {
      // تنظيف اسم المشروع ليتوافق مع شروط Vercel
      const safeName = projectName.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 50) + '-' + Date.now();
      
      console.log(`[+] بدء معالجة مشروع جديد: ${safeName}`);

      // 🌟 تفعيل السحر: تحويل كود المستخدم العادي إلى كود متوافق مع Vercel
      const safeCode = transformPythonCodeForVercel(pythonCode); 

      // 1. إنشاء المشروع في Vercel
      console.log(`[+] جاري إنشاء المشروع في Vercel...`);
      const newProject = await axios.post('https://api.vercel.com/v10/projects',
        { name: safeName },
        { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } }
      );
      const projectId = newProject.data.id;

      // 2. حقن توكن البوت كمتغير بيئي (Environment Variable) آمن
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

      // إعدادات Vercel لتشغيل بايثون
      const vercelJsonConfig = {
        builds: [{ src: "bot.py", use: "@vercel/python" }],
        routes: [{ src: "/(.*)", dest: "bot.py" }]
      };

      // الملفات التي سيتم رفعها
      const files = [
        { file: 'bot.py', data: safeCode },
        // تم إضافة nest-asyncio و Flask لتعمل حقن الـ Webhook بدون تدخل المستخدم
        { file: 'requirements.txt', data: 'python-telegram-bot==20.8\nFlask==3.0.0\nnest-asyncio==1.6.0' },
        { file: 'vercel.json', data: JSON.stringify(vercelJsonConfig) }
      ];

      // 3. رفع الملفات (Deployment)
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

      // 4. استخراج الرابط (Domain) وربط Webhook
      console.log(`[+] جاري استخراج النطاق (Domain) وربط تليجرام...`);
      let domain = null;
      
      // عمل Polling خفيف للبحث عن النطاق بعد النشر (يحاول 6 مرات)
      for (let i = 0; i < 6; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000)); // انتظار 5 ثواني
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
            // تفعيل Webhook تلقائياً مع تليجرام
            const webhookUrl = `https://${domain}`;
            const telegramResponse = await axios.get(`https://api.telegram.org/bot${botToken}/setWebhook?url=${webhookUrl}`);
            
            console.log(`[+] تم ربط Webhook بنجاح:`, telegramResponse.data);
            break; // الخروج من الحلقة بعد النجاح
          }
        } catch (e) {
          console.log(`[-] محاولة العثور على النطاق...`);
        }
      }

      // إرسال الرد النهائي لتطبيق Flutter
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

  // في حال تم طلب مسار غير معروف
  res.status(200).send('FlowForge Vercel API is running smoothly! 🟢');
};

