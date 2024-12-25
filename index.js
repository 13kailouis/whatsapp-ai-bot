/*******************************************************
 *  GROQ x WhatsApp AI BOT 
 *  Fixing "jadwalkan chat ke grup Grafisier jam 11.23 sekarang"
 *  agar tidak dianggap invalid.
 *******************************************************/

require('dotenv').config();

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const { AssemblyAI } = require('assemblyai');
const { createWorker } = require('tesseract.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const schedule = require('node-schedule');
const moment = require('moment');

moment.locale('id');

/*******************************************************
 *               KONFIGURASI DASAR
 *******************************************************/
const groqApiKey = process.env.GROQ_API_KEY || 'ISI_GROQ_API_KEY_ANDA';
const assemblyAiKey = process.env.ASSEMBLYAI_API_KEY || 'ISI_ASSEMBLYAI_API_KEY_ANDA';
const voiceRSSApiKey = process.env.VOICERSS_API_KEY || 'ISI_VOICERSS_API_KEY_ANDA';

const ADMIN_NUMBER = '6285659822081';  // Premium user contoh

// Inisialisasi
const groq = new Groq({ apiKey: groqApiKey });
const assemblyAI = new AssemblyAI({ apiKey: assemblyAiKey });
const worker = createWorker();

// Folder audio
const responsesFolder = path.join(__dirname, 'responses');
if (!fs.existsSync(responsesFolder)) fs.mkdirSync(responsesFolder);

const audioCache = new Map();

/*******************************************************
 *   INISIALISASI CLIENT WA
 *******************************************************/
const client = new Client({
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  },
  authStrategy: new LocalAuth({ clientId: 'groq-whatsapp-ai' })
});

const sessions = new Map();        // Multi-step chat
const userPreferences = new Map(); // text / wkw ?

// Premium users (tanpa @c.us)
const premiumNumbers = new Set([
  '6285659822081',  // Contoh Premium
]);

// Batas free user
const FREE_USER_DAILY_LIMIT = 5;
const userUsage = new Map();

// Multi-step chat limit
const CONTEXT_LIMIT_FREE = 5;
const CONTEXT_LIMIT_PREMIUM = 20;

/*******************************************************
 *   HELPER UNTUK CEK PENGGUNA & BATAS
 *******************************************************/
function getSenderNumber(message) {
  if (message.from.endsWith('@g.us')) {
    if (!message.author) return null;
    return message.author.split('@')[0];
  }
  return message.from.split('@')[0];
}

function isPremiumUser(message) {
  const sender = getSenderNumber(message);
  if (!sender) return false;
  return premiumNumbers.has(sender);
}

function canUseService(message) {
  if (isPremiumUser(message)) return true;
  const sender = getSenderNumber(message);
  if (!sender) return false;

  const todayStr = new Date().toISOString().split('T')[0];
  if (!userUsage.has(sender)) {
    userUsage.set(sender, { count: 0, date: todayStr });
  }
  const usageData = userUsage.get(sender);
  if (usageData.date !== todayStr) {
    usageData.count = 0;
    usageData.date = todayStr;
  }
  return usageData.count < FREE_USER_DAILY_LIMIT;
}

function incrementUsage(message) {
  if (isPremiumUser(message)) return;
  const sender = getSenderNumber(message);
  if (!sender) return;

  const todayStr = new Date().toISOString().split('T')[0];
  if (!userUsage.has(sender)) {
    userUsage.set(sender, { count: 0, date: todayStr });
  }
  const usageData = userUsage.get(sender);
  if (usageData.date !== todayStr) {
    usageData.count = 0;
    usageData.date = todayStr;
  }
  usageData.count++;
  userUsage.set(sender, usageData);
}

function getRemainingUsage(message) {
  if (isPremiumUser(message)) return Infinity;
  const sender = getSenderNumber(message);
  if (!sender) return 0;

  const todayStr = new Date().toISOString().split('T')[0];
  let usageData = userUsage.get(sender);
  if (!usageData) {
    usageData = { count: 0, date: todayStr };
    userUsage.set(sender, usageData);
  }
  if (usageData.date !== todayStr) {
    usageData.count = 0;
    usageData.date = todayStr;
  }
  return FREE_USER_DAILY_LIMIT - usageData.count;
}

function getContextLimit(message) {
  return isPremiumUser(message) ? CONTEXT_LIMIT_PREMIUM : CONTEXT_LIMIT_FREE;
}

/*******************************************************
 *   FUNGSI TTS
 *******************************************************/
