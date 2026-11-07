const express = require('express');
const db = require('../services/database');
const { generateV2raySubForUser, generateClashSubForUser, generateSingboxSubForUser, generateV2raySsSub, generateClashSsSub, generateSingboxSsSub, generateV2rayHy2Sub, generateClashHy2Sub, generateSingboxHy2Sub, generateV2rayAllSub, generateClashAllSub, generateSingboxAllSub, detectClient } = require('../utils/vless');
const { requireAuth } = require('../middleware/auth');
const { subLimiter } = require('../middleware/rateLimit');
const QRCode = require('qrcode');
const { notify } = require('../services/notify');
const { getClientIp } = require('../utils/clientIp');
const { verifySignature } = require('../utils/subSignature');
const { createSubGuard } = require('../services/subGuard');
const logger = require('../services/logger');
const { emitSyncAll } = require('../services/configEvents');
const {
  getUserNodeUuidMap,
  buildSubUrl,
  readSubSignatureFromQuery,
  resolveSubUserIdByToken,
  logSubAccessEventSafe,
  canUserAccessNode,
} = require('../utils/routeHelpers');

const router = express.Router();

const _subCache = new Map();
const SUB_CACHE_TTL = 60000;
const SUB_CACHE_MAX_ENTRIES = 2000;
const _abuseCache = new Map();
const ABUSE_CACHE_TTL_MS = 3600000;
const ABUSE_CACHE_MAX_ENTRIES = 5000;

const DEFAULT_SUB_UA_ALLOWLIST = [
  'clash', 'clash-meta', 'mihomo', 'stash', 'sing-box', 'singbox',
  'sfa', 'sfi', 'v2rayn', 'v2rayng', 'v2raya', 'v2box',
  'shadowrocket', 'quantumult', 'surfboard', 'nekoray',
  'surge', 'loon', 'egern', 'exclave', 'passwall', 'throne',
];
let subGuard = buildSubGuard();

function buildSubGuard() {
  const s = key => db.getSetting(key);
  return createSubGuard({
    mode: s('guard_mode') ?? process.env.SUB_CLIENT_FILTER_MODE ?? 'off',
    uaAllowlist: s('guard_ua_allowlist') ?? process.env.SUB_UA_ALLOWLIST ?? '',
    defaultAllowlist: DEFAULT_SUB_UA_ALLOWLIST,
    tokenWindowMs: s('guard_token_window_ms') ?? process.env.SUB_TOKEN_WINDOW_MS ?? '60000',
    tokenMaxReq: s('guard_token_max_req') ?? process.env.SUB_TOKEN_MAX_REQ ?? '20',
    tokenBanMs: s('guard_token_ban_ms') ?? process.env.SUB_TOKEN_BAN_MS ?? '900000',
    behaviorWindowMs: s('guard_behavior_window_ms') ?? process.env.SUB_BEHAVIOR_WINDOW_MS ?? '120000',
    behaviorMaxIps: s('guard_behavior_max_ips') ?? process.env.SUB_BEHAVIOR_MAX_IPS ?? '6',
    behaviorMaxUas: s('guard_behavior_max_uas') ?? process.env.SUB_BEHAVIOR_MAX_UAS ?? '4',
  });
}

function reloadSubGuard() { subGuard = buildSubGuard(); }

function toInt(value, fallback = 0, min = 0, max = null) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  let out = n;
  if (out < min) out = min;
  if (max != null && out > max) out = max;
  return out;
}

function getAutoResetUa24hLimit() {
  return toInt(
    db.getSetting('guard_auto_reset_ua_24h_limit') ?? process.env.SUB_AUTO_RESET_UA_24H_LIMIT ?? '0',
    0,
    0,
    20
  );
}

