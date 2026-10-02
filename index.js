const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
app.use(express.json());

const TOKEN = process.env.BOT_TOKEN;
const PORT = process.env.PORT || 3000;
const DB_FILE = './database.json';

// تحميل القاعدة أو إنشاؤها
function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error('Error reading DB:', e);
    }
  }
  return { chatId: null, messageId: null, players: [], votes: {} };
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDb();

// أزرار التصويت التفاعلية
const keyboardMarkup = {
  inline_keyboard: [
    [
      { text: '🟢 حاضر', callback_data: 'vote_yes' },
      { text: '🔴 غائب', callback_data: 'vote_no' },
      { text: '🟡 غير متأكد', callback_data: 'vote_maybe' }
    ]
  ]
};

// دالة إرسال الرسائل لتليجرام
async function callTelegram(method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error(`Telegram API Error (${method}):`, err);
    return null;
  }
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text: text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await callTelegram('sendMessage', body);
  return res ? res.message_id : null;
}

async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const body = { chat_id: chatId, message_id: messageId, text: text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await callTelegram('editMessageText', body);
}

// بناء نص الحضور والإحصائيات
function buildAttendanceText(title) {
  let yesList = [];
  let noList = [];
  let maybeList = [];

  for (const [id, v] of Object.entries(db.votes)) {
    if (v.status === 'yes') yesList.push(`- ${v.name}`);
    else if (v.status === 'no') noList.push(`- ${v.name}`);
    else if (v.status === 'maybe') maybeList.push(`- ${v.name}`);
  }

  return `📋 *${title}*

🟢 *الحاضرون (${yesList.length}):*${yesList.length > 0 ? yesList.join('\n') : '_لا يوجد حتى الآن_'}

🔴 *الغائبون (${noList.length}):*${noList.length > 0 ? noList.join('\n') : '_لا يوجد حتى الآن_'}

🟡 *غير متأكد (${maybeList.length}):*${maybeList.length > 0 ? maybeList.join('\n') : '_لا يوجد حتى الآن_'}`;
}