async function generateAudio(text) {
  if (audioCache.has(text)) return audioCache.get(text);
  const url = `https://api.voicerss.org/?key=${voiceRSSApiKey}&hl=id-id&c=MP3&f=22khz_8bit_stereo&speed=3&src=${encodeURIComponent(text)}`;
  try {
    const response = await axios({ url, method: 'GET', responseType: 'arraybuffer' });
    const filePath = path.join(responsesFolder, `audio-${Date.now()}.mp3`);
    fs.writeFileSync(filePath, response.data);
    audioCache.set(text, filePath);
    return filePath;
  } catch (error) {
    console.error('Gagal buat TTS:', error);
    return null;
  }
}

/*******************************************************
 *   FUNGSI TRANSLATE
 *******************************************************/
async function translateToIndonesian(text) {
  try {
    const response = await axios.post('https://translate.argosopentech.com/translate', {
      q: text,
      source: 'auto',
      target: 'id',
      format: 'text'
    });
    return response.data.translatedText || text;
  } catch (err) {
    console.error('Gagal translate:', err?.response?.data || err.message);
    return text;
  }
}

/*******************************************************
 *   FUNGSI PECAH PESAN
 *******************************************************/
function splitMessage(text, maxLength = 4096) {
  const words = text.split(' ');
  const parts = [];
  let currentPart = '';

  for (const word of words) {
    if ((currentPart + word).length <= maxLength) {
      currentPart += `${word} `;
    } else {
      parts.push(currentPart.trim());
      currentPart = `${word} `;
    }
  }
  if (currentPart.trim().length > 0) {
    parts.push(currentPart.trim());
  }
  return parts;
}

/*******************************************************
 *   PROMO & PREMIUM INFO (AI)
 *******************************************************/
async function generateAiPromoMessage() {
  try {
    const result = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 128,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `
Kamu asisten AI, gaya tongkrongan tapi kadang profesional.
        `
        }
      ]
    });
    const content = result.choices[0]?.message?.content?.trim() || '';
    return await translateToIndonesian(content);
  } catch {
    return `.`;
  }
}

async function generateAiPremiumInfo() {
  try {
    const result = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 200,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `
Kamu asisten AI bergaya tongkrongan tapi profesional kala perlu.
Jelaskan Premium (3-5 baris), 
1) Gak ada limit
2) Respon ngebut
3) Dukungan prioritas
Kontak: wa.me/${ADMIN_NUMBER}
        `
        }
      ]
    });
    const content = result.choices[0]?.message?.content?.trim() || '';
    return await translateToIndonesian(content);
  } catch {
    return `Premium: Bebas limit, respon cepat, dukungan prioritas. Hubungi admin: wa.me/${ADMIN_NUMBER}.`;
  }
}

/*******************************************************
 *   REPHRASE (AI)
 *******************************************************/
async function rephraseMessageAI(originalText) {
  try {
    const prompt = `
Kamu asisten AI, gaya tongkrongan tapi bisa formal dikit.
Permak kalimat ini biar lebih enak: "${originalText}"
    `;
    const result = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 100,
      temperature: 0.7,
      messages: [
        { role: 'system', content: prompt }
      ]
    });
    return (result.choices[0]?.message?.content || originalText).trim();
  } catch {
    return originalText;
  }
}

/*******************************************************
 *   KIRIM PESAN => NOMOR
 *******************************************************/
async function sendCustomMessage(targetNumber, textMessage) {
  // normalisasi => @c.us
  const normalized = targetNumber.replace(/\D/g, '') + '@c.us';
  await client.sendMessage(normalized, textMessage);
}

/*******************************************************
 *   JOIN GRUP
 *******************************************************/
async function joinGroupByLink(inviteLink) {
  const code = inviteLink.split('https://chat.whatsapp.com/')[1];
  if (!code) throw new Error('Link grup gak valid bos.');
  await client.acceptInvite(code);
}

/*******************************************************
 *   SCHEDULE MESSAGE
 *******************************************************/
async function scheduleMessage(sendTo, dateTime, textMessage) {
  schedule.scheduleJob(dateTime, async () => {
    try {
      await client.sendMessage(sendTo.id, textMessage);
      console.log('[SCHEDULED] Terkirim =>', sendTo, textMessage);
    } catch (err) {
      console.error('[SCHEDULED ERR]', err);
    }
  });
}

/**
 *  Cari grup (partial name)
 */
async function findGroupByName(partialName) {
  const chats = await client.getChats();
  const groups = chats.filter(c => c.isGroup);
  const found = groups.find(g => g.name.toLowerCase().includes(partialName.toLowerCase()));
  return found || null;
}

