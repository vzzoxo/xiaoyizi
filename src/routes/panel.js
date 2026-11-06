const express = require('express');
const db = require('../services/database');
const { buildVlessLink, buildSsLink, buildHy2Link } = require('../utils/vless');
const { formatBytes } = require('../utils/formatBytes');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { csrfProtection } = require('../middleware/csrf');
const logger = require('../services/logger');
const { toSqlUtc } = require('../utils/time');
const { formatDateTimeInTimeZone } = require('../utils/time');
const {
  getUserNodeUuidMap,
  buildSubUrl,
  canUserAccessNode,
} = require('../utils/routeHelpers');
const { getGroup, getGroupLabel, getGroupResetConfig } = require('../utils/userGroup');
const { getOnlineCache } = require('../services/health');

const router = express.Router();

function getNowShanghaiParts(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false
  });
  const p = Object.fromEntries(fmt.formatToParts(date).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
  return {
    year: parseInt(p.year), month: parseInt(p.month), day: parseInt(p.day),
    hour: parseInt(p.hour), minute: parseInt(p.minute), second: parseInt(p.second)
  };
}

function shanghaiToUtcMs(year, month, day, hour = 0, minute = 0, second = 0) {
  return Date.UTC(year, month - 1, day, hour - 8, minute, second);
}

function nextUuidResetAtMs(now = new Date()) {
  const n = getNowShanghaiParts(now);
  const today3 = shanghaiToUtcMs(n.year, n.month, n.day, 3, 0, 0);
  if (now.getTime() < today3) return today3;
  const t = new Date(shanghaiToUtcMs(n.year, n.month, n.day, 12, 0, 0));
  t.setUTCDate(t.getUTCDate() + 1);
  const y = getNowShanghaiParts(t);
  return shanghaiToUtcMs(y.year, y.month, y.day, 3, 0, 0);
}

function nextTokenResetAtMs(user, subDays, now = new Date()) {
  if (subDays <= 0) return -1;
  const last = user.last_token_reset;
  if (!last || last === '2000-01-01') {
    const n = getNowShanghaiParts(now);
    const todayMs = shanghaiToUtcMs(n.year, n.month, n.day, 3, 0, 0);
    let next = new Date(todayMs);
    next.setUTCDate(next.getUTCDate() + subDays);
    return next.getTime();
  }
  const [y,m,d] = String(last).split('-').map(v => parseInt(v));
  if (!y || !m || !d) return nextUuidResetAtMs(now);
  const last3 = shanghaiToUtcMs(y, m, d, 3, 0, 0);
  let next = new Date(last3);
  next.setUTCDate(next.getUTCDate() + subDays);
  while (next.getTime() < now.getTime()) {
    next.setUTCDate(next.getUTCDate() + subDays);
  }
  return next.getTime();
}

function nextUuidResetAtMsForGroup(user, uuidDays, now = new Date()) {
  if (uuidDays <= 0) return -1;
  if (uuidDays === 1) return nextUuidResetAtMs(now);
  const db = require('../services/database');
  const level = Math.min(Math.max(user.trust_level || 0, 0), 3);
  const lastDate = db.getSetting(`group_${level}_last_uuid_rotate`);
  if (!lastDate) {
    // 没有历史记录，从今天起算
    const n = getNowShanghaiParts(now);
    const todayMs = shanghaiToUtcMs(n.year, n.month, n.day, 3, 0, 0);
    let next = new Date(todayMs);
    next.setUTCDate(next.getUTCDate() + uuidDays);
    return next.getTime();
  }
  const [y,m,d] = String(lastDate).split('-').map(v => parseInt(v));
  if (!y || !m || !d) return nextUuidResetAtMs(now);
  const last3 = shanghaiToUtcMs(y, m, d, 3, 0, 0);
  let next = new Date(last3);
  next.setUTCDate(next.getUTCDate() + uuidDays);
  while (next.getTime() < now.getTime()) {
    next.setUTCDate(next.getUTCDate() + uuidDays);
  }
  return next.getTime();
}