function enforceUaAutoReset(user, ua, clientIP) {
  const limit = getAutoResetUa24hLimit();
  if (!user?.id || limit <= 0) return null;

  const uaCount = db.countDistinctSubAccessUas(user.id, 24);
  if (uaCount <= limit) return null;

  const oldTokenPrefix = String(user.sub_token || '').slice(0, 8) || '-';
  const newToken = db.resetSubToken(user.id);
  const rotatedUuidCount = db.rotateUserAllNodeUuids(user.id);
  db.clearSubAccessWindow(user.id, 24);
  db.addAuditLog(
    user.id,
    'sub_token_auto_reset_ua',
    `24h UA 超限自动重置订阅+UUID: ${user.username} ua=${uaCount} limit=${limit} old=${oldTokenPrefix} new=${String(newToken).slice(0, 8)} uuid=${rotatedUuidCount} ip=${clientIP}`,
    clientIP
  );
  try {
    notify.ops(`<b>订阅与 UUID 已自动重置</b>\n用户: ${user.username}\n原因: 24h 内 UA 数超限 (${uaCount}/${limit})\nUUID: ${rotatedUuidCount}\nIP: ${clientIP}`);
  } catch (_) {}
  try { emitSyncAll(); } catch (_) {}

  return {
    status: 403,
    reason: 'token_auto_reset_ua',
    message: `检测到 24 小时内出现超过 ${limit} 个不同客户端标识，订阅链接和节点凭据已自动重置，请到面板重新复制订阅地址。`,
    uaCount,
    limit,
    rotatedUuidCount,
  };
}

function setSubCache(cacheKey, value) {
  if (!_subCache.has(cacheKey) && _subCache.size >= SUB_CACHE_MAX_ENTRIES) {
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, entry] of _subCache) {
      const ts = Number(entry?.ts || 0);
      if (ts < oldestTs) {
        oldestTs = ts;
        oldestKey = key;
      }
    }
    if (oldestKey) _subCache.delete(oldestKey);
  }
  _subCache.set(cacheKey, value);
}

function cleanupAbuseCache(now = Date.now()) {
  for (const [k, ts] of _abuseCache) {
    if (now - ts > ABUSE_CACHE_TTL_MS) _abuseCache.delete(k);
  }
  if (_abuseCache.size <= ABUSE_CACHE_MAX_ENTRIES) return;
  const sorted = [..._abuseCache.entries()].sort((a, b) => a[1] - b[1]);
  const removeCount = _abuseCache.size - ABUSE_CACHE_MAX_ENTRIES;
  for (let i = 0; i < removeCount; i++) _abuseCache.delete(sorted[i][0]);
}

function applySubGuards(token, ua, clientIP) {
  const result = subGuard.apply(token, ua, clientIP);
  if (result.reason === 'unknown_ua_observe' && result.shouldLogUnknownUa) {
      db.addAuditLog(null, 'sub_unknown_ua', `未知客户端 UA: ${String(ua || '').slice(0, 180)} token:${token.slice(0, 8)} ip:${clientIP}`, clientIP);
  }
  return result;
}

router.get('/sub-qr', requireAuth, makeQrHandler('sub'));
router.get('/sub6-qr', requireAuth, makeQrHandler('sub6'));