/**
 * parseEasyScheduleInput
 * Perbaikan:
 * 1) Hilangkan kata "chat" kalau ada => agar "jadwalkan chat ke grup X" tetap jalan
 * 2) Ganti titik jadi titik dua => "11.23" => "11:23"
 */
function parseEasyScheduleInput(text) {
  // Hilangkan kata " chat " jika ada
  text = text.replace(/\bchat\b\s*/gi, '');
  // Ganti jam "11.23" jadi "11:23"
  text = text.replace(/(\d{1,2})\.(\d{1,2})/g, '$1:$2');

  // mis: "jadwalkan ke grup grafisier jam 11:23 sekarang: Halo guys!"
  const jamRegex = /jam\s+(\d{1,2}:\d{1,2})/i;
  const jamMatch = text.match(jamRegex);
  if (!jamMatch) return null;
  const timeStr = jamMatch[1]; // ex "11:23"

  let targetDate = moment();
  const [hh, mm] = timeStr.split(':');
  targetDate.set({ hour: +hh, minute: +mm, second: 0 });
  
  const now = moment();

  if (text.includes('besok')) {
    targetDate.add(1, 'day');
  } else if (text.includes('sekarang')) {
    // "sekarang" => pakai jam ini, tapi kalau sudah lewat => +1 day
    if (targetDate.isBefore(now)) {
      targetDate.add(1, 'day');
    }
  } else {
    // kalau jam sudah lewat => +1 day
    if (targetDate.isBefore(now)) {
      targetDate.add(1, 'day');
    }
  }

  // cek "ke grup X" vs "ke 628"
  let isGroup = false;
  let groupNameOrNumber = null;

  const grpRegex = /ke\s+grup\s+([\w\s\d]+)/i; 
  const grpMatch = text.match(grpRegex);
  if (grpMatch) {
    isGroup = true;
    groupNameOrNumber = grpMatch[1].trim();
  } else {
    // nomor
    const numRegex = /ke\s+(\d[\d\s]+)/i;
    const numMatch = text.match(numRegex);
    if (numMatch) {
      isGroup = false;
      groupNameOrNumber = numMatch[1].replace(/\s+/g, '');
    }
  }
  if (!groupNameOrNumber) return null;

  // text => setelah ':'
  const splitted = text.split(':');
  if (splitted.length < 2) return null;
  const textMessage = splitted[splitted.length - 1].trim();

  return {
    isGroup,
    target: groupNameOrNumber,
    date: targetDate.toDate(),
    text: textMessage
  };
}

/*******************************************************
 *   EVENT HANDLER
 *******************************************************/