// نقطة استقبال رسائل تليجرام (Webhook)
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;

  try {
    // 1. التعامل مع الضغط على أزرار التصويت
    if (update.callback_query) {
      const q = update.callback_query;
      const chatId = q.message.chat.id;
      const userId = q.from.id;
      const userName = q.from.first_name || 'لاعب';
      const data = q.data;

      // التأكد أن اللاعب مسجل في القائمة الرسمية للفريق
      const isRegistered = db.players.some(p => p.id === userId);
      if (!isRegistered) {
        await callTelegram('answerCallbackQuery', {
          callback_query_id: q.id,
          text: '⚠️ لست مسجلاً في قائمة الفريق الرسمية. اطلب من المشرف إضافتك.',
          show_alert: true
        });
        return;
      }

      let status = '';
      if (data === 'vote_yes') status = 'yes';
      if (data === 'vote_no') status = 'no';
      if (data === 'vote_maybe') status = 'maybe';

      db.votes[userId] = { name: userName, status: status };
      saveDb(db);

      const updatedText = buildAttendanceText('تصويت حضور مباراة هذا الأسبوع');
      await editMessageText(chatId, q.message.message_id, updatedText, keyboardMarkup);

      await callTelegram('answerCallbackQuery', {
        callback_query_id: q.id,
        text: '✅ تم تسجيل صوتك بنجاح!'
      });
      return;
    }

    // 2. التعامل مع الرسائل النصية والأوامر
    if (update.message && update.message.text) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text.trim();

      // أ) أمر الربط /setup
      if (text === '/setup') {
        db.chatId = chatId;
        saveDb(db);
        await sendMessage(chatId, `✅ *تم ربط المجموعة بنجاح!*\nمعرف الدردشة: \`${chatId}\``);
      }
      
      // ب) أمر إضافة لاعب /addplayer (بالرد على رسالته)
      else if (text === '/addplayer') {
        if (!msg.reply_to_message) {
          await sendMessage(chatId, `⚠️ يرجى الرد (Reply) على رسالة الشخص المراد إضافته واكتب /addplayer`);
          return;
        }
        const targetUser = msg.reply_to_message.from;
        const exists = db.players.some(p => p.id === targetUser.id);
        
        if (!exists) {
          db.players.push({ id: targetUser.id, name: targetUser.first_name });
          saveDb(db);
          await sendMessage(chatId, `👤 تم إضافة اللاعب *${targetUser.first_name}* إلى القائمة الرسمية بنجاح.`);
        } else {
          await sendMessage(chatId, `ℹ️ اللاعب *${targetUser.first_name}* مسجل مسبقاً.`);
        }
      }

      // ج) أمر عرض قائمة اللاعبين /players
      else if (text === '/players') {
        if (db.players.length === 0) {
          await sendMessage(chatId, `📋 قائمة اللاعبين الرسمية فارغة حالياً.`);
          return;
        }
        let listStr = db.players.map((p, idx) => `${idx + 1}. ${p.name}`).join('\n');
        await sendMessage(chatId, `📋 *قائمة اللاعبين الرسمية المعتمدة:*\n\n${listStr}`);
      }

      // د) أمر فتح التصويت يدويًا /open مع التثبيت التلقائي
      else if (text === '/open') {
        if (!db.chatId) {
          await sendMessage(chatId, `⚠️ يرجى ربط المجموعة أولاً باستخدام أمر /setup`);
          return;
        }
        db.votes = {}; 
        saveDb(db);
        
        const titleText = buildAttendanceText('تصويت حضور مباراة هذا الأسبوع');
        const msgId = await sendMessage(db.chatId, titleText, keyboardMarkup);
        db.messageId = msgId;
        saveDb(db);

        // تثبيت الرسالة تلقائياً في الأعلى
        if (msgId) {
          await callTelegram('pinChatMessage', {
            chat_id: db.chatId,
            message_id: msgId
          });
        }
      }

      // هـ) أمر إغلاق التصويت يدويًا /close
      else if (text === '/close') {
        if (!db.chatId || !db.messageId) {
          await sendMessage(chatId, `⚠️ لا يوجد تصويت مفتوح حالياً لإغلاقه.`);
          return;
        }

        // تحويل من لم يصوت إلى غائب تلقائياً
        db.players.forEach(player => {
          if (!db.votes[player.id]) {
            db.votes[player.id] = { name: player.name, status: 'no' };
          }
        });
        saveDb(db);

        const finalText = buildAttendanceText('النتيجة النهائية لحضور مباراة هذا الأسبوع (مغلق)');
        await editMessageText(db.chatId, db.messageId, finalText, null);
        await sendMessage(db.chatId, `📊 *تم إغلاق التصويت واعتماد الحصيلة النهائية.*`);
      }
    }
  } catch (err) {
    console.error('Error processing update:', err);
  }
});

// ==========================================
// الجدولة التلقائية أسبوعياً (يوم الخميس)
// ==========================================

// 1. فتح التصويت وتثبيته تلقائياً كل خميس الساعة 10:00 صباحاً
cron.schedule('0 10 * * 4', async () => {
  if (!db.chatId) return;
  db.votes = {};
  saveDb(db);
  
  const titleText = buildAttendanceText('تصويت حضور مباراة اليوم (فتح تلقائي)');
  const msgId = await sendMessage(db.chatId, titleText, keyboardMarkup);
  db.messageId = msgId;
  saveDb(db);

  if (msgId) {
    await callTelegram('pinChatMessage', {
      chat_id: db.chatId,
      message_id: msgId
    });
  }
  console.log('Automated Thursday Vote Opened & Pinned.');
}, {
  timezone: "Africa/Algiers"
});

// 2. إغلاق التصويت وعرض الإحصائيات كل خميس الساعة 8:00 مساءً (20:00)
cron.schedule('0 20 * * 4', async () => {
  if (!db.chatId || !db.messageId) return;
  
  db.players.forEach(player => {
    if (!db.votes[player.id]) {
      db.votes[player.id] = { name: player.name, status: 'no' };
    }
  });
  saveDb(db);

  const finalText = buildAttendanceText('النتيجة النهائية لحضور مباراة اليوم (مغلق تلقائياً)');
  await editMessageText(db.chatId, db.messageId, finalText, null);
  await sendMessage(db.chatId, `📊 *إحصائيات وحصيلة المباراة النهائية:*\nتم إغلاق التصويت واعتماد القائمة.`);
  console.log('Automated Thursday Vote Closed.');
}, {
  timezone: "Africa/Algiers"
});

// تشغيل الخادم
app.listen(PORT, () => {
  console.log(`Bot server is running on port ${PORT}`);
});
