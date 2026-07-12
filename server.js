// ============================================================
// server.js — الـ Backend الكامل ديال تطبيق "تبادل"
// ============================================================
// شنو كيدير هاد الملف:
// 1. كيتحقق من هوية المستخدم عبر Telegram (initData) بشكل آمن.
// 2. كيحفظ المستخدمين، القنوات، النقاط، البلاغات فقاعدة بيانات SQLite.
// 3. كيعطي "endpoints" (عناوين) للواجهة (Frontend) باش تتواصل معاهم.
// 4. كيعطي صفحة عرض عامة (landing.html) فـ "/" باش تبان لأي زائر عادي
//    (بما فيهم بوتات التحقق ديال شركات الإعلانات بحال Monetag)،
//    والتطبيق الحقيقي (Mini App) بقى فـ "/app" باش يفتح غير من داخل Telegram.
//
// قبل ما ترفعو لـ Railway:
// - ما خاصكش تبدل شي حاجة هنا يدويا، غير خاصك تزيد Variable اسمها
//   BOT_TOKEN فإعدادات Railway (شرحنا هاد الخطوة قبل).
// ============================================================

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // إلا حطيتي شي ملفات إضافية فمجلد public

// ============================================================
// صفحة العرض العامة (Landing Page) — "/"
// هاذي الصفحة كتبان لأي زائر عادي (متصفح، بوت تحقق ديال Monetag، إلخ)
// بلا ما تتطلب Telegram. هنا خاصك تحط سكريبت Monetag فـ landing.html.
// ============================================================
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'landing.html'));
});

// ============================================================
// التطبيق الحقيقي (Telegram Mini App) — "/app"
// هاد الرابط بالضبط (مع /app) هو لي خاصك تحطو فـ BotFather فخطوة /newapp
// ============================================================
app.get('/app', (req, res) => {
  res.sendFile(path.join(__dirname, 'sub-exchange-app.html'));
});

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN; // خاصو يكون معرف فـ Railway Variables

if (!BOT_TOKEN) {
  console.warn('⚠️  تنبيه: BOT_TOKEN ماشي معرف. التحقق من الهوية غايفشل. زيدو فـ Railway Variables.');
}

