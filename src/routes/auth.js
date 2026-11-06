const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../services/database');
const logger = require('../services/logger');
const { emitSyncAll } = require('../services/configEvents');
const { requireAuth } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const { getClientIp, parseIpAllowlist, isIpAllowed } = require('../utils/clientIp');
const { safeTokenEqual } = require('../utils/securityTokens');
const { toPosInt } = require('../utils/validators');
const { hashPassword, verifyPassword } = require('../utils/password');
const { sendMail } = require('../services/mailer');

const router = express.Router();
const { PersistentMap } = require('../../workers/persistent-map');
const usedTempLoginTokens = process.env.WORKERS_RUNTIME ? new PersistentMap('temp-login') : new Map();

// 邮箱验证码存储: email -> { code, expiresAt, attempts }
const emailCodes = process.env.WORKERS_RUNTIME ? new PersistentMap('email-codes') : new Map();
const CODE_TTL = 10 * 60 * 1000; // 10 分钟
const CODE_COOLDOWN = 60 * 1000;  // 60 秒发送间隔

// 全局每小时发送量限制，防止被滥用导致 SMTP 封号
const GLOBAL_HOURLY_LIMIT = 50;
let globalSendCount = 0;
let globalSendWindowStart = Date.now();

function checkGlobalSendLimit() {
  const now = Date.now();
  if (now - globalSendWindowStart > 60 * 60 * 1000) {
    globalSendCount = 0;
    globalSendWindowStart = now;
  }
  if (globalSendCount >= GLOBAL_HOURLY_LIMIT) return false;
  globalSendCount++;
  return true;
}

// 同一收件人每小时最多 3 封
const recipientSendTimes = new Map(); // email -> [timestamps]
const RECIPIENT_HOURLY_LIMIT = 3;

function checkRecipientLimit(email) {
  const now = Date.now();
  const times = (recipientSendTimes.get(email) || []).filter(t => now - t < 60 * 60 * 1000);
  if (times.length >= RECIPIENT_HOURLY_LIMIT) return false;
  times.push(now);
  recipientSendTimes.set(email, times);
  return true;
}

function cleanupExpiredCodes() {
  const now = Date.now();
  for (const [k, v] of emailCodes) {
    if (now > v.expiresAt) emailCodes.delete(k);
  }
  // forgotCodes 在文件后面定义，setInterval 回调执行时已初始化
  try { for (const [k, v] of forgotCodes) { if (now > v.expiresAt) forgotCodes.delete(k); } } catch (_) {}
}
setInterval(cleanupExpiredCodes, 5 * 60 * 1000).unref();

// Gmail 别名标准化：去掉点号和加号后缀，防止同一邮箱多次注册
function normalizeGmail(email) {
  const [local, domain] = email.split('@');
  if (!domain || !['gmail.com', 'googlemail.com'].includes(domain)) return email;
  return local.replace(/\./g, '').replace(/\+.*$/, '') + '@gmail.com';
}

function isGmailDotAbuse(email) {
  const [local, domain] = email.split('@');
  if (!domain || !['gmail.com', 'googlemail.com'].includes(domain)) return false;
  return /[.+]/.test(local);
}

function isEmailRegistered(email) {
  if (db.getUserByEmail(email)) return true;
  const norm = normalizeGmail(email);
  if (norm !== email && db.getUserByEmail(norm)) return true;
  // 检查已注册邮箱标准化后是否与当前一致
  const allUsers = db.getAllUsers();
  return allUsers.some(u => u.email && normalizeGmail(u.email.toLowerCase()) === norm);
}

function isInviteRegistrationEnabled() {
  return db.getSetting('invite_registration_enabled') !== 'false';
}

function getUsedTokenTtlMs() {
  return toPosInt(process.env.TEMP_LOGIN_USED_TOKEN_TTL_MS, 24 * 60 * 60 * 1000, 1000, 30 * 24 * 60 * 60 * 1000);
}

function getUsedTokenMaxEntries() {
  return toPosInt(process.env.TEMP_LOGIN_USED_TOKEN_MAX_ENTRIES, 10000, 1, 200000);
}

if (process.env.TEMP_LOGIN_ENABLED === 'true') {
  logger.warn('TEMP_LOGIN_ENABLED=true，请确保仅用于应急且已配置严格访问限制');
}

