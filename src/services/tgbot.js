const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const logger = require('./logger');
const { formatBytes } = require('../utils/formatBytes');
const { getGroupLabel } = require('../utils/userGroup');
const { getTzDateParts, shiftIsoDate, today, weekKey, TG_TIMEZONE } = require('../utils/tgGame');

const TOKEN = process.env.TG_BOT_TOKEN;
let bot = null;
const DOMAIN = process.env.PANEL_DOMAIN || 'vip.sd';
let _botUsername = process.env.TG_BOT_USERNAME || null;

const MENU = {
  checkin: '签到',
  lucky: '大转盘',
  flip: '翻卡',
  rps: '猜拳',
  me: '我的',
  sub: '订阅',
  bind: '绑定账号',
  help: '功能介绍',
  support: '面板入口',
};

const MY_ACTIONS = {
  traffic: 'tg:my:traffic',
  nodes: 'tg:my:nodes',
  sub: 'tg:my:sub',
  admin: 'tg:my:admin',
};

function getBotUsername() { return _botUsername; }
/** Resolve the bot username from configuration, persistent cache or Telegram. */
async function ensureBotUsername() {
  if (_botUsername || !bot) return _botUsername;
  const cached = db.getSetting('tg_bot_username');
  if (cached) return (_botUsername = cached);
  const me = await bot.getMe();
  _botUsername = me.username;
  db.setSetting('tg_bot_username', _botUsername);
  return _botUsername;
}

// ─── 签到配置 ───
const CHECKIN_MIN_GB = 5;
const CHECKIN_MAX_GB = 10;

// ─── 工具函数 ───
function getUserByTgId(tgId) {
  return db.getDb().prepare('SELECT * FROM users WHERE telegram_id = ?').get(String(tgId));
}

function getActorId(msg) {
  return msg?.actor?.id ?? msg?.from?.id ?? null;
}

function countCurrentStreak(userId, endDate = today()) {
  if (!db.getDb().prepare('SELECT 1 FROM tg_checkin WHERE user_id = ? AND date = ?').get(userId, endDate)) {
    return 0;
  }
  let streak = 1;
  for (let i = 1; i <= 365; i++) {
    const prev = shiftIsoDate(endDate, -i);
    const has = db.getDb().prepare('SELECT 1 FROM tg_checkin WHERE user_id = ? AND date = ?').get(userId, prev);
    if (!has) break;
    streak += 1;
  }
  return streak;
}

function isPrivateChat(msg) {
  return msg.chat.type === 'private';
}

function sendPrivateOnly(msg) {
  return bot.sendMessage(
    msg.chat.id,
    '该功能仅限私聊使用，请私聊我获取敏感信息。',
    { reply_to_message_id: msg.message_id }
  );
}

function chatOptions(msg, extra = {}) {
  return { ...extra };
}

function clearKeyboardOptions(extra = {}) {
  return {
    ...extra,
    reply_markup: { remove_keyboard: true },
  };
}

function isAdminUser(user) {
  return !!(user && Number(user.is_admin) === 1);
}

function myInlineKeyboard(user) {
  const rows = [
    [{ text: '7天流量', callback_data: MY_ACTIONS.traffic }, { text: '节点状态', callback_data: MY_ACTIONS.nodes }],
    [{ text: '我的订阅', callback_data: MY_ACTIONS.sub }],
  ];
  if (isAdminUser(user)) {
    rows.push([{ text: '管理总览', callback_data: MY_ACTIONS.admin }]);
  }
  return { inline_keyboard: rows };
}

function getPanelUrl() {
  return `https://${DOMAIN}`;
}

function normalizeNodeName(name) {
  return String(name || '')
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
    .replace(/\ud83c\udfe0/g, '')
    .trim();
}