client.on('qr', (qr) => {
    const qrCode = require('qrcode');
    qrCode.toFile('qr.png', qr, (err) => {
        if (err) console.error(err);
        else console.log('QR code disimpan sebagai qr.png');
    });

client.on('ready', () => {
  console.log('[INFO] Bot WA siap digunakan!');
});

client.on('authenticated', () => {
  console.log('[INFO] Auth sukses, mantap!');
});

client.on('auth_failure', (msg) => {
  console.error('[AUTH ERROR]', msg);
});

client.on('disconnected', (reason) => {
  console.log('[DISCONNECTED]', reason);
});

/*******************************************************
 *   HANDLE PESAN MASUK
 *******************************************************/
client.on('message', async (message) => {
  const senderNumber = getSenderNumber(message);
  if (!senderNumber) return;

  if (!sessions.has(senderNumber)) {
    sessions.set(senderNumber, { context: [], lastActive: Date.now() });
  }
  const session = sessions.get(senderNumber);

  const lowerText = message.body.trim().toLowerCase();

  /*******************************************************
   * FITUR: KIRIM PESAN => NOMOR
   *******************************************************/
  if (lowerText.startsWith('kirim ')) {
    if (!isPremiumUser(message)) {
      await message.reply('Fitur ini Premium-only, bos. Upgrade? ketik "premium".');
      return;
    }
    const splitted = message.body.trim().split(/\s+/);
    if (splitted.length < 3) {
      await message.reply('Format: kirim <nomor> <pesan>. Contoh: kirim 628xxx Halo!');
      return;
    }
    const targetNumber = splitted[1];
    const textMessage = splitted.slice(2).join(' ');
    try {
      await sendCustomMessage(targetNumber, textMessage);
      await message.reply('Berhasil gue kirim bos!');
    } catch (err) {
      await message.reply(`Gagal kirim: ${err.message}`);
    }
    return;
  }

  /*******************************************************
   * FITUR: JOIN GRUP
   *******************************************************/
  if (lowerText.startsWith('join grup ')) {
    if (!isPremiumUser(message)) {
      await message.reply('Fitur join grup buat Premium. Mau upgrade? ketik "premium".');
      return;
    }
    const splitted = message.body.trim().split(/\s+/);
    if (splitted.length < 3) {
      await message.reply('Format: join grup <link>');
      return;
    }
    const link = splitted[2];
    try {
      await joinGroupByLink(link);
      await message.reply('Oke, gue udah join tuh grup!');
    } catch (err) {
      await message.reply(`Gagal join: ${err.message}`);
    }
    return;
  }

  /*******************************************************
   * FITUR: STATUS
   *******************************************************/
  if (lowerText === 'status') {
    const now = moment().format('DD-MM-YYYY HH:mm:ss');
    await message.reply(`Bot on bos!\nWaktu server: ${now}`);
    return;
  }

  /*******************************************************
   * FITUR: PREMIUM
   *******************************************************/
  if (lowerText === 'premium') {
    const info = await generateAiPremiumInfo();
    await message.reply(info);
    return;
  }

  /*******************************************************
   * FITUR: INFO
   *******************************************************/
  if (lowerText === 'info') {
    if (isPremiumUser(message)) {
      await message.reply('Lu Premium, aman. Jatah unlimited.');
    } else {
      const remain = getRemainingUsage(message);
      await message.reply(`Free user, sisa jatah: ${remain}.\nButuh no limit? ketik "premium"!`);
    }
    return;
  }

  /*******************************************************
   * FITUR: JADWALKAN => KE GRUP / NOMOR
   *******************************************************/
  if (lowerText.includes('jadwalkan')) {
    if (!isPremiumUser(message)) {
      await message.reply('Maaf, jadwal ini cuma buat Premium. Upgrade? ketik "premium".');
      return;
    }
    const parsed = parseEasyScheduleInput(message.body.toLowerCase());
    if (!parsed) {
      await message.reply(`
Format belum gue pahami. Coba gini:
"jadwalkan chat ke grup Grafisier jam 11.23 sekarang: Halo guys!"
"jadwalkan chat ke 628xxx jam 19:00 besok: Assalamualaikum" 
      `);
      return;
    }
    // Tanyakan rephrase
    session.scheduleTemp = parsed;
    await message.reply('Mau gue rapihin (iya/nggak)?');
    return;
  }

  // User jawab "iya" rephrase
  if (session.scheduleTemp && (lowerText === 'iya' || lowerText === 'ya')) {
    const { isGroup, target, date, text } = session.scheduleTemp;
    session.scheduleTemp = null;

    const finalText = await rephraseMessageAI(text);

    let sendTo = null;
    if (isGroup) {
      const foundGroup = await findGroupByName(target);
      if (!foundGroup) {
        await message.reply(`Gak nemu grup "${target}". Cek namanya bener, bos.`);
        return;
      }
      sendTo = { id: foundGroup.id._serialized, type: 'group' };
    } else {
      const normalized = target.replace(/\D/g, '') + '@c.us';
      sendTo = { id: normalized, type: 'number' };
    }

    await scheduleMessage(sendTo, date, finalText);
    const dtStr = moment(date).format('DD-MM-YYYY HH:mm');
    await message.reply(`Oke, gue rapihin dikit. Pesan nanti gue kirim jam ${dtStr}.`);
    return;
  }

  // User jawab "nggak", "no", "tidak"
  if (session.scheduleTemp && (lowerText === 'nggak' || lowerText === 'tidak' || lowerText === 'no')) {
    const { isGroup, target, date, text } = session.scheduleTemp;
    session.scheduleTemp = null;

    let sendTo = null;
    if (isGroup) {
      const foundGroup = await findGroupByName(target);
      if (!foundGroup) {
        await message.reply(`Gak nemu grup "${target}".`);
        return;
      }
      sendTo = { id: foundGroup.id._serialized, type: 'group' };
    } else {
      const normalized = target.replace(/\D/g, '') + '@c.us';
      sendTo = { id: normalized, type: 'number' };
    }

    await scheduleMessage(sendTo, date, text);
    const dtStr = moment(date).format('DD-MM-YYYY HH:mm');
    await message.reply(`Siap, gue kirim jam ${dtStr} nanti.`);
    return;
  }

  /*******************************************************
   * FITUR: PREFERENSI WKW / TEXT
   *******************************************************/
  if (lowerText === 'wkw') {
    userPreferences.set(senderNumber, 'wkw');
    await message.reply('Sip, gue balas pakai voice (TTS).');
    return;
  } else if (lowerText === 'text') {
    userPreferences.set(senderNumber, 'text');
    await message.reply('Oke, gue balas teks aja ya.');
    return;
  }

  /*******************************************************
   * SELAIN ITU => PROSES LLM (Groq AI)
   *******************************************************/
  if (!canUseService(message)) {
    await message.reply(`Waduh, jatah free abis. Upgrade? ketik "premium".`);
    return;
  }
  incrementUsage(message);

  session.context.push({ role: 'user', content: message.body.trim() });
  const limit = getContextLimit(message);
  if (session.context.length > limit) session.context.shift();
  session.lastActive = Date.now();

  try {
    const aiResponseRaw = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 256,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `
Kamu AI WhatsApp bergaya tongkrongan tapi profesional saat perlu.
Jawab user dalam bahasa Indonesia, boleh slang, tapi tetep sopan kalo butuh.
        `
        },
        ...session.context
      ]
    }).then(res => res.choices[0]?.message?.content || '[AI: gak jawab.]');

    const aiResponse = await translateToIndonesian(aiResponseRaw);

    const pref = userPreferences.get(senderNumber) || 'text';
    if (pref === 'text') {
      const parts = splitMessage(aiResponse);
      for (const part of parts) {
        await message.reply(part);
      }
    } else {
      const audioPath = await generateAudio(aiResponse);
      if (audioPath) {
        const media = MessageMedia.fromFilePath(audioPath);
        await client.sendMessage(message.from, media, { caption: 'Dengerin nih:' });
        fs.unlinkSync(audioPath);
      } else {
        await message.reply(`Maaf, TTS error. Gue balas teks aja:\n${aiResponse}`);
      }
    }

    // // Soft selling kalau free
    // if (!isPremiumUser(message)) {
    //   const promo = await generateAiPromoMessage();
    //   await message.reply(`\n\n${promo}\n*(Ketik "premium" untuk upgrade!)*`);
    // }

  } catch (err) {
    console.error('[ERR AI]', err);
    await message.reply('Duh, ada error bos. Coba lagi nanti.');
  }
});