function makeQrHandler(route) {
  return async (req, res) => {
    try {
      const subUrl = buildSubUrl(req, req.user.sub_token, route);
      const png = await QRCode.toBuffer(subUrl, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.send(png);
    } catch (e) {
      logger.error(`[二维码] ${route} 生成失败:`, e.message);
      res.status(500).send('二维码生成失败');
    }
  };
}

function handleSubscription(cfg) {
  return (req, res) => {
    const token = req.params.token;
    const ua = req.headers['user-agent'] || '';
    const clientIP = getClientIp(req);
    const clientType = req.query.type || detectClient(ua);
    const eventBase = { token, route: cfg.route, ip: clientIP, ua, clientType };

    // 签名校验
    const sig = readSubSignatureFromQuery(req);
    const sigGuard = verifySignature(token, sig, cfg.route);
    if (!sigGuard.ok) {
      logSubAccessEventSafe({ ...eventBase, userId: resolveSubUserIdByToken(token), result: 'deny', reason: sigGuard.reason || 'signature_invalid', httpStatus: sigGuard.status || 403 });
      return res.status(sigGuard.status).type('text').send(sigGuard.message);
    }
    if (sigGuard.shouldLog) db.addAuditLog(null, `${cfg.route}_sig_observe`, `签名异常已放行 token:${token.slice(0, 8)} ip:${clientIP}`, clientIP);

    // 空 UA 拦截
    if (!ua.trim()) {
      logSubAccessEventSafe({ ...eventBase, userId: resolveSubUserIdByToken(token), result: 'deny', reason: 'empty_ua', httpStatus: 403 });
      return res.status(403).type('text').send('User-Agent is required');
    }

    // SubGuard
    const cacheKey = `${cfg.cachePrefix}${token}:${clientType}`;
    const guard = applySubGuards(token, ua, clientIP);
    if (!guard.ok) {
      logSubAccessEventSafe({ ...eventBase, userId: resolveSubUserIdByToken(token), result: 'deny', reason: guard.reason || 'guard_blocked', httpStatus: guard.status || 429 });
      return res.status(guard.status).type('text').send(guard.message);
    }

    let allowReason = 'ok';
    if (sigGuard.reason && sigGuard.reason !== 'signature_ok' && sigGuard.reason !== 'signature_off') allowReason = sigGuard.reason;
    if (guard.reason && guard.reason !== 'ok') allowReason = guard.reason;

    // 缓存命中
    const cached = _subCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < SUB_CACHE_TTL) {
      const user = db.getUserBySubToken(token);
      if (user) {
        db.logSubAccess(user.id, clientIP, ua);
        logSubAccessEventSafe({ ...eventBase, userId: user.id, result: 'allow', reason: allowReason === 'ok' ? 'ok_cache' : `${allowReason}_cache`, httpStatus: 200 });
        res.set(cached.headers);
        return res.send(cached.body);
      }
      _subCache.delete(cacheKey);
    }

    // 用户查找
    const user = db.getUserBySubToken(token);
    if (!user) {
      logSubAccessEventSafe({ ...eventBase, result: 'deny', reason: 'invalid_token', httpStatus: 403 });
      return res.status(403).send('无效的订阅链接');
    }

    db.logSubAccess(user.id, clientIP, ua);

    const autoReset = enforceUaAutoReset(user, ua, clientIP);
    if (autoReset) {
      logSubAccessEventSafe({
        ...eventBase,
        userId: user.id,
        result: 'deny',
        reason: autoReset.reason,
        httpStatus: autoReset.status,
      });
      return res.status(autoReset.status).type('text').send(autoReset.message);
    }

    // 定期清理滥用缓存（每次请求顺带检查，避免长期不触发时内存泄漏）
    cleanupAbuseCache();

    // 滥用检测
    const ips = db.getSubAccessIPs(user.id, 24);
    if (ips.length >= 20) {
      const now = Date.now();
      const last = _abuseCache.get(user.id) || 0;
      if (now - last > 3600000) {
        _abuseCache.set(user.id, now);
        cleanupAbuseCache(now);
        notify.abuse(user.username, ips.length);
      }
    }

    // 节点筛选 + UUID 映射
    const rawNodes = db.getAllNodes(true).filter(n => cfg.nodeFilter(n) && canUserAccessNode(user, n));
    const uuidMap = getUserNodeUuidMap(user.id, rawNodes);
    const nodes = rawNodes.map(n => {
      const rate = n.traffic_rate ?? 1;
      const rateSuffix = rate === 1 ? '' : ` |${rate}x`;
      const mapped = { ...n, name: n.name + rateSuffix, [cfg.uuidField]: uuidMap.get(Number(n.id)) || '', _userId: user.id };
      // 组合订阅：hy2 节点也需要 userPassword
      if (cfg.route === 'suball' && n.protocol === 'hy2') mapped.userPassword = uuidMap.get(Number(n.id)) || '';
      return mapped;
    });

    // 流量计算
    const traffic = db.getUserTraffic(user.id);
    const trafficLimit = user.traffic_limit;
    const totalBytes = trafficLimit >= 0 ? trafficLimit : 1125899906842624;
    const exceeded = trafficLimit >= 0 && (traffic.total_up + traffic.total_down) >= trafficLimit;

    db.addAuditLog(user.id, cfg.auditAction, `${cfg.auditLabel} [${clientType}] IP: ${clientIP}`, clientIP);

    const finalNodes = exceeded ? [] : nodes;
    const subInfo = `upload=${traffic.total_up}; download=${traffic.total_down}; total=${totalBytes}; expire=0`;
    const finalAllowReason = allowReason === 'ok' ? (exceeded ? 'ok_exceeded' : 'ok') : `${allowReason}${exceeded ? '_exceeded' : ''}`;
    const panelName = encodeURIComponent('Pоrпнub' + cfg.panelSuffix);
    const trafficInfo = { upload: traffic.total_up, download: traffic.total_down, total: totalBytes };

    // 按 clientType 生成响应
    const gen = cfg.generators[clientType] || cfg.generators.default;
    const contentType = clientType === 'clash' ? 'text/yaml' : clientType === 'singbox' ? 'application/json' : 'text/plain';
    const headers = {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Content-Disposition': `attachment; filename*=UTF-8''${panelName}`,
      'Subscription-Userinfo': subInfo,
      'Cache-Control': 'no-cache',
      ...(clientType === 'clash' ? { 'Profile-Update-Interval': '6' } : {})
    };
    const body = gen(finalNodes, trafficInfo);
    setSubCache(cacheKey, { headers, body, ts: Date.now() });
    logSubAccessEventSafe({ ...eventBase, userId: user.id, result: 'allow', reason: finalAllowReason, httpStatus: 200 });
    res.set(headers);
    res.send(body);
  };
}

