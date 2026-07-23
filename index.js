require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

const TELEGRAM_API = `https://api.telegram.org/bot${process.env.BOT_TOKEN}`;

// Webhook نقطة استقبال الرسائل
app.post('/api/v1/webhooks/telegram/:storeId', async (req, res) => {
  // ✅ الرد فوراً بـ 200 OK لتجنب إعادة الإرسال من تيليجرام
  res.sendStatus(200);

  try {
    const { message } = req.body;
    if (!message || !message.text) return;

    const chatId = message.chat.id;
    const userText = message.text;

    console.log(`[${req.params.storeId}] رسالة من ${chatId}: ${userText}`);

    // رد بسيط مؤقت (سنستبدله لاحقاً بالخريطة و Gemini)
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: `استلمت: "${userText}"`,
    });
  } catch (err) {
    console.error('خطأ:', err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ FlowForge server running on port ${PORT}`);
});
