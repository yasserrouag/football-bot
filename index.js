const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');

const app = express();
app.use(express.json());

// ضع توكن البوت الخاص بك هنا مباشرة أو عبر Environment Variables
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN_HERE';
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ملف تخزين البيانات محلياً (قاعدة بيانات JSON بسيطة)
const DB_FILE = 'database.json';

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      console.error("Error reading DB:", e);
    }
  }
  return {
    chatId: null,
    players: [], // قائمة اللاعبين
    votes: {},   // التصويتات { userId: { name, status } }
    messageId: null
  };
}

function saveDb(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

let db = loadDb();

// دوال مساعدة للتواصل مع تليجرام
async function callTelegram(method, body) {
  try {
    const response = await fetch(`${TELEGRAM_API}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return await response.json();
  } catch (error) {
    console.error(`Error in ${method}:`, error);
    return null;
  }
}

async function sendMessage(chatId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    text: text,
    parse_mode: 'Markdown'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const res = await callTelegram('sendMessage', body);
  return res && res.result ? res.result.message_id : null;
}

async function editMessageText(chatId, messageId, text, replyMarkup = null) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text: text,
    parse_mode: 'Markdown'
  };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await callTelegram('editMessageText', body);
}

async function answerCallbackQuery(callbackQueryId, text) {
  await callTelegram('answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text: text,
    show_alert: false
  });
}

// بناء نص رسالة التصويت مع الأسماء
function buildAttendanceText(title) {
  let text = `⚽ *${title}*\n\n`;
  
  let yesList = [];
  let noList = [];
  let maybeList = [];

  for (let userId in db.votes) {
    const v = db.votes[userId];
    if (v.status === 'yes') yesList.push(`• ${v.name}`);
    else if (v.status === 'no') noList.push(`• ${v.name}`);
    else if (v.status === 'maybe') maybeList.push(`• ${v.name}`);
  }

  text += `🟢 *حاضر (${yesList.length}):*\n` + (yesList.length ? yesList.join('\n') : 'لا أحد') + `\n\n`;
  text += `🔴 *غائب (${noList.length}):*\n` + (noList.length ? noList.join('\n') : 'لا أحد') + `\n\n`;
  text += `🟡 *غير متأكد (${maybeList.length}):*\n` + (maybeList.length ? maybeList.join('\n') : 'لا أحد') + `\n\n`;

  text += `👇 اختر حالتك بالأسفل:`;
  return text;
}

const keyboardMarkup = {
  inline_keyboard: [
    [
      { text: '🟢 حاضر', callback_data: 'vote_yes' },
      { text: '🔴 غائب', callback_data: 'vote_no' }
    ],
    [
      { text: '🟡 غير متأكد', callback_data: 'vote_maybe' }
    ]
  ]
};

// استقبال طلبات الـ Webhook من تليجرام
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // الرد السريع الفوري على تليجرام
  const update = req.body;

  try {
    if (update.message) {
      const msg = update.message;
      const chatId = msg.chat.id;
      const text = msg.text || '';
      const user = msg.from;
      const userId = user.id.toString();
      const userName = user.first_name + (user.last_name ? ' ' + user.last_name : '');

      // 1. أمر /setup لربط المجموعة
      if (text === '/setup') {
        db.chatId = chatId;
        saveDb(db);
        await sendMessage(chatId, `✅ تم ربط هذه المجموعة بنجاح لإدارة حضور الفريق!\nرقم المعرف: \`${chatId}\``);
      }
      
      // 2. أمر /addplayer (بالرد على الرسالة)
      else if (text.startsWith('/addplayer')) {
        if (!msg.reply_to_message) {
          await sendMessage(chatId, `⚠️ يجب عمل رد (Reply) على رسالة الشخص المراد إضافته للقائمة.`);
          return;
        }
        const targetUser = msg.reply_to_message.from;
        const targetName = targetUser.first_name + (targetUser.last_name ? ' ' + targetUser.last_name : '');
        const targetId = targetUser.id.toString();

        if (!db.players.some(p => p.id === targetId)) {
          db.players.push({ id: targetId, name: targetName });
          saveDb(db);
          await sendMessage(chatId, `✅ تمت إضافة اللاعب *${targetName}* إلى قائمة الفريق الرسمية.`);
        } else {
          await sendMessage(chatId, `ℹ️ اللاعب *${targetName}* موجود مسبقاً في القائمة.`);
        }
      }

      // 3. أمر /removeplayer (بالرد على الرسالة)
      else if (text.startsWith('/removeplayer')) {
        if (!msg.reply_to_message) {
          await sendMessage(chatId, `⚠️ يجب عمل رد (Reply) على رسالة الشخص المراد حذفه.`);
          return;
        }
        const targetId = msg.reply_to_message.from.id.toString();
        const initialLength = db.players.length;
        db.players = db.players.filter(p => p.id !== targetId);
        
        if (db.players.length < initialLength) {
          saveDb(db);
          await sendMessage(chatId, `🗑️ تم حذف اللاعب من قائمة الفريق.`);
        } else {
          await sendMessage(chatId, `⚠️ هذا اللاعب غير موجود في القائمة الرسمية.`);
        }
      }

      // 4. أمر /players لعرض القائمة
      else if (text === '/players') {
        if (db.players.length === 0) {
          await sendMessage(chatId, `📋 قائمة الفريق فارغة حالياً. استخدم /addplayer لإضافة لاعبين.`);
        } else {
          let list = `📋 *قائمة لاعبي الفريق الرسمية:*\n\n`;
          db.players.forEach((p, index) => {
            list += `${index + 1}. ${p.name}\n`;
          });
          await sendMessage(chatId, list);
        }
      }

      // 5. أمر /status للاستعلام
      else if (text === '/status') {
        await sendMessage(chatId, `📊 البوت يعمل بكفاءة على السيرفر الخارجي وجاهز لاستقبال التصويتات.`);
      }

      // 6. أمر يدوي لفتح التصويت /open
      else if (text === '/open') {
        if (!db.chatId) {
          await sendMessage(chatId, `⚠️ يرجى ربط المجموعة أولاً باستخدام أمر /setup`);
          return;
        }
        db.votes = {}; // تصفير التصويتات السابقة
        saveDb(db);
        
        const titleText = buildAttendanceText('تصويت حضور مباراة هذا الأسبوع');
        const msgId = await sendMessage(db.chatId, titleText, keyboardMarkup);
        db.messageId = msgId;
        saveDb(db);
      }

      // 7. أمر يدوي لإغلاق التصويت /close
      else if (text === '/close') {
        if (!db.chatId || !db.messageId) {
          await sendMessage(chatId, `⚠️ لا يوجد تصويت مفتوح حالياً.`);
          return;
        }
        
        // تحويل من لم يصوت إلى غائب من ضمن القائمة المسجلة
        db.players.forEach(player => {
          if (!db.votes[player.id]) {
            db.votes[player.id] = { name: player.name, status: 'no' };
          }
        });
        saveDb(db);

        const finalText = buildAttendanceText('النتيجة النهائية لحضور مباراة هذا الأسبوع (مغلق)');
        await editMessageText(db.chatId, db.messageId, finalText, null); // إزالة الأزرار
        await sendMessage(db.chatId, `🔒 تم إغلاق التصويت وحفظ النتائج النهائية.`);
      }
    } 
    
    // التعامل مع الأزرار التفاعلية (Callback Query)
    else if (update.callback_query) {
      const query = update.callback_query;
      const chatId = query.message.chat.id;
      const messageId = query.message.message_id;
      const data = query.data;
      const user = query.from;
      const userId = user.id.toString();
      const userName = user.first_name + (user.last_name ? ' ' + user.last_name : '');

      let status = '';
      if (data === 'vote_yes') status = 'yes';
      else if (data === 'vote_no') status = 'no';
      else if (data === 'vote_maybe') status = 'maybe';

      if (status) {
        // تسجيل أو تحديث التصويت
        db.votes[userId] = { name: userName, status: status };
        saveDb(db);

        // تحديث النص في المجموعة فوراً
        const updatedText = buildAttendanceText('تصويت حضور مباراة هذا الأسبوع');
        await editMessageText(chatId, messageId, updatedText, keyboardMarkup);
        await answerCallbackQuery(query.id, `✅ تم تسجيل اختيارك بنجاح!`);
      }
    }
  } catch (error) {
    console.error("Error processing update:", error);
  }
});

// صفحة ترحيبية بسيطة عند فتح رابط السيرفر للتأكد من أنه يعمل
app.get('/', (req, res) => {
  res.send('Football Team Telegram Bot is running successfully! ⚽🚀');
});

// تشغيل السيرفر على المنفذ المطلوب
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bot server is running on port ${PORT}`);
});