// ============================================================
// قاعدة البيانات (SQLite) — كتصنع تلقائيا فأول تشغيل
// ============================================================
const db = new Database(path.join(__dirname, 'database.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT,
    points INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS channels (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    url TEXT NOT NULL,
    remaining INTEGER NOT NULL,
    total INTEGER NOT NULL,
    reports INTEGER NOT NULL DEFAULT 0,
    frozen INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS completions (
    user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, channel_id)
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id TEXT NOT NULL,
    reporter_id TEXT NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    UNIQUE(channel_id, reporter_id)
  );

  CREATE TABLE IF NOT EXISTS ad_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// ============================================================
// التحقق من رابط القناة (نفس المنطق لي كان فالواجهة، مكرر هنا
// من جهة السيرفر لأن الواجهة وحدها ما كتكفيش - أي حد يقدر
// يبعت طلب مباشر للسيرفر بلا ما يمر من الواجهة)
// ============================================================
const PLATFORM_PATTERNS = {
  TikTok: /^https?:\/\/(www\.)?tiktok\.com\/@[a-zA-Z0-9._]+\/?$/i,
  Instagram: /^https?:\/\/(www\.)?instagram\.com\/[a-zA-Z0-9._]+\/?$/i,
  YouTube: /^https?:\/\/(www\.)?youtube\.com\/(@|c\/|channel\/|user\/)[a-zA-Z0-9._-]+\/?$/i,
  Telegram: /^https?:\/\/(www\.)?t\.me\/[a-zA-Z0-9_]+\/?$/i,
  X: /^https?:\/\/(www\.)?(x\.com|twitter\.com)\/[a-zA-Z0-9_]+\/?$/i,
  Facebook: /^https?:\/\/(www\.)?facebook\.com\/[a-zA-Z0-9.]+\/?$/i,
  Snapchat: /^https?:\/\/(www\.)?snapchat\.com\/add\/[a-zA-Z0-9._-]+\/?$/i
};

function validateChannel(platform, url) {
  const pattern = PLATFORM_PATTERNS[platform];
  if (!pattern) return 'منصة غير مدعومة';
  if (!pattern.test((url || '').trim())) return 'شكل الرابط ما كيطابقش هاد المنصة';
  const dup = db.prepare('SELECT id FROM channels WHERE url = ?').get(url.trim());
  if (dup) return 'هاد الرابط مضاف من قبل';
  return null;
}

// ============================================================
// التحقق من هوية Telegram (الجزء الأهم والأدق فكل السيرفر)
// كيفاش كيخدم: Telegram Mini App كيبعت initData موقعة بتوقيع
// رقمي. هنا كنتحققو أن التوقيع صحيح وجاي فعلا من Telegram،
// بواسطة الـ BOT_TOKEN السري لي ما يشوفوش حتى المستخدم.
// المرجع الرسمي: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// ============================================================
function verifyTelegramInitData(initData) {
  if (!initData || !BOT_TOKEN) return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null; // التوقيع غير صحيح = طلب مزور أو منتهي

  // تحقق من عمر الطلب (نرفضو أي initData أقدم من ساعة، حماية إضافية)
  const authDate = parseInt(params.get('auth_date') || '0', 10);
  if (Date.now() / 1000 - authDate > 3600) return null;

  const userJson = params.get('user');
  if (!userJson) return null;
  try {
    return JSON.parse(userJson); // { id, first_name, username, ... }
  } catch {
    return null;
  }
}

// Middleware: كل endpoint حساس خاصو يمر من هنا أولا
function requireTelegramAuth(req, res, next) {
  const initData = req.header('X-Telegram-Init-Data') || req.body.initData;
  const tgUser = verifyTelegramInitData(initData);
  if (!tgUser) {
    return res.status(401).json({ error: 'فشل التحقق من الهوية. عاود فتح التطبيق من داخل Telegram.' });
  }
  req.tgUser = tgUser;

  // نتأكدو أن المستخدم عندو سطر فقاعدة البيانات، وإلا نصنعوه
  const id = String(tgUser.id);
  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!existing) {
    db.prepare('INSERT INTO users (id, username, points, created_at) VALUES (?, ?, 0, ?)')
      .run(id, tgUser.username || tgUser.first_name || 'مستخدم', Date.now());
  }
  req.userId = id;
  next();
}

// ============================================================
// Endpoints
// ============================================================

// معلومات المستخدم الحالي + قنواته
app.get('/api/me', requireTelegramAuth, (req, res) => {
  const user = db.prepare('SELECT id, points FROM users WHERE id = ?').get(req.userId);
  const myChannels = db.prepare('SELECT * FROM channels WHERE owner_id = ?').all(req.userId);
  res.json({ user, channels: myChannels });
});

// تسجيل قناة جديدة (الأولى مجانية بحد أقصى 1000، الباقي بالنقاط)
app.post('/api/register-channel', requireTelegramAuth, (req, res) => {
  const { platform, url } = req.body;
  let { target } = req.body;
  target = parseInt(target, 10);

  const err = validateChannel(platform, url);
  if (err) return res.status(400).json({ error: err });

  const existingCount = db.prepare('SELECT COUNT(*) AS c FROM channels WHERE owner_id = ?').get(req.userId).c;
  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.userId);

  if (existingCount === 0) {
    // القناة الأولى: مجانية، حد أقصى 1000
    if (!target || target < 1) target = 1;
    if (target > 1000) target = 1000;
  } else {
    // القنوات التالية: بالنقاط
    if (!target || target < 1) return res.status(400).json({ error: 'حدد عدد مشتركين صحيح' });
    if (user.points < target) return res.status(400).json({ error: 'رصيد النقاط ما كفاش' });
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(target, req.userId);
  }

  const id = crypto.randomUUID();
  db.prepare(`
    INSERT INTO channels (id, owner_id, platform, url, remaining, total, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.userId, platform, url.trim(), target, target, Date.now());

  res.json({ ok: true, channelId: id });
});

// لائحة المهام (قنوات آخرين يقدر يتابعها المستخدم)
app.get('/api/tasks', requireTelegramAuth, (req, res) => {
  const tasks = db.prepare(`
    SELECT c.* FROM channels c
    WHERE c.owner_id != ?
      AND c.remaining > 0
      AND c.frozen = 0
      AND c.id NOT IN (SELECT channel_id FROM completions WHERE user_id = ?)
    ORDER BY c.created_at ASC
    LIMIT 20
  `).all(req.userId, req.userId);
  res.json({ tasks });
});

// تأكيد إنجاز مهمة (متابعة قناة) — كل المنطق الحساس هنا فالسيرفر
app.post('/api/confirm-task', requireTelegramAuth, (req, res) => {
  const { channelId } = req.body;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);

  if (!channel) return res.status(404).json({ error: 'القناة ماكايناش' });
  if (channel.owner_id === req.userId) return res.status(400).json({ error: 'ما يمكنش تتابع قناتك ديالك' });
  if (channel.remaining <= 0 || channel.frozen) return res.status(400).json({ error: 'هاد المهمة ماعادش متاحة' });

  const already = db.prepare('SELECT 1 FROM completions WHERE user_id = ? AND channel_id = ?').get(req.userId, channelId);
  if (already) return res.status(400).json({ error: 'ديجا أنجزتي هاد المهمة' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE channels SET remaining = remaining - 1 WHERE id = ?').run(channelId);
    db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').run(req.userId);
    db.prepare('INSERT INTO completions (user_id, channel_id, created_at) VALUES (?, ?, ?)')
      .run(req.userId, channelId, Date.now());
  });
  tx();

  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.userId);
  res.json({ ok: true, points: user.points });
});

// زيادة هدف قناة موجودة (بالنقاط)
app.post('/api/bump-target', requireTelegramAuth, (req, res) => {
  const { channelId, amount } = req.body;
  const amt = parseInt(amount, 10);
  if (!amt || amt < 1) return res.status(400).json({ error: 'عدد غير صحيح' });

  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel || channel.owner_id !== req.userId) return res.status(404).json({ error: 'القناة ماكايناش' });

  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.userId);
  if (user.points < amt) return res.status(400).json({ error: 'رصيد النقاط ما كفاش' });

  const tx = db.transaction(() => {
    db.prepare('UPDATE users SET points = points - ? WHERE id = ?').run(amt, req.userId);
    db.prepare('UPDATE channels SET remaining = remaining + ?, total = total + ? WHERE id = ?').run(amt, amt, channelId);
  });
  tx();

  res.json({ ok: true });
});

// الإبلاغ عن قناة (متابعات وهمية / رابط خاطئ...)
const REPORT_THRESHOLD = 5; // بعد 5 بلاغات مختلفة، القناة كتتجمد تلقائيا

app.post('/api/report', requireTelegramAuth, (req, res) => {
  const { channelId, reason } = req.body;
  const channel = db.prepare('SELECT * FROM channels WHERE id = ?').get(channelId);
  if (!channel) return res.status(404).json({ error: 'القناة ماكايناش' });

  try {
    db.prepare('INSERT INTO reports (channel_id, reporter_id, reason, created_at) VALUES (?, ?, ?, ?)')
      .run(channelId, req.userId, reason || '', Date.now());
  } catch (e) {
    return res.status(400).json({ error: 'ديجا بلغتي على هاد القناة' });
  }

  const reportCount = db.prepare('SELECT COUNT(*) AS c FROM reports WHERE channel_id = ?').get(channelId).c;
  db.prepare('UPDATE channels SET reports = ? WHERE id = ?').run(reportCount, channelId);

  if (reportCount >= REPORT_THRESHOLD) {
    db.prepare('UPDATE channels SET frozen = 1 WHERE id = ?').run(channelId);
  }

  res.json({ ok: true, reportCount, frozen: reportCount >= REPORT_THRESHOLD });
});

// مكافأة مشاهدة إعلان (Monetag) — نقطة وحدة، مع حماية بسيطة من الاستغلال:
// - كولداون 20 ثانية بين كل مشاهدة وأخرى لنفس المستخدم
// - حد أقصى 20 مشاهدة فاليوم لكل مستخدم
// ملاحظة: هادي حماية أساسية بلا تحقق server-to-server من Monetag،
// لأن هاد الـ SDK كيخدم client-side فقط (بلا postback رسمي فهاد الإصدار).
const AD_COOLDOWN_MS = 20 * 1000;
const AD_DAILY_LIMIT = 20;

app.post('/api/watch-ad', requireTelegramAuth, (req, res) => {
  const now = Date.now();
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const last = db.prepare('SELECT created_at FROM ad_views WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(req.userId);
  if (last && now - last.created_at < AD_COOLDOWN_MS) {
    return res.status(429).json({ error: 'تسنى شوية قبل ما تشوف إعلان آخر' });
  }

  const countToday = db.prepare('SELECT COUNT(*) AS c FROM ad_views WHERE user_id = ? AND created_at > ?').get(req.userId, dayAgo).c;
  if (countToday >= AD_DAILY_LIMIT) {
    return res.status(429).json({ error: 'وصلتي للحد الأقصى ديال الإعلانات اليوم، عاود غدا' });
  }

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO ad_views (user_id, created_at) VALUES (?, ?)').run(req.userId, now);
    db.prepare('UPDATE users SET points = points + 1 WHERE id = ?').run(req.userId);
  });
  tx();

  const user = db.prepare('SELECT points FROM users WHERE id = ?').get(req.userId);
  res.json({ ok: true, points: user.points });
});

// فحص صحة السيرفر (تقدر تفتحو فالمتصفح باش تتأكد أن السيرفر خدام)
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

app.listen(PORT, () => {
  console.log(`✅ السيرفر خدام على المنفذ ${PORT}`);
});