function sendWelcome(msg, bound = !!getUserByTgId(getActorId(msg))) {
  const user = bound ? getUserByTgId(getActorId(msg)) : null;
  const base = bound
    ? '欢迎使用面板机器人！\n\n请选择下方菜单：\n 签到\n 大转盘\n 翻卡\n 猜拳\n 我的\n 订阅'
    : '欢迎使用面板机器人！\n\n先完成绑定后即可使用签到、大转盘、翻卡、猜拳和订阅查询。';
  const hint = bound
    ? '\n\n 累计签到满 7 天可解锁家宽。\n 点击左下角菜单可直接使用签到、大转盘、翻卡、猜拳、我的、订阅。'
    : '\n\n 累计签到满 7 天可解锁家宽。\n 点击左下角菜单，或从面板点击 Telegram 图标完成绑定。';
  const adminHint = isAdminUser(user) ? '\n 你是管理员，点“我的”里可以看今日运营总览。' : '';
  return bot.sendMessage(msg.chat.id, `${base}${hint}${adminHint}`, clearKeyboardOptions());
}

function formatGb(gb) {
  const num = Number(gb || 0);
  return `${num > 0 ? '+' : ''}${num.toFixed(2)} GB`;
}

function getAdminDailyStats() {
  const d = db.getDb();
  const day = today();
  const week = weekKey();

  const checkin = d.prepare(`
    SELECT COUNT(DISTINCT user_id) as users, COALESCE(SUM(amount), 0) as bytes
    FROM tg_checkin
    WHERE date = ?
  `).get(day);
  const flip = d.prepare(`
    SELECT COUNT(DISTINCT user_id) as users, COUNT(*) as plays, COALESCE(SUM(amount_gb), 0) as net_gb
    FROM tg_flip_daily
    WHERE date = ?
  `).get(day);
  const rps = d.prepare(`
    SELECT COUNT(*) as users, COALESCE(SUM(plays), 0) as plays, COALESCE(SUM(net_gb), 0) as net_gb
    FROM tg_rps_daily
    WHERE date = ?
  `).get(day);
  const lucky = d.prepare(`
    SELECT COUNT(*) as users, COALESCE(SUM(amount), 0) as bytes
    FROM tg_lucky
    WHERE week = ?
  `).get(week);
  const bind = d.prepare('SELECT COUNT(*) as users FROM users WHERE telegram_id IS NOT NULL AND telegram_id != \'\'').get();

  return {
    day,
    week,
    checkinUsers: checkin?.users || 0,
    checkinBytes: checkin?.bytes || 0,
    flipUsers: flip?.users || 0,
    flipPlays: flip?.plays || 0,
    flipNetGb: flip?.net_gb || 0,
    rpsUsers: rps?.users || 0,
    rpsPlays: rps?.plays || 0,
    rpsNetGb: rps?.net_gb || 0,
    luckyUsers: lucky?.users || 0,
    luckyBytes: lucky?.bytes || 0,
    bindUsers: bind?.users || 0,
  };
}

function handleAdminStats(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);
  if (!isAdminUser(user)) return bot.sendMessage(msg.chat.id, '仅管理员可查看这个入口', chatOptions(msg));

  const stats = getAdminDailyStats();
  return bot.sendMessage(
    msg.chat.id,
    `<b>管理总览</b>\n 日期：${stats.day}\n\n TG 已绑定：${stats.bindUsers} 人\n\n 签到：${stats.checkinUsers} 人 · ${formatBytes(stats.checkinBytes)}\n 翻卡：${stats.flipUsers} 人 · ${stats.flipPlays} 次 · ${formatGb(stats.flipNetGb)}\n 猜拳：${stats.rpsUsers} 人 · ${stats.rpsPlays} 局 · ${formatGb(stats.rpsNetGb)}\n 本周大转盘：${stats.luckyUsers} 人 · ${formatBytes(stats.luckyBytes)}`,
    chatOptions(msg, { parse_mode: 'HTML' })
  );
}

function sendBindPrompt(msg) {
  const panelUrl = getPanelUrl();
  return bot.sendMessage(
    msg.chat.id,
    `请先绑定账号\n\n1. 登录面板：${panelUrl}\n2. 点击个人页里的 Telegram 图标\n3. 跳转机器人后完成绑定`,
    clearKeyboardOptions()
  );
}