// 登录页
router.get('/login', (req, res) => {
  res.render('login', { error: req.query.error || '', message: req.query.message || '' });
});

const sendCodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: JSON.stringify({ ok: false, error: '发送过于频繁，请稍后重试' }),
  standardHeaders: true,
  legacyHeaders: false,
});

// 邮箱注册入口页
router.get('/email-register', (req, res) => {
  const registrationOpen = db.getSetting('registration_open') !== 'false';
  const allowedDomains = db.getSetting('allowed_email_domains') || '';
  res.render('email-register', {
    error: req.query.error || '',
    message: req.query.message || '',
    email: req.query.email || '',
    inviteCode: req.query.inviteCode || '',
    registrationClosed: !registrationOpen,
    allowedDomains,
    firstUserMode: db.getUserCount() === 0,
    inviteEnabled: isInviteRegistrationEnabled(),
  });
});

// 发送邮箱验证码
router.post('/send-email-code', sendCodeLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const inviteCode = normalizeInviteCode(req.body?.inviteCode || '');
  if (!isValidEmail(email)) return res.json({ ok: false, error: '邮箱格式不正确' });
  if (isGmailDotAbuse(email)) return res.json({ ok: false, error: '请使用标准 Gmail 地址注册' });
  if (isEmailRegistered(email)) return res.json({ ok: false, error: '该邮箱已注册' });

  // 首位用户免验证码：系统无用户时跳过邮件发送，直接标记通过
  if (db.getUserCount() === 0) {
    emailCodes.set(email, { code: '000000', expiresAt: Date.now() + CODE_TTL, attempts: 0 });
    return res.json({ ok: true, skipCode: true });
  }

  // 注册开关检查
  const registrationOpen = db.getSetting('registration_open') !== 'false';
  if (!registrationOpen) {
    return res.json({ ok: false, error: '注册已关闭' });
  }
  if (isInviteRegistrationEnabled()) {
    const inviteError = getInviteError(inviteCode);
    if (inviteError) {
      return res.json({ ok: false, error: inviteError });
    }
  }

  // 邮箱后缀检查
  const allowedDomains = (db.getSetting('allowed_email_domains') || '').split(',').filter(Boolean);
  if (allowedDomains.length > 0) {
    const domain = email.split('@')[1] || '';
    if (!allowedDomains.includes(domain)) {
      return res.json({ ok: false, error: '该邮箱后缀不允许注册' });
    }
  }

  const existing = emailCodes.get(email);
  if (existing && Date.now() - (existing.expiresAt - CODE_TTL) < CODE_COOLDOWN) {
    return res.json({ ok: false, error: '发送过于频繁，请稍后重试' });
  }

  if (!checkGlobalSendLimit()) {
    return res.json({ ok: false, error: '系统发送邮件过于频繁，请稍后重试' });
  }
  if (!checkRecipientLimit(email)) {
    return res.json({ ok: false, error: '该邮箱发送过于频繁，请稍后重试' });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  emailCodes.set(email, { code, expiresAt: Date.now() + CODE_TTL, attempts: 0 });

  try {
    await sendMail({
      to: email,
      subject: '验证码',
      html: `
<div style="max-width:420px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#333">
  <div style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px 24px">
    <h2 style="margin:0 0 16px;font-size:18px;color:#111">邮箱验证</h2>
    <p style="font-size:14px;margin:0 0 20px;color:#555">您正在注册账号，请使用以下验证码完成验证：</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;margin:0 0 20px">
      <span style="font-size:32px;font-weight:700;color:#111;font-family:'Courier New',monospace;letter-spacing:6px">${code}</span>
    </div>
    <p style="font-size:12px;color:#888;margin:0 0 4px">验证码 10 分钟内有效，请勿泄露给他人。</p>
    <p style="font-size:12px;color:#888;margin:0">如果这不是您的操作，请忽略此邮件。</p>
  </div>
</div>`,
      text: `您的注册验证码是：${code}，10 分钟内有效。`,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err, email }, '发送验证码邮件失败');
    emailCodes.delete(email);
    res.json({ ok: false, error: getSendMailErrorMessage(err) });
  }
});

const emailRegisterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: '注册请求过于频繁，请稍后重试',
  standardHeaders: true,
  legacyHeaders: false,
});

const emailLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: '登录请求过于频繁，请稍后重试',
  standardHeaders: true,
  legacyHeaders: false,
});

function isValidEmail(email) {
  const value = String(email || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function normalizeInviteCode(code) {
  return String(code || '').trim().toUpperCase();
}

function getInviteError(inviteCode) {
  const code = normalizeInviteCode(inviteCode);
  if (!code) return '请输入邀请码';
  const invite = db.getUsableInviteCode(code);
  if (!invite) return '邀请码无效或已过期';
  return '';
}

function getSendMailErrorMessage(err) {
  const code = String(err?.code || '').toUpperCase();
  const responseCode = Number(err?.responseCode || 0);
  const message = String(err?.message || '');

  if (code === 'EAUTH' || responseCode === 535 || /authentication failed/i.test(message)) {
    return '邮件服务认证失败，请检查后台 SMTP 用户名或密码';
  }
  if (code === 'ETIMEDOUT' || code === 'ESOCKET' || code === 'ECONNECTION') {
    return '邮件服务器连接失败，请检查 SMTP 主机、端口或网络';
  }
  if (/recipient|address|mailbox unavailable|no such user/i.test(message)) {
    return '收件邮箱地址无效';
  }
  return '邮件发送失败，请稍后重试';
}

function normalizeUsernameSeed(email) {
  const local = String(email || '').split('@')[0] || '';
  const normalized = local.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
  return normalized || `user${Date.now().toString().slice(-6)}`;
}

function resolveAvailableUsername(seed) {
  const base = (seed || 'user').slice(0, 32);
  if (!db.getUserByUsername(base)) return base;
  for (let i = 1; i < 10000; i++) {
    const suffix = String(i);
    const cut = Math.max(1, 32 - suffix.length);
    const candidate = `${base.slice(0, cut)}${suffix}`;
    if (!db.getUserByUsername(candidate)) return candidate;
  }
  return `${base.slice(0, 24)}${Date.now().toString().slice(-8)}`;
}

router.post('/email-register', emailRegisterLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const displayName = String(req.body?.name || '').trim();
  const password = String(req.body?.password || '');
  const passwordConfirm = String(req.body?.passwordConfirm || '');
  const code = String(req.body?.code || '').replace(/\s/g, '');
  const inviteCode = normalizeInviteCode(req.body?.inviteCode || '');
  const fail = (msg) => res.redirect('/auth/email-register?error=' + encodeURIComponent(msg) + '&email=' + encodeURIComponent(email) + '&inviteCode=' + encodeURIComponent(inviteCode));

  if (!isValidEmail(email)) {
    return fail('邮箱格式不正确');
  }
  if (isGmailDotAbuse(email)) {
    return fail('请使用标准 Gmail 地址注册');
  }

  // 验证码校验
  const stored = emailCodes.get(email);
  if (!stored || Date.now() > stored.expiresAt) {
    emailCodes.delete(email);
    return fail('验证码已过期，请重新发送');
  }
  if (stored.attempts >= 5) {
    emailCodes.delete(email);
    return fail('验证码错误次数过多，请重新发送');
  }
  if (!safeTokenEqual(stored.code, code)) {
    stored.attempts++;
    emailCodes.set(email, stored);
    return fail('验证码错误');
  }

  if (password.length < 8) {
    return fail('密码至少 8 位');
  }
  if (password.length > 128) {
    return fail('密码长度不能超过 128 位');
  }
  if (password !== passwordConfirm) {
    return fail('两次密码不一致');
  }
  if (isEmailRegistered(email)) {
    return fail('该邮箱已注册');
  }

  const seed = normalizeUsernameSeed(email);
  const username = resolveAvailableUsername(seed);

  // 首位用户跳过注册开关和邮箱域名限制
  const inviteRegistrationEnabled = isInviteRegistrationEnabled();
  if (db.getUserCount() !== 0) {
    const registrationOpen = db.getSetting('registration_open') !== 'false';
    if (!registrationOpen) {
      return fail('注册已关闭，暂不接受新用户');
    }

    const allowedDomains = (db.getSetting('allowed_email_domains') || '').split(',').filter(Boolean);
    if (allowedDomains.length > 0) {
      const domain = email.split('@')[1] || '';
      if (!allowedDomains.includes(domain)) {
        return fail('该邮箱后缀不允许注册');
      }
    }

    if (inviteRegistrationEnabled) {
      const inviteError = getInviteError(inviteCode);
      if (inviteError) {
        return fail(inviteError);
      }
    }
  }

  emailCodes.delete(email);

  try {
    const passwordHash = hashPassword(password);
    if (!passwordHash) {
      return fail('密码处理失败');
    }
    const newUser = db.getUserCount() === 0 || !inviteRegistrationEnabled
      ? db.createEmailUser({
          username,
          email,
          passwordHash,
          displayName,
          ip: getClientIp(req),
        })
      : db.createInvitedEmailUser({
          username,
          email,
          passwordHash,
          displayName,
          inviteCode,
          ip: getClientIp(req),
        });

    req.logIn(newUser, (err) => {
      emitSyncAll();
      if (err) {
        return res.redirect('/auth/login?message=' + encodeURIComponent('注册成功，请登录'));
      }
      db.addAuditLog(newUser.id, 'login_email', `用户 ${newUser.username} 邮箱登录`, getClientIp(req));
      return res.redirect('/');
    });
  } catch (err) {
    logger.error({ err, email }, '邮箱注册失败');
    return fail('注册失败，请稍后重试');
  }
});

// ─── 找回密码 ───
const forgotCodes = process.env.WORKERS_RUNTIME ? new PersistentMap('forgot-codes') : new Map(); // email -> { code, expiresAt, attempts }

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { nonce: res.locals.nonce || '' });
});