/*******************************************************
 *  INISIALISASI
 *******************************************************/
client.initialize();

/*******************************************************
 *  BERSIHKAN SESSION TIDAK AKTIF > 1 JAM
 *******************************************************/
setInterval(() => {
  const now = Date.now();
  for (const [senderNumber, session] of sessions.entries()) {
    if (now - session.lastActive > 3600000) {
      sessions.delete(senderNumber);
    }
  }
}, 60000);

/*******************************************************
 *  BERSIHKAN AUDIO > 1 JAM
 *******************************************************/
setInterval(() => {
  const files = fs.readdirSync(responsesFolder);
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(responsesFolder, file);
    const stats = fs.statSync(filePath);
    if (now - stats.mtimeMs > 3600000) {
      fs.unlinkSync(filePath);
    }
  }
}, 60000);

/*******************************************************
 *  PESAN PAGI (08.00) & MALAM (23.00)
 *******************************************************/
async function generateAiMorningMessage() {
  try {
    const result = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 60,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `
Gaya tongkrongan. Buat sapaan pagi (1-2 kalimat) 
sedikit konyol tapi positif.
        `
        }
      ]
    });
    const content = result.choices[0]?.message?.content?.trim() || '';
    return await translateToIndonesian(content);
  } catch {
    return "Selamat pagi bos! (Error)";
  }
}

async function generateAiNightMessage() {
  try {
    const result = await groq.chat.completions.create({
      model: 'gemma2-9b-it',
      max_tokens: 60,
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `
Gaya tongkrongan. Buat ucapan selamat malam (1-2 kalimat), 
boleh nyeleneh tapi positif.
        `
        }
      ]
    });
    const content = result.choices[0]?.message?.content?.trim() || '';
    return await translateToIndonesian(content);
  } catch {
    return "Selamat malam, bos! (Error)";
  }
}

async function broadcastMessage(msg) {
  for (const [senderNumber] of sessions.entries()) {
    const chatId = senderNumber + '@c.us';
    await client.sendMessage(chatId, msg);
  }
}

// Jadwal pagi
schedule.scheduleJob('0 8 * * *', async () => {
  try {
    const morningMsg = await generateAiMorningMessage();
    await broadcastMessage(morningMsg);
    console.log('[INFO] Pesan pagi terkirim:', morningMsg);
  } catch (err) {
    console.error('[ERROR PAGI]', err);
  }
});

// Jadwal malam
schedule.scheduleJob('0 23 * * *', async () => {
  try {
    const nightMsg = await generateAiNightMessage();
    await broadcastMessage(nightMsg);
    console.log('[INFO] Pesan malam terkirim:', nightMsg);
  } catch (err) {
    console.error('[ERROR MALAM]', err);
  }
});