function _tryUnfreezeAfterTraffic(userId) {
  const user = db.getUserById(userId);
  if (user && user.is_frozen && user.freeze_reason === 'traffic_limit' && !db.isTrafficExceeded(userId)) {
    db.unfreezeUser(userId);
    db.addAuditLog(null, 'traffic_limit_unfreeze', `签到/游戏增加流量后自动解冻: ${user.username}`, 'system');
    try { require('./configEvents').emitSyncAll(); } catch (_) {}
  }
}

// 签到时若用户因长期未签到被冻结，自动解冻
function _tryUnfreezeAfterCheckin(userId) {
  const user = db.getUserById(userId);
  if (user && user.is_frozen && user.freeze_reason === 'tg_inactive') {
    db.unfreezeUser(userId);
    db.addAuditLog(null, 'tg_inactive_unfreeze', `签到后自动解冻: ${user.username}`, 'system');
    try { require('./configEvents').emitSyncAll(); } catch (_) {}
  }
}

function runCheckin(userId, d, bytes) {
  const stmtInsert = db.getDb().prepare('INSERT OR IGNORE INTO tg_checkin (user_id, date, amount) VALUES (?, ?, ?)');
  const stmtUser = db.getDb().prepare('SELECT id, username, trust_level, traffic_limit FROM users WHERE id = ?');
  const stmtTraffic = db.getDb().prepare('UPDATE users SET traffic_limit = ? WHERE id = ?');
  const stmtCheckins = db.getDb().prepare('SELECT COUNT(*) as c FROM tg_checkin WHERE user_id = ?');
  const stmtSetGroup = db.getDb().prepare('UPDATE users SET trust_level = ? WHERE id = ?');
  const stmtAudit = db.getDb().prepare("INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, datetime('now'))");

  return db.getDb().transaction(() => {
    const user = stmtUser.get(userId);
    if (!user) return { ok: false, reason: 'missing_user' };
    const inserted = stmtInsert.run(userId, d, bytes);
    if (!inserted.changes) return { ok: false, reason: 'already_checked_in' };

    if (user.traffic_limit >= 0) {
      stmtTraffic.run(Math.max(0, user.traffic_limit + bytes), userId);
    }

    const totalCheckins = stmtCheckins.get(userId).c;
    const currentLevel = user.trust_level || 0;
    let newLevel = currentLevel;
    if (totalCheckins >= 30 && currentLevel < 3) newLevel = 3;
    else if (totalCheckins >= 15 && currentLevel < 2) newLevel = 2;
    else if (totalCheckins >= 7 && currentLevel < 1) newLevel = 1;

    if (newLevel > currentLevel) {
      const groupLabel = getGroupLabel(newLevel);
      stmtSetGroup.run(newLevel, userId);
      stmtAudit.run(userId, 'set_group', `累计签到${totalCheckins}天自动升级: ${groupLabel}`, 'tg_checkin');
    }

    return { ok: true, totalCheckins, currentLevel, newLevel };
  })();
}

