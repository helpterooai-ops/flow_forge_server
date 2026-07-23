const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;
const TELEGRAM_API = 'https://api.telegram.org/bot' + BOT_TOKEN;

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

  try {
    await axios.post(TELEGRAM_API + '/sendMessage', {
      chat_id: chatId,
      text: 'استلمت: "' + userText + '"'
    });
    console.log('Replied to', chatId);
  } catch (err) {
    console.error('Send error:', err.message);
  }

  res.status(200).end();
};