router.post('/forgot-send-code', emailLoginLimiter, csrfProtection, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (!isValidEmail(email)) return res.json({ ok: false, error: '邮箱格式不正确' });
  const user = db.getUserByEmail(email);
  if (!user) return res.json({ ok: false, error: '该邮箱未注册' });

  const existing = forgotCodes.get(email);
  if (existing && Date.now() - (existing.expiresAt - CODE_TTL) < CODE_COOLDOWN) {
    return res.json({ ok: false, error: '发送过于频繁，请稍后重试' });
  }

  if (!checkGlobalSendLimit()) {
    return res.json({ ok: false, error: '系统发送邮件过于频繁，请稍后重试' });
  }
  if (!checkRecipientLimit(email)) {
    return res.json({ ok: false, error: '该邮箱发送过于频繁，请稍后重试' });
  }

  const code = String(crypto.randomInt(100000, 1000000));
  forgotCodes.set(email, { code, expiresAt: Date.now() + CODE_TTL, attempts: 0 });

  try {
    await sendMail({
      to: email,
      subject: '密码重置',
      html: `
<div style="max-width:420px;margin:0 auto;font-family:'Helvetica Neue',Arial,sans-serif;color:#333">
  <div style="background:#fff;border-radius:8px;border:1px solid #e5e7eb;padding:32px 24px">
    <h2 style="margin:0 0 16px;font-size:18px;color:#111">密码重置</h2>
    <p style="font-size:14px;margin:0 0 20px;color:#555">您正在重置密码，请使用以下验证码：</p>
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center;margin:0 0 20px">
      <span style="font-size:32px;font-weight:700;color:#111;font-family:'Courier New',monospace;letter-spacing:6px">${code}</span>
    </div>
    <p style="font-size:12px;color:#888;margin:0 0 4px">验证码 10 分钟内有效。</p>
    <p style="font-size:12px;color:#888;margin:0">如果这不是您的操作，请忽略此邮件。</p>
  </div>
</div>`,
      text: `您的密码重置验证码是：${code}，10 分钟内有效。`,
    });
    res.json({ ok: true });
  } catch (err) {
    logger.warn({ err, email }, '发送重置验证码失败');
    forgotCodes.delete(email);
    res.json({ ok: false, error: '邮件发送失败' });
  }
});