function handleCheckin(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  const d = today();
  const totalCheckinsBefore = db.getDb().prepare('SELECT COUNT(*) as c FROM tg_checkin WHERE user_id = ?').get(user.id).c;
  const streakBefore = countCurrentStreak(user.id, d);
  const gb = CHECKIN_MIN_GB + Math.random() * (CHECKIN_MAX_GB - CHECKIN_MIN_GB);
  const gbRound = Math.round(gb * 100) / 100;
  const bytes = Math.round(gbRound * 1073741824);
  const result = runCheckin(user.id, d, bytes);
  if (result.ok) { _tryUnfreezeAfterCheckin(user.id); _tryUnfreezeAfterTraffic(user.id); }
  if (!result.ok) {
    const luckyDone = db.getDb().prepare('SELECT 1 FROM tg_lucky WHERE user_id = ? AND week = ?').get(user.id, weekKey());
    const nextAction = luckyDone
      ? '还可以去翻卡， 还可以去猜拳'
      : '还可以去翻卡， 还可以去猜拳， 本周还能转盘';
    return bot.sendMessage(
      msg.chat.id,
      `今天已经签到过了\n\n 连续签到：${streakBefore} 天\n 累计签到：${totalCheckinsBefore} 天\n 明天再来，继续把签到天数往上叠\n 累计满 7 天可解锁家宽\n${nextAction}`,
      chatOptions(msg)
    );
  }

  const updatedUser = db.getUserById(user.id);
  const traffic = db.getUserTraffic(user.id);
  const used = (traffic.total_up || 0) + (traffic.total_down || 0);
  const remaining = updatedUser.traffic_limit < 0 ? -1 : Math.max(0, updatedUser.traffic_limit - used);
  const streak = countCurrentStreak(user.id, d);
  const luckyDone = db.getDb().prepare('SELECT 1 FROM tg_lucky WHERE user_id = ? AND week = ?').get(user.id, weekKey());
  const upgradeMsg = result.newLevel > result.currentLevel ? `\n 用户组升级：${getGroupLabel(result.newLevel)}` : '';

  let progressLine = '';
  const effectiveLevel = result.newLevel > result.currentLevel ? result.newLevel : result.currentLevel;
  if (effectiveLevel < 1) progressLine = `再签到 ${Math.max(0, 7 - result.totalCheckins)} 天解锁家宽`;
  else if (effectiveLevel < 2) progressLine = `再签到 ${Math.max(0, 15 - result.totalCheckins)} 天升级到  SVIP`;
  else if (effectiveLevel < 3) progressLine = `再签到 ${Math.max(0, 30 - result.totalCheckins)} 天升级到  SSVIP`;
  else progressLine = '家宽资格已解锁';

  const nextAction = luckyDone
    ? '现在还能翻卡， 还能猜拳'
    : '现在还能翻卡， 还能猜拳， 本周还能转盘';

  return bot.sendMessage(
    msg.chat.id,
    `今日签到成功\n\n 获得流量：${gbRound.toFixed(2)} GB\n 连续签到：${streak} 天\n 累计签到：${result.totalCheckins} 天\n 剩余流量：${remaining < 0 ? '∞' : formatBytes(remaining)}${upgradeMsg}\n\n${progressLine}\n${nextAction}`,
    chatOptions(msg)
  );
}

function handleMe(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  const traffic = db.getUserTraffic(user.id);
  const used = (traffic.total_up || 0) + (traffic.total_down || 0);
  const limit = user.traffic_limit;
  const remaining = limit < 0 ? -1 : Math.max(0, limit - used);
  const status = user.is_frozen ? '已冻结' : user.is_blocked ? '已封禁' : '正常';
  const expiry = user.expires_at ? user.expires_at.slice(0, 10) : '永不过期';
  const group = getGroupLabel(user.trust_level);
  const totalCheckins = db.getDb().prepare('SELECT COUNT(*) as c FROM tg_checkin WHERE user_id = ?').get(user.id).c;
  const totalCheckinGB = db.getDb().prepare('SELECT COALESCE(SUM(amount), 0) as s FROM tg_checkin WHERE user_id = ?').get(user.id).s;
  const streak = countCurrentStreak(user.id, today());

  let nextGoal = '';
  const level = user.trust_level || 0;
  if (level < 1) nextGoal = `\n 累计签到满 7 天可解锁家宽\n 再签 ${Math.max(0, 7 - totalCheckins)} 天升  VIP`;
  else if (level < 2) nextGoal = `\n 再签 ${Math.max(0, 15 - totalCheckins)} 天升  SVIP`;
  else if (level < 3) nextGoal = `\n 再签 ${Math.max(0, 30 - totalCheckins)} 天升  SSVIP`;

  return bot.sendMessage(
    msg.chat.id,
    `<b>${user.username}</b>\n 用户组: ${group}\n\n 状态: ${status}\n 到期: ${expiry}\n\n 已用流量: ${formatBytes(used)}\n 剩余流量: ${remaining < 0 ? '∞' : formatBytes(remaining)}\n\n 累计签到: ${totalCheckins} 次 · 连续 ${streak} 天\n 签到获得: ${formatBytes(totalCheckinGB)}${nextGoal}`,
    chatOptions(msg, { parse_mode: 'HTML', reply_markup: myInlineKeyboard(user) })
  );
}