router.get('/sub/:token', subLimiter, handleSubscription({
  route: 'sub',
  cachePrefix: '',
  nodeFilter: n => n.protocol !== 'ss' && n.protocol !== 'hy2',
  uuidField: 'uuid',
  auditAction: 'sub_fetch',
  auditLabel: '订阅拉取',
  panelSuffix: '',
  generators: {
    clash: (nodes) => generateClashSubForUser(nodes),
    singbox: (nodes) => generateSingboxSubForUser(nodes),
    default: (nodes, info) => generateV2raySubForUser(nodes, info),
  }
}));

router.get('/sub6/:token', subLimiter, handleSubscription({
  route: 'sub6',
  cachePrefix: 'v6:',
  nodeFilter: n => n.ip_version === 6 && n.protocol === 'ss',
  uuidField: 'userPassword',
  auditAction: 'sub6_fetch',
  auditLabel: 'IPv6订阅拉取',
  panelSuffix: '-IPv6',
  generators: {
    clash: (nodes, info) => generateClashSsSub(nodes, info),
    singbox: (nodes, info) => generateSingboxSsSub(nodes, info),
    default: (nodes, info) => generateV2raySsSub(nodes, info),
  }
}));

router.get('/subhy2/:token', subLimiter, handleSubscription({
  route: 'subhy2',
  cachePrefix: 'hy2:',
  nodeFilter: n => n.protocol === 'hy2',
  uuidField: 'userPassword',
  auditAction: 'subhy2_fetch',
  auditLabel: 'Hy2订阅拉取',
  panelSuffix: '-Hy2',
  generators: {
    clash: (nodes) => generateClashHy2Sub(nodes),
    singbox: (nodes) => generateSingboxHy2Sub(nodes),
    default: (nodes, info) => generateV2rayHy2Sub(nodes, info),
  }
}));

router.get('/suball/:token', subLimiter, handleSubscription({
  route: 'suball',
  cachePrefix: 'all:',
  nodeFilter: n => n.protocol !== 'ss',
  uuidField: 'uuid',
  auditAction: 'suball_fetch',
  auditLabel: '组合订阅拉取',
  panelSuffix: '-All',
  generators: {
    clash: (nodes) => {
      const vless = nodes.filter(n => n.protocol !== 'hy2');
      const hy2 = nodes.filter(n => n.protocol === 'hy2');
      return generateClashAllSub(vless, hy2);
    },
    singbox: (nodes) => {
      const vless = nodes.filter(n => n.protocol !== 'hy2');
      const hy2 = nodes.filter(n => n.protocol === 'hy2');
      return generateSingboxAllSub(vless, hy2);
    },
    default: (nodes, info) => {
      const vless = nodes.filter(n => n.protocol !== 'hy2');
      const hy2 = nodes.filter(n => n.protocol === 'hy2');
      return generateV2rayAllSub(vless, hy2, info);
    },
  }
}));

router.get('/subhy2-qr', requireAuth, async (req, res) => {
  try {
    const subHy2Url = buildSubUrl(req, req.user.sub_token, 'subhy2');
    const png = await QRCode.toBuffer(subHy2Url, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.send(png);
  } catch (e) {
    logger.error('[二维码] Hy2生成失败:', e.message);
    res.status(500).send('二维码生成失败');
  }
});

router.get('/suball-qr', requireAuth, async (req, res) => {
  try {
    const url = buildSubUrl(req, req.user.sub_token, 'suball');
    const png = await QRCode.toBuffer(url, { width: 300, margin: 1, errorCorrectionLevel: 'M' });
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.send(png);
  } catch (e) {
    res.status(500).send('二维码生成失败');
  }
});

module.exports = router;
module.exports.reloadSubGuard = reloadSubGuard;
module.exports._test = {
  toInt,
  getAutoResetUa24hLimit,
  enforceUaAutoReset,
};