router.post('/forgot-reset', emailLoginLimiter, csrfProtection, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const code = String(req.body?.code || '').trim();
  const password = String(req.body?.password || '');

  const stored = forgotCodes.get(email);
  if (!stored || Date.now() > stored.expiresAt) {
    forgotCodes.delete(email);
    return res.json({ ok: false, error: '验证码已过期，请重新发送' });
  }
  stored.attempts++;
  forgotCodes.set(email, stored);
  if (stored.attempts > 5) {
    forgotCodes.delete(email);
    return res.json({ ok: false, error: '验证码错误次数过多，请重新发送' });
  }
  if (!safeTokenEqual(stored.code, code)) {
    return res.json({ ok: false, error: '验证码错误' });
  }
  if (password.length < 8) {
    return res.json({ ok: false, error: '密码至少 8 位' });
  }
  if (password.length > 128) {
    return res.json({ ok: false, error: '密码长度不能超过 128 位' });
  }

  const user = db.getUserByEmail(email);
  if (!user) return res.json({ ok: false, error: '用户不存在' });

  const passwordHash = hashPassword(password);
  db.getDb().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, user.id);
  forgotCodes.delete(email);
  db.addAuditLog(user.id, 'password_reset', `用户 ${user.username} 通过邮箱重置密码`, getClientIp(req));
  res.json({ ok: true });
});

router.post('/generate-invite-code', requireAuth, csrfProtection, (req, res) => {
  try {
    if ((req.user?.trust_level || 0) < 1) {
      return res.status(403).json({ ok: false, error: '仅 VIP 及以上等级可生成邀请码' });
    }
    const result = db.generateInviteCodeForUser(req.user.id, !!req.user.is_admin);
    if (!result.ok) {
      return res.json({
        ok: false,
        error: '每周只能生成一个邀请码',
        invite: result.invite,
        nextGenerateAt: result.nextGenerateAt,
      });
    }

    db.addAuditLog(req.user.id, 'invite_code_generate', `生成邀请码 ${result.invite.code}`, getClientIp(req));
    return res.json({
      ok: true,
      invite: result.invite,
      nextGenerateAt: result.nextGenerateAt,
    });
  } catch (err) {
    logger.error({ err, userId: req.user?.id }, '生成邀请码失败');
    return res.status(500).json({ ok: false, error: '生成邀请码失败，请稍后重试' });
  }
});

router.post('/email-login', emailLoginLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('请输入邮箱和密码'));
  }
  // 防 scrypt DoS：拒绝超长密码（合法用户不会有这种密码）
  if (password.length > 128) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('邮箱或密码错误'));
  }
  const user = db.getUserByEmail(email);
  if (!user || !user.password_hash || !verifyPassword(password, user.password_hash)) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('邮箱或密码错误'));
  }
  if (user.is_blocked) {
    return res.redirect('/auth/login?error=' + encodeURIComponent('账号已被封禁'));
  }

  req.logIn(user, (err) => {
    if (err) {
      return res.redirect('/auth/login?error=' + encodeURIComponent('登录失败'));
    }
    const loginIP = getClientIp(req);
    db.getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(user.id);
    db.addAuditLog(user.id, 'login_email', `用户 ${user.username} 邮箱登录`, loginIP);
    if (user.is_frozen && (user.freeze_reason === 'inactive' || user.freeze_reason === 'traffic')) {
      db.unfreezeUser(user.id);
      db.addAuditLog(user.id, 'login_auto_unfreeze', `用户 ${user.username} 登录自动解冻`, loginIP);
      emitSyncAll();
    }
    return res.redirect('/');
  });
});

const tempLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: '临时登录请求过于频繁，请稍后再试',
  standardHeaders: true,
  legacyHeaders: false,
});

function verifyTempLoginEnabled() {
  if (process.env.TEMP_LOGIN_ENABLED !== 'true') {
    return { ok: false, status: 404, message: 'Not Found' };
  }
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.TEMP_LOGIN_ALLOW_PROD !== 'true'
  ) {
    return { ok: false, status: 404, message: 'Not Found' };
  }
  return { ok: true };
}