function handleLucky(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  return bot.sendMessage(
    msg.chat.id,
    '<b>每周大转盘</b>\n\n每周只有 1 次机会，指针停下的那一格就是本周奖励。\n最高可抽中 88GB。',
    chatOptions(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{
          text: '开始转盘',
          web_app: { url: `${getPanelUrl()}/lucky-wheel` },
        }]],
      },
    })
  );
}

function handleTraffic(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  const days = db.getUserTrafficDailyAgg(user.id, 7);
  if (!days || days.length === 0) return bot.sendMessage(msg.chat.id, '最近 7 天没有流量记录', chatOptions(msg));

  const maxBytes = Math.max(...days.map((d) => d.total_up + d.total_down), 1);
  const BAR_LEN = 12;
  const lines = days.map((d) => {
    const total = d.total_up + d.total_down;
    const len = Math.round((total / maxBytes) * BAR_LEN);
    const bar = '█'.repeat(len) + '░'.repeat(BAR_LEN - len);
    return `${d.date.slice(5)} ${bar} ${formatBytes(total)}`;
  });

  return bot.sendMessage(msg.chat.id, `<b>最近 7 天流量</b>\n\n<code>${lines.join('\n')}</code>`, chatOptions(msg, { parse_mode: 'HTML' }));
}

function handleNodes(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  const nodes = db.getAllNodes(true);
  if (!nodes.length) return bot.sendMessage(msg.chat.id, '暂无可用节点', chatOptions(msg));

  const vlessNodes = nodes.filter((n) => n.protocol === 'vless');
  const lines = vlessNodes.map((n) => {
    const status = n.is_active ? '在线' : '离线';
    const name = normalizeNodeName(n.name);
    return `${status} · ${name}`;
  });

  return bot.sendMessage(msg.chat.id, `<b>节点状态</b>\n\n${lines.join('\n')}`, chatOptions(msg, { parse_mode: 'HTML' }));
}

function handleSub(msg) {
  if (!isPrivateChat(msg)) return sendPrivateOnly(msg);
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  const token = user.sub_token;
  if (!token) return bot.sendMessage(msg.chat.id, '订阅令牌不存在，请联系管理员', chatOptions(msg));

  const { appendSignature } = require('../utils/subSignature');
  const base = getPanelUrl();
  const vlessUrl = appendSignature(`${base}/sub/${token}`, token, 'sub');
  const sub6Url = appendSignature(`${base}/sub6/${token}`, token, 'sub6');
  const hy2Url = appendSignature(`${base}/subhy2/${token}`, token, 'subhy2');
  const allUrl = appendSignature(`${base}/suball/${token}`, token, 'suball');

  // 仅当后台开启 IPv6 订阅可见时，才显示 IPv6 链接
  const showIpv6 = db.getSetting('sub_visible_ss') !== 'false';
  const ipv6Section = showIpv6 ? `\n\n IPv6: <code>${sub6Url}</code>` : '';

  return bot.sendMessage(
    msg.chat.id,
    `<b>订阅链接</b>\n\n 组合: <code>${allUrl}</code>\n\n VLESS: <code>${vlessUrl}</code>${ipv6Section}\n\n Hysteria2: <code>${hy2Url}</code>\n\n 请勿泄露，客户端会自动识别格式`,
    chatOptions(msg, { parse_mode: 'HTML' })
  );
}

function handleRps(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  return bot.sendMessage(
    msg.chat.id,
    '<b>猜拳赢流量</b>\n\n赢 +2GB · 平 0 · 输 -1GB\n点击下方按钮开始！',
    chatOptions(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{
          text: '开始猜拳',
          web_app: { url: `${getPanelUrl()}/rps-game` },
        }]],
      },
    })
  );
}

