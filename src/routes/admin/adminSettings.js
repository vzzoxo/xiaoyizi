const express = require('express');
const db = require('../../services/database');
const { verifyConnection, sendMail } = require('../../services/mailer');
const { escapeHtml } = require('../../utils/escapeHtml');
const { dateKeyInTimeZone, formatDateTimeInTimeZone, parseDateInput, normalizeLegacyLocalSqlToUtc } = require('../../utils/time');
const { parseIntId } = require('../../utils/validators');
const { encrypt } = require('../../utils/crypto');

const router = express.Router();
const ADMIN_STATS_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.ADMIN_STATS_CACHE_TTL_MS || '5000', 10) || 5000);
const _adminStatsCache = new Map();

function getCachedAdminStats(key) {
  const cached = _adminStatsCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.ts >= ADMIN_STATS_CACHE_TTL_MS) {
    _adminStatsCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCachedAdminStats(key, payload) {
  _adminStatsCache.set(key, { ts: Date.now(), payload });
}

function resolveLastPatrol(d) {
  const settingRaw = db.getSetting('ops_last_patrol') || '';
  const fromSetting = normalizeLegacyLocalSqlToUtc(settingRaw);
  const row = d.prepare(`
    SELECT MAX(created_at) as last_patrol
    FROM audit_log
    WHERE action LIKE '%patrol%' OR action = 'health_check'
  `).get() || {};
  const fromAudit = normalizeLegacyLocalSqlToUtc(row.last_patrol || '');

  if (!fromSetting) return fromAudit;
  if (!fromAudit) return fromSetting;

  const tSetting = parseDateInput(fromSetting).getTime();
  const tAudit = parseDateInput(fromAudit).getTime();
  if (Number.isNaN(tSetting)) return fromAudit;
  if (Number.isNaN(tAudit)) return fromSetting;
  return tAudit > tSetting ? fromAudit : fromSetting;
}

// 日志
router.get('/logs', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const type = req.query.type || 'all';
  const limit = 50;
  const offset = (page - 1) * limit;
  const data = db.getAuditLogs(limit, offset, type);
  // 服务端转义 detail/action 防注入
  if (data.rows) {
    data.rows = data.rows.map(r => ({
      ...r,
      action: escapeHtml(r.action),
      detail: escapeHtml(r.detail),
      username: escapeHtml(r.username),
      created_at_display: formatDateTimeInTimeZone(r.created_at, 'Asia/Shanghai'),
    }));
  }
  const pages = Math.max(1, Math.ceil((data.total || 0) / limit));
  res.json({ ...data, page, limit, pages });
});

router.post('/logs/clear', (req, res) => {
  db.clearAuditLogs();
  db.addAuditLog(req.user.id, 'logs_clear', '清空日志', req.clientIp || req.ip);
  res.json({ ok: true });
});

// 通知
router.post('/notify/config', (req, res) => {
  const { token, chatId } = req.body;
  if (token) db.setSetting('tg_bot_token', token);
  if (chatId) db.setSetting('tg_chat_id', chatId);
  res.json({ ok: true });
});