router.get('/', requireAuth, (req, res) => {
  const user = req.user;

  const nodes = db.getAllNodes(true).filter((n) => canUserAccessNode(req.user, n));

  const traffic = db.getUserTraffic(user.id);
  const globalTraffic = db.getGlobalTraffic();
  const uuidMap = getUserNodeUuidMap(user.id, nodes);

  const userNodes = nodes.map(n => {
    const userUuid = uuidMap.get(Number(n.id)) || '';
    let link;
    if (n.protocol === 'hy2') link = buildHy2Link({ ...n, _userId: user.id }, userUuid);
    else if (n.protocol === 'ss') link = buildSsLink(n, userUuid);
    else link = buildVlessLink(n, userUuid);
    return { ...n, link };
  });

  // 每个节点当前在线人数（来自 health 模块的内存缓存）
  const nodeOnlineCount = new Map();
  try {
    const onlineCache = getOnlineCache();
    for (const r of (onlineCache.full?.nodes || [])) {
      nodeOnlineCount.set(r.nodeId, r.count || 0);
    }
  } catch (_) { /* 忽略 */ }

  const nodeAiTags = {};
  try {
    const d = db.getDb();
    const deployNodes = d.prepare("SELECT DISTINCT detail FROM audit_log WHERE action = 'deploy'").all();
    deployNodes.forEach(r => {
      const match = (r.detail || '').match(/节点.*?[:：]\s*(.+)/);
      if (match) nodeAiTags[match[1]] = nodeAiTags[match[1]] || [];
    });
    const sevenDaysAgo = toSqlUtc(new Date(Date.now() - 7 * 86400000));
    const swapNodes = d.prepare(`
      SELECT DISTINCT detail FROM audit_log
      WHERE action IN ('auto_swap_ip','swap_ip','ip_rotated') AND created_at > ?
    `).all(sevenDaysAgo);
    nodes.forEach(n => {
      const tags = [];
      const swapMatch = swapNodes.some(r => (r.detail || '').includes(n.name) || (r.detail || '').includes(n.host));
      if (swapMatch) tags.push('ai_swap');
      if (tags.length) nodeAiTags[n.id] = tags;
    });
  } catch (err) {
    logger.debug({ err, userId: user?.id }, '读取节点 AI 标签失败，已忽略');
  }

  const groupCfg = getGroupResetConfig(db);
  const gl = Math.min(Math.max(user.trust_level || 0, 0), 3);
  const myUuidDays = groupCfg[gl].uuid_days;
  const mySubDays = groupCfg[gl].sub_days;
  const inviteStatus = db.getInviteGenerateStatusByUser(user.id, !!user.is_admin);
  const canUseInviteFeature = gl >= 1;

  res.render('panel', {
    user, userNodes, traffic, globalTraffic, formatBytes,
    trafficLimit: user.traffic_limit,
    nodeAiTags,
    nodeOnlineCount,
    subUrl: buildSubUrl(req, user.sub_token, 'sub'),
    subUrl6: buildSubUrl(req, user.sub_token, 'sub6'),
    subHy2Url: buildSubUrl(req, user.sub_token, 'subhy2'),
    subAllUrl: buildSubUrl(req, user.sub_token, 'suball'),
    subVisibleVless: db.getSetting('sub_visible_vless') !== 'false',
    subVisibleSs: db.getSetting('sub_visible_ss') !== 'false',
    subVisibleHy2: db.getSetting('sub_visible_hy2') !== 'false',
    nextUuidResetAt: nextUuidResetAtMsForGroup(user, myUuidDays),
    nextSubResetAt: nextTokenResetAtMs(user, mySubDays),
    announcement: db.getSetting('announcement') || '',
    expiresAt: user.expires_at || null,
    userGroup: getGroup(user.trust_level),
    userGroupLabel: getGroupLabel(user.trust_level),
    tgBound: !!user.telegram_id,
    tgBotEnabled: !!process.env.TG_BOT_TOKEN,
    uuidResetLabel: myUuidDays > 0 ? `每${myUuidDays}天` : '不重置',
    subResetLabel: mySubDays > 0 ? `每${mySubDays}天` : '不重置',
    activeInvite: inviteStatus.activeInvite,
    nextInviteGenerateAt: inviteStatus.nextGenerateAt,
    canGenerateInvite: canUseInviteFeature && inviteStatus.canGenerate,
    canUseInviteFeature,
    inviteEnabled: db.getSetting('invite_registration_enabled') !== 'false',
    formatDateTimeInTimeZone,
  });
});

router.post('/api/tg-unbind', requireAuth, csrfProtection, (req, res) => {
  const user = db.getUserById(req.user.id);
  if (!user || !user.telegram_id) return res.json({ ok: false, error: '当前未绑定 Telegram' });
  db.getDb().prepare('UPDATE users SET telegram_id = NULL WHERE id = ?').run(user.id);
  res.json({ ok: true });
});

router.post('/api/tg-bind-token', requireAuth, csrfProtection, async (req, res) => {
  const { generateBindToken, ensureBotUsername } = require('../services/tgbot');
  const botUsername = await ensureBotUsername();
  if (!botUsername) return res.json({ ok: false, error: 'TG Bot 未配置' });
  const token = generateBindToken(req.user.id);
  res.json({ ok: true, url: `https://t.me/${botUsername}?start=bind_${token}`, command: `/bind ${token}` });
});

router.get('/monitor', requireAuth, requireAdmin, (req, res) => {
  res.render('monitor', { user: req.user, nonce: res.locals.nonce || '' });
});

module.exports = router;