function handleFlip(msg) {
  const user = getUserByTgId(getActorId(msg));
  if (!user) return sendBindPrompt(msg);

  return bot.sendMessage(
    msg.chat.id,
    '<b>每日翻卡赢流量</b>\n\n每天 3 次机会，9 张卡任选 1 张翻开。\n可能翻出加流量，也可能只是谢谢参与。',
    chatOptions(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [[{
          text: '开始翻卡',
          web_app: { url: `${getPanelUrl()}/flip-game` },
        }]],
      },
    })
  );
}

// ─── 命令处理 ───

if (!TOKEN) {
  module.exports = {
    init() {},
    generateBindToken,
    getBotUsername,
    ensureBotUsername,
    _test: { today, weekKey, shiftIsoDate, countCurrentStreak, getTzDateParts },
  };
  return;
}

bot = new TelegramBot(TOKEN, {
  polling: process.env.WORKERS_RUNTIME ? false : {
    interval: 1000,
    autoStart: true,
    params: { timeout: 30 },
  },
});

// /start (含深度链接绑定)
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const param = (match[1] || '').trim();
  if (param.startsWith('bind_')) {
    // 深度链接绑定
    const token = param.slice(5);
    const tgId = String(msg.from.id);
    const existing = getUserByTgId(tgId);
    if (existing) return bot.sendMessage(msg.chat.id, `已绑定账号: ${existing.username}`, chatOptions(msg));
    const user = db.getDb().prepare('SELECT * FROM users WHERE tg_bind_token = ?').get(token);
    if (!user) return bot.sendMessage(msg.chat.id, '无效的绑定令牌，请从面板重新获取', chatOptions(msg));
    if (user.telegram_id) return bot.sendMessage(msg.chat.id, '该账号已绑定其他 Telegram', chatOptions(msg));
    db.getDb().prepare('UPDATE users SET telegram_id = ?, tg_bind_token = NULL WHERE id = ?').run(tgId, user.id);
    return bot.sendMessage(msg.chat.id, `绑定成功！\n账号: ${user.username}\n\n现在可以直接使用下方菜单开始签到、大转盘、翻卡和猜拳了。`, chatOptions(msg));
  }

  return sendWelcome(msg);
});

// /bind <token>
bot.onText(/\/bind(?:\s+(.+))?/, (msg, match) => {
  const tgId = String(msg.from.id);
  const existing = getUserByTgId(tgId);
  if (existing) return bot.sendMessage(msg.chat.id, `已绑定账号: ${existing.username}`, chatOptions(msg));

  const token = (match[1] || '').trim();
  if (!token) return sendBindPrompt(msg);

  const user = db.getDb().prepare('SELECT * FROM users WHERE tg_bind_token = ?').get(token);
  if (!user) return bot.sendMessage(msg.chat.id, '无效的绑定令牌', chatOptions(msg));
  if (user.telegram_id) return bot.sendMessage(msg.chat.id, '该账号已绑定其他 Telegram', chatOptions(msg));

  db.getDb().prepare('UPDATE users SET telegram_id = ?, tg_bind_token = NULL WHERE id = ?').run(tgId, user.id);
  return bot.sendMessage(msg.chat.id, `绑定成功！\n账号: ${user.username}`, chatOptions(msg));
});

// /checkin
bot.onText(/\/checkin/, (msg) => {
  return handleCheckin(msg);
});

// /me
bot.onText(/\/me/, (msg) => {
  return handleMe(msg);
});

bot.onText(/\/adminstats/, (msg) => {
  return handleAdminStats(msg);
});

// /lucky
bot.onText(/\/lucky/, (msg) => {
  return handleLucky(msg);
});

bot.onText(/\/flip/, (msg) => {
  return handleFlip(msg);
});

// /traffic
bot.onText(/\/traffic/, (msg) => {
  return handleTraffic(msg);
});

