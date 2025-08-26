require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const mongoose = require('mongoose');
const express = require('express');

// ====== ENV ======
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const CHANNEL_ID = Number(process.env.CHANNEL_ID);
const ADMIN_ID = String(process.env.ADMIN_ID);
const PORT = process.env.PORT || 3000;

const app = express();
app.get('/', (req, res) => res.send('🤖 Bot is running!'));
app.listen(PORT, () => console.log(`Express server listening on port ${PORT}`));

// ====== DB ======
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });

const userSchema = new mongoose.Schema({
  userId: { type: Number, index: true },
  username: String,
  code: String,
  joinDate: Date,
  expireDate: Date,
  status: { type: String, enum: ['active', 'expired', 'banned'], default: 'active' },
  inviteLink: String
}, { collection: 'users' });

const codeSchema = new mongoose.Schema({
  code: { type: String, unique: true },
  createdAt: { type: Date, default: Date.now },
  expireDuration: { type: Number, enum: [15, 30, 60], required: true }, // days
  isUsed: { type: Boolean, default: false },
  usedBy: Number
}, { collection: 'codes' });

const logSchema = new mongoose.Schema({
  userId: Number,
  action: String,
  info: Object,
  timestamp: { type: Date, default: Date.now }
}, { collection: 'logs' });

const User = mongoose.model('User', userSchema);
const Code = mongoose.model('Code', codeSchema);
const Log  = mongoose.model('Log',  logSchema);

// ====== BOT ======
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ====== Helpers ======
function generateCode(len = 10) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

async function createInviteLinkForUser(expireDate) {
  const expireUnix = Math.floor(new Date(expireDate).getTime() / 1000);
  const linkObj = await bot.createChatInviteLink(CHANNEL_ID, {
    expire_date: expireUnix,
    creates_join_request: true,
    name: `ArsolX-${expireUnix}`
  });
  return linkObj.invite_link;
}

async function approveIfActive(chatId, userId) {
  const now = new Date();
  const u = await User.findOne({ userId, status: 'active', expireDate: { $gt: now } });
  if (u) {
    await bot.approveChatJoinRequest(chatId, userId);
    await Log.create({ userId, action: 'join_approved', info: { chatId } });
  } else {
    await bot.declineChatJoinRequest(chatId, userId);
    await Log.create({ userId, action: 'join_declined', info: { chatId } });
  }
}

async function kickUserFromChannel(userId) {
  try {
    await bot.banChatMember(CHANNEL_ID, userId);
    await bot.unbanChatMember(CHANNEL_ID, userId, { only_if_banned: true });
    return true;
  } catch (e) {
    await Log.create({ userId, action: 'kick_failed', info: { error: e?.message } });
    return false;
  }
}

// ====== Commands ======
bot.onText(/^\/start$/, (ctx) => {
  bot.sendMessage(ctx.chat.id, 'سلام! کد اشتراک خود را وارد کنید:');
});

bot.onText(/^\/generate$/, async (msg) => {
  if (String(msg.from.id) !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, '⛔ فقط ادمین می‌تواند کد بسازد.');
  }
  await bot.sendMessage(msg.chat.id, 'مدت اشتراک را وارد کنید (15 / 30 / 60):');
  bot.once('message', async (reply) => {
    const days = parseInt((reply.text || '').trim(), 10);
    if (![15, 30, 60].includes(days)) {
      return bot.sendMessage(msg.chat.id, '❌ فقط 15 یا 30 یا 60');
    }
    const code = generateCode(10);
    await Code.create({ code, expireDuration: days, isUsed: false });
    await Log.create({ userId: msg.from.id, action: 'code_generated', info: { code, days } });
    bot.sendMessage(msg.chat.id, `✅ کد ساخته شد:\n🔑 ${code}\n📅 ${days} روز`);
  });
});

// ====== هندل تمام پیام‌های متنی برای کد اشتراک ======
bot.on('message', async (msg) => {
  if (!msg.text) return;
  if (msg.text.startsWith('/')) return; // skip commands

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || '';
  const inputCode = msg.text.trim();

  const codeDoc = await Code.findOne({ code: inputCode });
  if (!codeDoc) {
    await bot.sendMessage(chatId, '❌ کد اشتراک صحیح نیست.');
    return;
  }

  const now = new Date();

  if (codeDoc.isUsed && codeDoc.usedBy !== userId) {
    await bot.sendMessage(chatId, '⚠️ این کد قبلاً توسط کاربر دیگری استفاده شده است.');
    return;
  }

  let userDoc = await User.findOne({ userId, code: inputCode });

  if (!codeDoc.isUsed) {
    const expireDate = new Date(now.getTime() + codeDoc.expireDuration * 24 * 60 * 60 * 1000);
    const inviteLink = await createInviteLinkForUser(expireDate);

    userDoc = await User.create({
      userId,
      username,
      code: inputCode,
      joinDate: now,
      expireDate,
      status: 'active',
      inviteLink
    });

    codeDoc.isUsed = true;
    codeDoc.usedBy = userId;
    await codeDoc.save();

    await Log.create({ userId, action: 'code_redeemed', info: { code: inputCode, days: codeDoc.expireDuration } });
    await Log.create({ userId, action: 'link_generated', info: { link: inviteLink } });

    await bot.sendMessage(chatId,
      `✅ کد تایید شد.\n📅 اعتبار تا: ${expireDate.toLocaleString()}\n\n🔗 لینک درخواست عضویت:\n${inviteLink}\n\nℹ️ اگر از کانال خارج شدی، تا قبل از اتمام اشتراک می‌تونی دوباره با همین لینک درخواست بدی.`
    );
    return;
  }

  if (!userDoc) {
    await bot.sendMessage(chatId, '❌ داده کاربر یافت نشد.');
    return;
  }

  if (userDoc.expireDate <= now) {
    userDoc.status = 'expired';
    await userDoc.save();
    await bot.sendMessage(chatId, '⏳ اشتراک شما منقضی شده است.');
    return;
  }

  const freshLink = await createInviteLinkForUser(userDoc.expireDate);
  userDoc.inviteLink = freshLink;
  await userDoc.save();

  await bot.sendMessage(chatId,
    `✅ اشتراک فعال است.\n📅 اعتبار تا: ${userDoc.expireDate.toLocaleString()}\n\n🔗 لینک درخواست عضویت:\n${freshLink}`
  );
  await Log.create({ userId, action: 'link_regenerated', info: { link: freshLink } });
});

// ====== تایید درخواست عضویت کانال ======
bot.on('chat_join_request', async (update) => {
  try {
    if (!update || !update.chat || !update.from) return;
    if (Number(update.chat.id) !== CHANNEL_ID) return;
    await approveIfActive(update.chat.id, update.from.id);
  } catch (_) {}
});

// ====== چک دوره‌ای انقضا ======
const hourlyCheck = async () => {
  const now = new Date();
  const toExpire = await User.find({ status: 'active', expireDate: { $lte: now } });
  for (const u of toExpire) {
    const kicked = await kickUserFromChannel(u.userId);
    u.status = 'expired';
    await u.save();
    await Log.create({ userId: u.userId, action: kicked ? 'expired_kicked' : 'expired_kick_failed' });
  }
};
setInterval(hourlyCheck, 60 * 60 * 1000);
hourlyCheck();

// ====== هندل خطا ======
bot.on('polling_error', () => { /* silent */ });
