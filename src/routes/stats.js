const express = require('express');
const db = require('../services/database');
const { requireAuth } = require('../middleware/auth');
const { userApiLimiter } = require('../middleware/rateLimit');
const { getOnlineCache } = require('../services/health');
const { escapeHtml } = require('../utils/escapeHtml');
const { dateKeyInTimeZone, formatDateTimeInTimeZone } = require('../utils/time');
const { canUserAccessNode } = require('../utils/routeHelpers');
const agentWs = require('../services/agent-ws');
const { buildOnlineAgentSet } = require('../utils/agentMap');

const router = express.Router();
const STATS_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.API_STATS_CACHE_TTL_MS || '5000', 10) || 5000);
const PEACH_STATUS_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.API_PEACH_STATUS_CACHE_TTL_MS || '5000', 10) || 5000);
const PANEL_SUMMARY_CACHE_TTL_MS = Math.max(STATS_CACHE_TTL_MS, PEACH_STATUS_CACHE_TTL_MS);
const _panelSummaryCache = new Map();

function resolveVisibleOnlineSummary(user, cache) {
  const summary = cache?.summary || { online: 0, nodes: 0 };
  const full = cache?.full;
  if (!user || !full?.nodeUsers || !(full.nodeUsers instanceof Map)) {
    return { online: Number(summary.online || 0), nodes: Number(summary.nodes || 0) };
  }

  const visibleNodes = db.getAllNodes(true).filter((n) => canUserAccessNode(user, n));
  const visibleNodeIds = new Set(visibleNodes.map((n) => Number(n.id)));

  const users = new Set();
  for (const [nodeId, userSet] of full.nodeUsers.entries()) {
    if (!visibleNodeIds.has(Number(nodeId))) continue;
    for (const uid of (userSet || [])) users.add(Number(uid));
  }
  return { online: users.size, nodes: visibleNodes.length };
}

function buildPanelSummary(user) {
  const d = db.getDb();
  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const cache = getOnlineCache();
  const summary = resolveVisibleOnlineSummary(user, cache);
  const traffic = db.getUserTraffic(user.id);
  const currentUser = db.getUserById(user.id);
  const trafficLimit = currentUser ? currentUser.traffic_limit : 0;
  const totalUsed = (traffic.total_up || 0) + (traffic.total_down || 0);
  const remaining = trafficLimit < 0 ? -1 : Math.max(0, trafficLimit - totalUsed);
  const globalTraffic = db.getGlobalTraffic();

  const todayStats = d.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE action LIKE '%patrol%' OR action = 'health_check') as patrols,
      COUNT(*) FILTER (WHERE action = 'auto_swap_ip_ok') as swaps,
      COUNT(*) FILTER (WHERE action IN ('auto_repair','node_recovered','xray_auto_restart')) as fixes
    FROM audit_log WHERE date(created_at, '+8 hours') = ?
  `).get(today) || { patrols: 0, swaps: 0, fixes: 0 };

  const nodes = db.getAllNodes(true);
  const onlineAgents = buildOnlineAgentSet(agentWs.getConnectedAgents(), nodes);
  const onlineCount = nodes.filter((n) => onlineAgents.has(n.id)).length;
  const totalActive = nodes.length;

  const patrolDiary = d.prepare(`
    SELECT content, mood, created_at FROM ops_diary
    WHERE category = 'patrol'
    ORDER BY created_at DESC LIMIT 3
  `).all();

  return {
    stats: {
      online: summary.online || 0,
      totalUsed,
      remaining,
      trafficLimit,
      globalUp: globalTraffic.total_up || 0,
      globalDown: globalTraffic.total_down || 0,
    },
    peach: {
      todayPatrols: todayStats.patrols,
      todaySwaps: todayStats.swaps,
      nodeAvailability: totalActive > 0 ? Math.round(onlineCount / totalActive * 100) : 100,
      nodesOnline: onlineCount,
      nodesTotal: totalActive,
      patrolDiary: patrolDiary.map(e => ({
        content: escapeHtml((e.content || '').slice(0, 120)),
        mood: e.mood || '',
        time: formatDateTimeInTimeZone(e.created_at, 'Asia/Shanghai'),
      })),
    },
  };
}

function getPanelSummary(user) {
  const cacheKey = Number(user?.id || 0);
  const now = Date.now();
  const cached = _panelSummaryCache.get(cacheKey);
  if (cached && now - cached.ts < PANEL_SUMMARY_CACHE_TTL_MS) {
    return cached.payload;
  }
  const payload = buildPanelSummary(user);
  _panelSummaryCache.set(cacheKey, { ts: now, payload });
  return payload;
}

router.get('/api/panel-summary', requireAuth, userApiLimiter, (req, res) => {
  try {
    res.json(getPanelSummary(req.user));
  } catch (err) {
    res.json({
      stats: { online: 0, totalUsed: 0, remaining: 0, trafficLimit: 0, globalUp: 0, globalDown: 0 },
      peach: { todayPatrols: 0, todaySwaps: 0, nodeAvailability: 0, nodesOnline: 0, nodesTotal: 0, patrolDiary: [] },
    });
  }
});

router.get('/api/peach-status', requireAuth, userApiLimiter, (req, res) => {
  try {
    res.json(getPanelSummary(req.user).peach);
  } catch (err) {
    res.json({ online: false });
  }
});

router.get('/api/stats', requireAuth, userApiLimiter, (req, res) => {
  res.json(getPanelSummary(req.user).stats);
});

module.exports = router;
module.exports._test = {
  resolveVisibleOnlineSummary,
  resetStatsCache() {
    _panelSummaryCache.clear();
  },
};