function consumeTempLoginTokenIfNeeded(expected) {
  const oneTime = process.env.TEMP_LOGIN_ONE_TIME !== 'false';
  const fingerprint = crypto.createHash('sha256').update(String(expected || '')).digest('hex');
  const now = Date.now();
  const ttlMs = getUsedTokenTtlMs();
  const maxEntries = getUsedTokenMaxEntries();

  // TTL 清理：允许过期 token 指纹被回收，避免长期膨胀。
  for (const [fp, ts] of usedTempLoginTokens) {
    if (now - ts > ttlMs) usedTempLoginTokens.delete(fp);
  }

  // 容量保护：超过阈值后按最旧时间戳淘汰。
  if (usedTempLoginTokens.size > maxEntries) {
    const sorted = [...usedTempLoginTokens.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = usedTempLoginTokens.size - maxEntries;
    for (let i = 0; i < removeCount; i++) usedTempLoginTokens.delete(sorted[i][0]);
  }

  if (!oneTime) return { ok: true };
  const usedAt = usedTempLoginTokens.get(fingerprint);
  if (usedAt && (now - usedAt) <= ttlMs) {
    return { ok: false, message: '临时 token 已使用' };
  }
  usedTempLoginTokens.set(fingerprint, now);
  if (usedTempLoginTokens.size > maxEntries) {
    const sorted = [...usedTempLoginTokens.entries()].sort((a, b) => a[1] - b[1]);
    const removeCount = usedTempLoginTokens.size - maxEntries;
    for (let i = 0; i < removeCount; i++) usedTempLoginTokens.delete(sorted[i][0]);
  }
  return { ok: true };
}

// 临时登录通道（仅用于应急审查）
// 用法：POST /auth/temp-login  body: { token: "xxxx" }
// 需要环境变量：TEMP_LOGIN_ENABLED=true + TEMP_LOGIN_TOKEN=xxxx (+ TEMP_LOGIN_ALLOW_PROD=true 才允许生产环境)
// 可选过期时间：TEMP_LOGIN_EXPIRES_AT=毫秒时间戳
router.get('/temp-login', (req, res) => {
  const check = verifyTempLoginEnabled();
  if (!check.ok) return res.status(check.status).send(check.message);
  return res.status(405).send('Method Not Allowed: use POST /auth/temp-login');
});

router.post('/temp-login', tempLoginLimiter, (req, res) => {
  const check = verifyTempLoginEnabled();
  if (!check.ok) return res.status(check.status).send(check.message);

  const expected = process.env.TEMP_LOGIN_TOKEN || '';
  const token = req.body?.token || req.headers['x-temp-login-token'] || '';
  const expiresAt = parseInt(process.env.TEMP_LOGIN_EXPIRES_AT || '0', 10);
  const loginIP = getClientIp(req);
  const allowlist = parseIpAllowlist(process.env.TEMP_LOGIN_IP_ALLOWLIST || '');

  if (!expected) {
    return res.status(403).send('临时登录未配置 token');
  }
  if (expiresAt > 0 && Date.now() > expiresAt) {
    return res.status(403).send('临时登录已过期');
  }
  if (!safeTokenEqual(token, expected)) {
    return res.status(403).send('token 无效');
  }
  if (allowlist.length > 0 && !isIpAllowed(loginIP, allowlist)) {
    return res.status(403).send('当前 IP 不在允许列表');
  }
  const consumeResult = consumeTempLoginTokenIfNeeded(expected);
  if (!consumeResult.ok) {
    return res.status(403).send(consumeResult.message);
  }

  const row = db.getDb().prepare('SELECT id FROM users WHERE is_admin = 1 AND is_blocked = 0 ORDER BY id ASC LIMIT 1').get();
  if (!row) {
    return res.status(500).send('未找到可用管理员账号');
  }

  const user = db.getUserById(row.id);
  if (!user) {
    return res.status(500).send('管理员账号加载失败');
  }

  req.logIn(user, (err) => {
    if (err) return res.status(500).send('登录失败');
    db.addAuditLog(user.id, 'temp_login', `临时通道登录 ${user.username}`, loginIP);
    res.redirect('/admin');
  });
});

// 登出
router.get('/logout', (req, res) => {
  if (req.user) {
    db.addAuditLog(req.user.id, 'logout', `用户 ${req.user.username} 登出`, getClientIp(req));
  }
  req.logout(() => {
    res.redirect('/auth/login');
  });
});

module.exports = router;
module.exports._test = {
  consumeTempLoginTokenIfNeeded,
  usedTempLoginTokens,
};