// /nodes
bot.onText(/\/nodes/, (msg) => {
  return handleNodes(msg);
});

// /sub
bot.onText(/\/sub/, (msg) => {
  return handleSub(msg);
});

// /rps 猜拳赢流量 (Web App)
bot.onText(/\/rps/, (msg) => {
  return handleRps(msg);
});

bot.on('message', (msg) => {
  const text = String(msg.text || '').replace(/^[\p{Extended_Pictographic}\uFE0F]+/u, '').trim();
  if (!text || text.startsWith('/')) return;

  if (text === MENU.checkin) return void handleCheckin(msg);
  if (text === MENU.lucky) return void handleLucky(msg);
  if (text === MENU.flip) return void handleFlip(msg);
  if (text === MENU.rps) return void handleRps(msg);
  if (text === MENU.me) return void handleMe(msg);
  if (text === MENU.sub) return void handleSub(msg);
  if (text === MENU.bind) return void sendBindPrompt(msg);
  if (text === MENU.help) return void sendWelcome(msg);
  if (text === MENU.support) {
    return void bot.sendMessage(msg.chat.id, `面板入口：${getPanelUrl()}`, chatOptions(msg));
  }
});

bot.on('callback_query', async (query) => {
  const msg = query.message ? { ...query.message, actor: query.from } : null;
  const data = query.data;
  if (!msg || !data) return;

  try {
    if (data === MY_ACTIONS.traffic) await handleTraffic(msg);
    else if (data === MY_ACTIONS.nodes) await handleNodes(msg);
    else if (data === MY_ACTIONS.sub) await handleSub(msg);
    else if (data === MY_ACTIONS.admin) await handleAdminStats(msg);
    await bot.answerCallbackQuery(query.id);
  } catch (err) {
    await bot.answerCallbackQuery(query.id, { text: '操作失败，请稍后重试' }).catch(() => {});
    logger.warn({ err: err.message, data }, 'TG callback failed');
  }
});

// 错误处理 — 遇到 429 限流时暂停 polling 等待恢复
bot.on('polling_error', (err) => {
  const msg = err.message || '';
  logger.error({ err: msg }, 'TG Bot polling error');
  if (msg.includes('429')) {
    const wait = parseInt(msg.match(/retry after (\d+)/)?.[1], 10) || 10;
    logger.warn({ wait }, 'TG 429 限流，暂停 polling');
    bot.stopPolling().then(() => {
      setTimeout(() => bot.startPolling(), wait * 1000);
    }).catch(() => {});
  }
});

function init() {
  bot.getMe().then((me) => {
    _botUsername = me.username;
    const commands = [
      { command: 'start', description: '打开机器人菜单' },
      { command: 'checkin', description: '每日签到领流量' },
      { command: 'lucky', description: '每周大转盘抽奖' },
      { command: 'flip', description: '每日翻卡赢流量' },
      { command: 'rps', description: '猜拳赢流量' },
      { command: 'me', description: '查看个人信息' },
      { command: 'sub', description: '获取订阅链接' },
      { command: 'adminstats', description: '管理员查看今日总览' },
    ];
    return Promise.all([
      bot.setMyCommands(commands),
      bot.setMyCommands(commands, { scope: { type: 'all_private_chats' } }),
      bot.setChatMenuButton({ menu_button: { type: 'commands' } }),
    ]);
  }).catch((err) => {
    logger.warn({ err: err.message }, 'TG menu setup failed');
  });
  logger.info('TG Bot 已启动');
}

function generateBindToken(userId) {
  const token = require('crypto').randomBytes(16).toString('hex');
  db.getDb().prepare('UPDATE users SET tg_bind_token = ? WHERE id = ?').run(token, userId);
  return token;
}

module.exports = {
  init,
  generateBindToken,
  getBotUsername,
  ensureBotUsername,
  processUpdate: update => bot.processUpdate(update),
  _test: { today, weekKey, shiftIsoDate, countCurrentStreak, getTzDateParts },
};