router.post('/notify/test', async (req, res) => {
  try {
    const { send } = require('../../services/notify');
    await send('测试通知 - 来自Pоrпнub 后台');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

router.post('/smtp/config', (req, res) => {
  try {
    const enabled = req.body?.enabled === true || req.body?.enabled === 'true';
    const secure = req.body?.secure === true || req.body?.secure === 'true';
    const host = String(req.body?.host || '').trim();
    const user = String(req.body?.user || '').trim();
    const fromName = String(req.body?.fromName || 'VLESS Panel').trim().slice(0, 64);
    const fromEmail = String(req.body?.fromEmail || '').trim();
    const port = parseInt(req.body?.port, 10) || 587;
    const pass = String(req.body?.pass || '');

    if (enabled) {
      if (!host) return res.status(400).json({ ok: false, error: 'SMTP host 不能为空' });
      if (!user) return res.status(400).json({ ok: false, error: 'SMTP 用户名不能为空' });
      if (!fromEmail) return res.status(400).json({ ok: false, error: '发件邮箱不能为空' });
      if (!(port >= 1 && port <= 65535)) return res.status(400).json({ ok: false, error: 'SMTP 端口不合法' });
    }

    db.setSetting('smtp_enabled', enabled ? 'true' : 'false');
    db.setSetting('smtp_host', host);
    db.setSetting('smtp_port', String(port));
    db.setSetting('smtp_secure', secure ? 'true' : 'false');
    db.setSetting('smtp_user', user);
    db.setSetting('smtp_from_name', fromName);
    db.setSetting('smtp_from_email', fromEmail);
    if (pass) db.setSetting('smtp_pass', encrypt(pass));
    db.addAuditLog(req.user.id, 'smtp_config_update', '更新 SMTP 配置', req.clientIp || req.ip);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: '保存 SMTP 配置失败' });
  }
});

router.post('/smtp/test', async (req, res) => {
  try {
    const to = String(req.body?.to || '').trim();
    if (!to) return res.status(400).json({ ok: false, error: '请输入测试收件邮箱' });
    await verifyConnection();
    await sendMail({
      to,
      subject: 'SMTP 测试邮件',
      text: '这是一封来自 VLESS Panel 的 SMTP 测试邮件。',
    });
    db.addAuditLog(req.user.id, 'smtp_test_send', `发送 SMTP 测试邮件到 ${to}`, req.clientIp || req.ip);
    return res.json({ ok: true });
  } catch (err) {
    return res.json({ ok: false, error: err.message || '测试发送失败' });
  }
});

router.post('/notify/event', (req, res) => {
  const { key, enabled } = req.body;
  const allowedEvents = [
    'tg_on_node_down', 'tg_on_node_blocked', 'tg_on_rotate',
    'tg_on_abuse', 'tg_on_traffic', 'tg_on_register', 'tg_on_deploy',
    'tg_on_ops',
  ];
  if (key && allowedEvents.includes(key)) {
    db.setSetting(key, enabled ? 'true' : 'false');
  }
  res.json({ ok: true });
});

// 公告 & 限制
router.post('/announcement', (req, res) => {
  db.setSetting('announcement', req.body.text || '');
  res.json({ ok: true });
});

router.post('/max-users', (req, res) => {
  db.setSetting('max_users', String(parseInt(req.body.max) || 0));
  res.json({ ok: true });
});

// 注册开关
router.post('/registration-open', (req, res) => {
  const open = req.body.open === true || req.body.open === 'true';
  db.setSetting('registration_open', open ? 'true' : 'false');
  db.addAuditLog(req.user.id, 'registration_toggle', open ? '开放注册' : '关闭注册', req.clientIp || req.ip);
  res.json({ ok: true, open });
});

router.post('/invite-registration-open', (req, res) => {
  const open = req.body.open === true || req.body.open === 'true';
  db.setSetting('invite_registration_enabled', open ? 'true' : 'false');
  db.addAuditLog(req.user.id, 'invite_registration_toggle', open ? '开放邀请码注册' : '关闭邀请码注册', req.clientIp || req.ip);
  res.json({ ok: true, open });
});

// 允许注册的邮箱后缀
router.post('/allowed-email-domains', (req, res) => {
  const raw = String(req.body.domains || '').trim();
  const domains = raw.split(/[,，\s]+/).map(d => d.replace(/^@/, '').trim().toLowerCase()).filter(Boolean).join(',');
  db.setSetting('allowed_email_domains', domains);
  db.addAuditLog(req.user.id, 'allowed_email_domains', domains || '不限制', req.clientIp || req.ip);
  res.json({ ok: true });
});

// 订阅访问
router.get('/sub-access/:userId', (req, res) => {
  const userId = parseIntId(req.params.userId);
  if (!userId) return res.status(400).json({ error: '参数错误' });
  const hours = parseInt(req.query.hours) || 24;
  const rows = db.getSubAccessIPs(userId, hours).map((r) => ({
    ...r,
    last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
  }));
  res.json(rows);
});

// 订阅统计
router.get('/sub-stats', (req, res) => {
  const hours = parseInt(req.query.hours) || 24;
  const page = parseInt(req.query.page) || 1;
  const sortRaw = String(req.query.sort || 'request');
  const onlyHigh = req.query.high === '1';
  const cacheKey = `sub-stats:${hours}:${page}:${sortRaw}:${onlyHigh ? 1 : 0}`;
  const cached = getCachedAdminStats(cacheKey);
  if (cached) return res.json(cached);
  const limit = 20;
  const offset = (page - 1) * limit;
  const sortMap = {
    count: 'request',
    request: 'request',
    success: 'success',
    deny: 'deny',
    ip: 'ip',
    ua: 'ua',
    last: 'last',
    ok_rate: 'ok_rate',
  };
  const sort = sortMap[sortRaw] || 'request';

  const data = db.getSubAccessStatsV2(hours, limit, offset, onlyHigh, sort);
  const hasV2Data = (data.total || 0) > 0;
  if (hasV2Data && Array.isArray(data.data)) {
    data.data = data.data.map((r) => ({
      ...r,
      last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
      source: 'event',
    }));
  }

  if (hasV2Data) {
    const pages = Math.max(1, Math.ceil((data.total || 0) / limit));
    const payload = { ...data, page, limit, pages, source: 'event' };
    setCachedAdminStats(cacheKey, payload);
    return res.json(payload);
  }

  // 兼容旧数据：若新事件表暂无数据，回退到 sub_access_log 统计
  const legacySort = sortRaw === 'ip' ? 'ip' : (sortRaw === 'last' ? 'last' : 'count');
  const legacy = db.getSubAccessStats(hours, limit, offset, onlyHigh, legacySort);
  if (Array.isArray(legacy.data)) {
    legacy.data = legacy.data.map((r) => ({
      ...r,
      request_count: r.pull_count || 0,
      ok_count: r.pull_count || 0,
      deny_count: 0,
      ok_rate: r.pull_count > 0 ? 100 : 0,
      deny_rate: 0,
      deny_ratio: 0,
      ua_count: 0,
      top_deny_reason: '',
      source: 'legacy',
      last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
    }));
  }
  const pages = Math.max(1, Math.ceil((legacy.total || 0) / limit));
  const legacyTotalRequests = (legacy.data || []).reduce((s, x) => s + Number(x.request_count || 0), 0);
  const payload = {
    ...legacy,
    page,
    limit,
    pages,
    source: 'legacy',
    overview: {
      total_requests: legacyTotalRequests,
      allow_requests: legacyTotalRequests,
      deny_requests: 0,
      allow_rate: legacyTotalRequests > 0 ? 100 : 0,
      deny_rate: 0,
      user_count: Number(legacy.total || 0),
      denied_user_count: 0,
      deny_reasons: [],
    },
  };
  setCachedAdminStats(cacheKey, payload);
  return res.json(payload);
});

router.get('/sub-stats/:userId/detail', (req, res) => {
  const userId = parseIntId(req.params.userId);
  if (!userId) return res.status(400).json({ error: '参数错误' });
  const hours = parseInt(req.query.hours) || 24;
  const cacheKey = `sub-stats-detail:${userId}:${hours}`;
  const cached = getCachedAdminStats(cacheKey);
  if (cached) return res.json(cached);
  const detail = db.getSubAccessUserDetailV2(userId, hours);
  const hasV2Data = Number(detail?.summary?.request_count || 0) > 0;
  if (hasV2Data) {
    const payload = {
      ...detail,
      source: 'event',
      summary: {
        ...detail.summary,
        last_access_display: formatDateTimeInTimeZone(detail.summary?.last_access, 'Asia/Shanghai'),
      },
      ips: (detail.ips || []).map((r) => ({
        ...r,
        last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
      })),
      reasons: (detail.reasons || []).map((r) => ({
        ...r,
        last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
      })),
      timeline: (detail.timeline || []).map((r) => ({
        ...r,
        time_display: formatDateTimeInTimeZone(r.time, 'Asia/Shanghai'),
      })),
    };
    setCachedAdminStats(cacheKey, payload);
    return res.json(payload);
  }

  // 兼容旧数据
  const legacy = db.getSubAccessUserDetail(userId, hours);
  const legacyReqCount = (legacy.ips || []).reduce((sum, r) => sum + Number(r.count || 0), 0);
  const legacyLastAccess = legacy.timeline?.[0]?.time || legacy.ips?.[0]?.last_access || null;
  const payload = {
    source: 'legacy',
    summary: {
      request_count: legacyReqCount,
      ok_count: legacyReqCount,
      deny_count: 0,
      ok_rate: legacyReqCount > 0 ? 100 : 0,
      deny_rate: 0,
      ip_count: (legacy.ips || []).length,
      ua_count: (legacy.uas || []).length,
      risk_level: 'low',
      last_access: legacyLastAccess,
      last_access_display: formatDateTimeInTimeZone(legacyLastAccess, 'Asia/Shanghai'),
    },
    ips: (legacy.ips || []).map((r) => ({
      ...r,
      ok_count: r.count || 0,
      deny_count: 0,
      last_access_display: formatDateTimeInTimeZone(r.last_access, 'Asia/Shanghai'),
    })),
    uas: (legacy.uas || []).map((r) => ({
      ...r,
      ok_count: r.count || 0,
      deny_count: 0,
    })),
    reasons: [],
    routes: [],
    timeline: (legacy.timeline || []).map((r) => ({
      ...r,
      route: String(r.ua || '').toLowerCase().includes('clash') ? 'sub' : 'sub',
      result: 'allow',
      reason: 'legacy_ok',
      http_status: 200,
      client_type: '',
      time_display: formatDateTimeInTimeZone(r.time, 'Asia/Shanghai'),
    })),
  };
  setCachedAdminStats(cacheKey, payload);
  return res.json(payload);
});

// 并发多节点观察（安全中心）
router.get('/security/multi-node-observe', (req, res) => {
  const hours = Math.max(1, parseInt(req.query.hours, 10) || 24);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = 20;
  const offset = (page - 1) * limit;
  const overview = db.getUserMultiNodeObserveOverview(hours) || {};
  const rowsData = db.getUserMultiNodeObserveEvents(hours, limit, offset) || { total: 0, rows: [] };
  const total = Number(rowsData.total || 0);
  const parsed = (rowsData.rows || []).map((r) => {
    const nodeCount = Number(r.node_count || 0);
    const nodes = String(r.nodes_sample || '').split(',').map((x) => x.trim()).filter(Boolean);
    const riskLevel = nodeCount >= 4 ? 'high' : 'mid';
    const totalTrafficBytes = Number(r.total_traffic_bytes || 0);
    const totalTrafficMb = (totalTrafficBytes / 1048576).toFixed(1);
    return {
      id: r.id,
      time: r.created_at,
      time_display: formatDateTimeInTimeZone(r.created_at, 'Asia/Shanghai', true),
      detail: `用户#${r.user_id} user=${r.username || '-'} window=${r.window_seconds || 0}s nodes=${nodeCount} traffic=${totalTrafficMb}MB sample=[${String(r.nodes_sample || '')}]`,
      user_id: Number(r.user_id || 0) || null,
      username: r.username || '',
      node_count: nodeCount,
      nodes,
      risk_level: riskLevel,
      window_seconds: Number(r.window_seconds || 0),
      total_traffic_bytes: totalTrafficBytes,
      total_traffic_mb: totalTrafficMb,
    };
  });
  const pages = Math.max(1, Math.ceil(total / limit));

  res.json({
    data: parsed,
    total,
    page,
    limit,
    pages,
    overview: {
      total_events: Number(overview.total_events || 0),
      user_count: Number(overview.user_count || 0),
      avg_node_count: Number(overview.avg_node_count || 0),
      high_count: Number(overview.high_count || 0),
      mid_count: Number(overview.mid_count || 0),
      low_count: 0,
      avg_traffic_bytes: Number(overview.avg_traffic_bytes || 0),
      max_traffic_bytes: Number(overview.max_traffic_bytes || 0),
    },
  });
});

// AI 运营日记
router.get('/diary', (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 20;
  const offset = (page - 1) * limit;
  const data = db.getDiaryEntries(limit, offset);
  const stats = db.getDiaryStats();
  const pages = Math.max(1, Math.ceil((data.total || 0) / limit));
  const rows = (data.rows || []).map((entry) => {
    const dt = formatDateTimeInTimeZone(entry.created_at, 'Asia/Shanghai');
    const [date = '', time = ''] = dt.split(' ');
    const weekday = entry.created_at
      ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', weekday: 'short' }).format(parseDateInput(entry.created_at))
      : '';
    return {
      ...entry,
      created_at_display: dt,
      created_date_display: date,
      created_time_display: time,
      created_weekday_display: weekday,
    };
  });
  res.json({
    ...data,
    rows,
    page,
    limit,
    pages,
    stats: {
      ...stats,
      firstEntryDisplay: formatDateTimeInTimeZone(stats.firstEntry, 'Asia/Shanghai'),
    },
  });
});

// AI 运维配置
router.get('/ops-config', (req, res) => {
  const keys = ['ops_target_nodes', 'ops_patrol_interval', 'ops_max_daily_swaps', 'ops_max_daily_creates',
    'ops_auto_swap_ip', 'ops_auto_repair', 'ops_auto_scale', 'ops_panel_guard'];
  const cfg = {};
  for (const k of keys) cfg[k] = db.getSetting(k) || '';
  res.json(cfg);
});

router.post('/ops-config', (req, res) => {
  try {
    const validators = {
      ops_target_nodes: v => typeof v === 'string' && v.length <= 500 ? v : null,
      ops_patrol_interval: v => { const n = parseInt(v, 10); return n >= 1 && n <= 1440 ? String(n) : null; },
      ops_max_daily_swaps: v => { const n = parseInt(v, 10); return n >= 0 && n <= 100 ? String(n) : null; },
      ops_max_daily_creates: v => { const n = parseInt(v, 10); return n >= 0 && n <= 50 ? String(n) : null; },
      ops_auto_swap_ip: v => v === 'true' || v === 'false' ? v : null,
      ops_auto_repair: v => v === 'true' || v === 'false' ? v : null,
      ops_auto_scale: v => v === 'true' || v === 'false' ? v : null,
      ops_panel_guard: v => v === 'true' || v === 'false' ? v : null,
    };
    for (const [k, v] of Object.entries(req.body)) {
      const validate = validators[k];
      if (!validate) continue;
      const safe = validate(String(v));
      if (safe !== null) db.setSetting(k, safe);
    }
    db.addAuditLog(req.user.id, 'ops_config', '更新 AI 运维配置', req.clientIp || req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// 运维仪表盘 API
router.get('/ops-dashboard', (req, res) => {
  const d = db.getDb();
  const nodes = db.getAllNodes();
  const total = nodes.length;
  const online = nodes.filter(n => n.is_active === 1 && n.fail_count === 0).length;
  const blocked = nodes.filter(n => n.fail_count >= 3).length;
  const offline = total - online - blocked;

  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const lastPatrol = resolveLastPatrol(d);

  const todayStats = d.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE action LIKE '%patrol%' OR action = 'health_check') as patrols,
      COUNT(*) FILTER (WHERE action IN ('auto_swap_ip', 'swap_ip', 'ip_rotated')) as swaps,
      COUNT(*) FILTER (WHERE action IN ('auto_repair', 'node_recovered')) as fixes
    FROM audit_log WHERE date(created_at, '+8 hours') = ?
  `).get(today) || { patrols: 0, swaps: 0, fixes: 0 };

  res.json({
    total,
    online,
    offline,
    blocked,
    lastPatrol,
    lastPatrolDisplay: formatDateTimeInTimeZone(lastPatrol, 'Asia/Shanghai'),
    todayStats,
  });
});

router.get('/ops-events', (req, res) => {
  const d = db.getDb();
  const limit = Math.min(parseInt(req.query.limit) || 30, 100);
  // 合并 audit_log 运维事件 + ops_diagnosis 诊断记录
  const auditEvents = d.prepare(`
    SELECT id, action, detail, created_at, 'audit' as source FROM audit_log
    WHERE action IN ('node_blocked','auto_swap_ip','auto_swap_ip_start','auto_swap_ip_ok','auto_swap_ip_fail',
      'swap_ip','ip_rotated','node_recovered','deploy','health_check','auto_repair','ops_config',
      'node_create','node_delete','patrol','instance_create','instance_terminate','xray_restart',
      'node_xray_down','node_auto_remove_manual','traffic_exceed')
    ORDER BY created_at DESC LIMIT ?
  `).all(limit);
  const diagEvents = d.prepare(`
    SELECT d.id, d.status, d.diag_info, d.ai_analysis, d.created_at, d.resolved_at,
           n.name as node_name, 'diagnosis' as source
    FROM ops_diagnosis d LEFT JOIN nodes n ON d.node_id = n.id
    ORDER BY d.created_at DESC LIMIT ?
  `).all(limit);
  const toSortTs = (value) => {
    const t = parseDateInput(value).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  // 合并并按时间排序
  const merged = [
    ...auditEvents.map((e) => {
      const createdAt = normalizeLegacyLocalSqlToUtc(e.created_at);
      return {
        ...e,
        created_at: createdAt,
        action: escapeHtml(e.action),
        detail: escapeHtml(e.detail),
        type: 'event',
      };
    }),
    ...diagEvents.map(e => ({
      id: 'diag-' + e.id,
      action: 'diagnosis_' + e.status,
      detail: escapeHtml(`${e.node_name || '未知节点'}: ${e.diag_info || ''}${e.ai_analysis ? ' → ' + e.ai_analysis : ''}`),
      created_at: normalizeLegacyLocalSqlToUtc(e.created_at),
      source: 'diagnosis',
      type: 'diagnosis'
    }))
  ].map((e) => ({ ...e, _sortTs: toSortTs(e.created_at) }))
    .sort((a, b) => b._sortTs - a._sortTs)
    .slice(0, limit)
    .map((e) => {
      const { _sortTs, ...rest } = e;
      return {
        ...rest,
        created_at_display: formatDateTimeInTimeZone(rest.created_at, 'Asia/Shanghai', true),
      };
    });
  res.json(merged);
});

router.get('/ops-diagnoses', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  res.json(db.getAllDiagnoses(limit));
});

// 自动化运维配置
router.get('/automation-config', (req, res) => {
  const keys = [
    'auto_restart_xray', 'auto_restart_max',
    'resource_alert_disk', 'resource_alert_mem', 'resource_alert_load', 'resource_alert_cooldown',
    'traffic_exceed_action', 'traffic_exceed_threshold_gb', 'traffic_exceed_hard_limit_gb',
    'auto_freeze_no_checkin_enabled', 'auto_freeze_no_checkin_days',
    'auto_freeze_traffic_enabled',
    'traffic_alert_enabled', 'traffic_alert_threshold_gb',
  ];
  const cfg = {};
  for (const k of keys) cfg[k] = db.getSetting(k) || '';
  // OPS API Key 只显示前 8 位
  const opsKey = process.env.OPS_API_KEY || '';
  cfg.ops_api_key_preview = opsKey ? opsKey.slice(0, 8) + '...' : '未配置';
  cfg.ops_api_key_configured = !!opsKey;
  res.json(cfg);
});

router.post('/automation-config', (req, res) => {
  try {
    const validators = {
      auto_restart_xray: v => v === 'true' || v === 'false' ? v : null,
      auto_restart_max: v => { const n = parseInt(v, 10); return n >= 0 && n <= 10 ? String(n) : null; },
      resource_alert_disk: v => { const n = parseFloat(v); return n >= 0 && n <= 100 ? String(n) : null; },
      resource_alert_mem: v => { const n = parseFloat(v); return n >= 0 && n <= 100 ? String(n) : null; },
      resource_alert_load: v => { const n = parseFloat(v); return n >= 0 && n <= 100 ? String(n) : null; },
      resource_alert_cooldown: v => { const n = parseInt(v, 10); return n >= 1 && n <= 1440 ? String(n) : null; },
      traffic_exceed_action: v => v === 'notify' || v === 'freeze' ? v : null,
      traffic_exceed_threshold_gb: v => { const n = parseFloat(v); return n >= 1 && n <= 10000 ? String(n) : null; },
      traffic_exceed_hard_limit_gb: v => { const n = parseFloat(v); return n >= 1 && n <= 10000 ? String(n) : null; },
      auto_freeze_no_checkin_enabled: v => v === 'true' || v === 'false' ? v : null,
      auto_freeze_no_checkin_days: v => { const n = parseInt(v, 10); return n >= 1 && n <= 365 ? String(n) : null; },
      auto_freeze_traffic_enabled: v => v === 'true' || v === 'false' ? v : null,
      traffic_alert_enabled: v => v === 'true' || v === 'false' ? v : null,
      traffic_alert_threshold_gb: v => { const n = parseFloat(v); return n >= 1 && n <= 10000 ? String(n) : null; },
    };
    for (const [k, v] of Object.entries(req.body)) {
      const validate = validators[k];
      if (!validate) continue;
      const safe = validate(String(v));
      if (safe !== null) db.setSetting(k, safe);
    }
    db.addAuditLog(req.user.id, 'automation_config', '更新自动化运维配置', req.clientIp || req.ip);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// Agent 批量更新（管理面板入口）
router.post('/agents/update-all', async (req, res) => {
  try {
    const agentWs = require('../../services/agent-ws');
    const agents = agentWs.getConnectedAgents();
    if (agents.length === 0) {
      return res.json({ ok: true, total: 0, successCount: 0, results: [] });
    }
    const results = [];
    for (const agent of agents) {
      try {
        const result = await agentWs.sendCommand(agent.nodeId, { type: 'self_update' });
        results.push({ nodeId: agent.nodeId, nodeName: agent.nodeName, ...result });
      } catch (err) {
        results.push({ nodeId: agent.nodeId, nodeName: agent.nodeName, success: false, error: 'Command failed' });
      }
    }
    const successCount = results.filter(r => r.success).length;
    db.addAuditLog(req.user.id, 'agent_update_all', `批量更新 Agent: ${successCount}/${agents.length} 成功`, req.clientIp || req.ip);
    res.json({ ok: true, total: agents.length, successCount, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Internal server error' });
  }
});

// 用户组重置周期配置
router.get('/group-reset-config', (req, res) => {
  const defaults = [[1,7],[1,15],[1,0],[0,0]];
  const cfg = [];
  for (let i = 0; i <= 3; i++) {
    const uRaw = parseInt(db.getSetting(`group_${i}_uuid_days`));
    const sRaw = parseInt(db.getSetting(`group_${i}_sub_days`));
    cfg.push({
      level: i,
      uuid_days: Number.isFinite(uRaw) ? uRaw : defaults[i][0],
      sub_days: Number.isFinite(sRaw) ? sRaw : defaults[i][1],
    });
  }
  const portRaw = parseInt(db.getSetting('port_rotate_days'));
  const port_rotate_days = Number.isFinite(portRaw) ? portRaw : 1;
  res.json({ ok: true, groups: cfg, port_rotate_days });
});

router.post('/group-reset-config', (req, res) => {
  const { groups, port_rotate_days } = req.body;
  if (!Array.isArray(groups) || groups.length !== 4) return res.status(400).json({ error: '参数错误' });
  for (let i = 0; i <= 3; i++) {
    const g = groups[i];
    const uuid = Math.max(0, Math.min(365, parseInt(g.uuid_days) || 0));
    const sub = Math.max(0, Math.min(365, parseInt(g.sub_days) || 0));
    db.setSetting(`group_${i}_uuid_days`, String(uuid));
    db.setSetting(`group_${i}_sub_days`, String(sub));
  }
  if (port_rotate_days !== undefined) {
    const pd = Math.max(0, Math.min(365, parseInt(port_rotate_days) || 0));
    db.setSetting('port_rotate_days', String(pd));
  }
  db.addAuditLog(req.user.id, 'group_reset_config', '更新用户组重置周期配置', req.clientIp || req.ip);
  res.json({ ok: true });
});

// 风控配置
const GUARD_KEYS = [
  { key: 'guard_mode', default: 'off' },
  { key: 'guard_token_window_ms', default: '60000' },
  { key: 'guard_token_max_req', default: '20' },
  { key: 'guard_token_ban_ms', default: '900000' },
  { key: 'guard_behavior_window_ms', default: '120000' },
  { key: 'guard_behavior_max_ips', default: '6' },
  { key: 'guard_behavior_max_uas', default: '4' },
  { key: 'guard_auto_reset_ua_24h_limit', default: '0' },
  { key: 'guard_ua_allowlist', default: '' },
];

router.get('/guard-config', (req, res) => {
  const cfg = {};
  for (const g of GUARD_KEYS) cfg[g.key] = db.getSetting(g.key) ?? g.default;
  res.json({ ok: true, config: cfg });
});

router.post('/guard-config', (req, res) => {
  const { config } = req.body;
  if (!config || typeof config !== 'object') return res.status(400).json({ error: '参数错误' });
  const allowed = ['off', 'observe', 'enforce'];
  if (config.guard_mode && !allowed.includes(config.guard_mode)) return res.status(400).json({ error: '无效模式' });
  for (const g of GUARD_KEYS) {
    if (config[g.key] !== undefined) db.setSetting(g.key, String(config[g.key]));
  }
  try { require('../subscription').reloadSubGuard(); } catch (_) {}
  db.addAuditLog(req.user.id, 'guard_config', '更新风控配置', req.clientIp || req.ip);
  res.json({ ok: true });
});

// 订阅协议可见性
router.post('/sub-visibility', (req, res) => {
  const { vless, ss, hy2 } = req.body;
  db.setSetting('sub_visible_vless', vless ? 'true' : 'false');
  db.setSetting('sub_visible_ss', ss ? 'true' : 'false');
  db.setSetting('sub_visible_hy2', hy2 ? 'true' : 'false');
  db.addAuditLog(req.user.id, 'sub_visibility', `订阅可见性: VLESS=${!!vless} SS=${!!ss} Hy2=${!!hy2}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

module.exports = router;
