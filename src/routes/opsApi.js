const express = require('express');
const db = require('../services/database');
const agentWs = require('../services/agent-ws');
const healthService = require('../services/health');
const { performBackup } = require('../services/backup');
const rotateService = require('../services/rotate');
const deployService = require('../services/deploy');
const logger = require('../services/logger');
const { opsAuth } = require('../middleware/opsAuth');
const { buildAgentMap } = require('../utils/agentMap');

const router = express.Router();
router.use(opsAuth);
const OPS_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.OPS_CACHE_TTL_MS || '3000', 10) || 3000);
const OPS_SLOW_LOG_MS = Math.max(50, parseInt(process.env.OPS_SLOW_LOG_MS || '150', 10) || 150);
const _opsResponseCache = new Map();

// 节点安全字段白名单（只暴露这些字段）
/** Project a node into the fields safe for authenticated OPS responses. */
function safeNode(n, extra) {
  return {
    id: n.id, name: n.name, host: n.host, port: n.port,
    protocol: n.protocol, network: n.network, security: n.security,
    is_active: n.is_active, region: n.region, remark: n.remark,
    min_level: n.min_level, group_name: n.group_name, tags: n.tags,
    ip_version: n.ip_version, is_manual: n.is_manual, fail_count: n.fail_count,
    ulzix_order_id: n.ulzix_order_id,
    agent_last_report: n.agent_last_report,
    last_check: n.last_check, last_rotated: n.last_rotated, created_at: n.created_at,
    ...extra,
  };
}

function summarizeReportData(reportData) {
  if (!reportData) return null;
  return {
    reportedAt: reportData.reportedAt || null,
    xrayAlive: reportData.xrayAlive ?? null,
    hysteriaAlive: reportData.hysteriaAlive ?? null,
    cnReachable: reportData.cnReachable ?? null,
    cpuUsage: reportData.cpuUsage ?? null,
    loadAvg: Array.isArray(reportData.loadAvg) ? reportData.loadAvg.slice(0, 3) : [],
    memUsage: reportData.memUsage || null,
    diskUsage: reportData.diskUsage || null,
    uptime: reportData.uptime ?? null,
    netBandwidth: reportData.netBandwidth ? {
      rxRate: reportData.netBandwidth.rxRate ?? null,
      txRate: reportData.netBandwidth.txRate ?? null,
      rxBytes: reportData.netBandwidth.rxBytes ?? null,
      txBytes: reportData.netBandwidth.txBytes ?? null,
    } : null,
  };
}

function validateId(raw) {
  const id = parseInt(raw, 10);
  return Number.isInteger(id) && id > 0 ? id : 0;
}

function getCachedJson(cacheKey) {
  const cached = _opsResponseCache.get(cacheKey);
  if (!cached) return null;
  if (Date.now() - cached.ts > OPS_CACHE_TTL_MS) {
    _opsResponseCache.delete(cacheKey);
    return null;
  }
  return cached.payload;
}

function setCachedJson(cacheKey, payload) {
  _opsResponseCache.set(cacheKey, { ts: Date.now(), payload });
  return payload;
}

function logSlowOpsRoute(route, startedAt, extra = {}) {
  const durationMs = Date.now() - startedAt;
  if (durationMs < OPS_SLOW_LOG_MS) return;
  logger.warn({ route, durationMs, ...extra }, 'ops api 慢路径');
}

// GET /ops/api/status — 全局概览
router.get('/status', (req, res) => {
  const startedAt = Date.now();
  try {
    const cached = getCachedJson('status');
    if (cached) {
      logSlowOpsRoute('/status:cache-hit', startedAt);
      return res.json(cached);
    }
    const nodes = db.getAllNodes();
    const onlineNodes = nodes.filter(n => n.is_active);
    const offlineNodes = nodes.filter(n => !n.is_active);
    const onlineCache = healthService.getOnlineCache();
    const agents = agentWs.getConnectedAgents();
    const todayTraffic = db.getTodayTraffic();
    const userCount = db.getUserCount();
    const userBreakdown = db.getDb().prepare(`
      SELECT
        SUM(CASE WHEN is_blocked=0 AND is_frozen=0 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_blocked=1 THEN 1 ELSE 0 END) as blocked,
        SUM(CASE WHEN is_frozen=1 THEN 1 ELSE 0 END) as frozen
      FROM users
    `).get() || { active: 0, blocked: 0, frozen: 0 };

    const payload = setCachedJson('status', {
      nodes: {
        total: nodes.length,
        online: onlineNodes.length,
        offline: offlineNodes.length,
      },
      agents: {
        connected: agents.length,
      },
      users: {
        total: userCount,
        active: Number(userBreakdown.active || 0),
        blocked: Number(userBreakdown.blocked || 0),
        frozen: Number(userBreakdown.frozen || 0),
        online: onlineCache?.summary?.online || 0,
      },
      traffic: {
        today: todayTraffic,
      },
      timestamp: new Date().toISOString(),
    });
    logSlowOpsRoute('/status', startedAt, { nodes: nodes.length, agents: agents.length });
    return res.json(payload);
  } catch (err) {
    logger.error({ err }, 'OPS API status 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/nodes — 所有节点详情
router.get('/nodes', (req, res) => {
  const startedAt = Date.now();
  try {
    const cached = getCachedJson('nodes');
    if (cached) {
      logSlowOpsRoute('/nodes:cache-hit', startedAt);
      return res.json(cached);
    }
    const nodes = db.getAllNodes();
    const agents = agentWs.getConnectedAgents();
    const agentMap = buildAgentMap(agents, nodes);

    const result = nodes.map(n => {
      const a = agentMap.get(n.id);
      return safeNode(n, {
        agent: a ? {
          online: true,
          ip: a.ip,
          connectedAt: a.connectedAt,
          lastReport: a.lastReport,
          reportData: summarizeReportData(a.reportData),
          version: a.version,
        } : { online: false },
      });
    });

    const payload = setCachedJson('nodes', { nodes: result });
    logSlowOpsRoute('/nodes', startedAt, { nodes: result.length, agents: agents.length });
    return res.json(payload);
  } catch (err) {
    logger.error({ err }, 'OPS API nodes 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/nodes/:id — 单节点详情
router.get('/nodes/:id', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效节点 ID' });
    const node = db.getNodeById(id);
    if (!node) return res.status(404).json({ error: '节点不存在' });

    const nodes = db.getAllNodes();
    const agents = agentWs.getConnectedAgents();
    const agentMap = buildAgentMap(agents, nodes);
    const a = agentMap.get(id);

    res.json(safeNode(node, {
      agent: a ? {
        online: true,
        reportData: a.reportData,
      } : { online: false, reportData: null },
    }));
  } catch (err) {
    logger.error({ err }, 'OPS API node detail 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/nodes/:id/restart-xray — 重启指定节点 Xray
router.post('/nodes/:id/restart-xray', async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效节点 ID' });
    const node = db.getNodeById(id);
    if (!node) return res.status(404).json({ error: '节点不存在' });

    if (!agentWs.isAgentOnline(id)) {
      return res.status(409).json({ error: 'Agent 不在线' });
    }

    const cmdType = node.protocol === 'hy2' ? 'restart_hysteria' : 'restart_xray';
    const serviceName = node.protocol === 'hy2' ? 'Hysteria' : 'Xray';
    const result = await agentWs.sendCommand(id, { type: cmdType });
    db.addAuditLog(null, 'ops_restart_xray', `OPS API 重启 ${serviceName}: ${node.name}`, 'ops-api');
    res.json({ success: result.success, data: result.data, error: result.error });
  } catch (err) {
    logger.error({ err }, 'OPS API restart-xray 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/nodes/:id/swap-ip — 手动换 IP
router.post('/nodes/:id/swap-ip', async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效节点 ID' });
    const node = db.getNodeById(id);
    if (!node) return res.status(404).json({ error: '节点不存在' });

    return res.status(501).json({success:false,error:'Ulzix 的 VPS 换 IP 扩展 API 尚未核实，请在 Ulzix 控制台操作'});
  } catch (err) {
    logger.error({ err }, 'OPS API swap-ip 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/nodes/:id/sync-config — 重新同步 Xray 配置
router.post('/nodes/:id/sync-config', async (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效节点 ID' });
    const node = db.getNodeById(id);
    if (!node) return res.status(404).json({ error: '节点不存在' });

    const result = await deployService.syncNodeConfig(node, db);
    const success = !!(result && result.success !== false);
    db.addAuditLog(null, 'ops_sync_config', `OPS API 同步配置: ${node.name} (${success ? '成功' : '失败'})`, 'ops-api');
    res.json({ success, result });
  } catch (err) {
    logger.error({ err }, 'OPS API sync-config 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/deploy — 部署新节点
router.post('/deploy', async (req, res) => {
  try {
    const { name, ssh_host, ssh_port, ssh_user, ssh_password, ssh_key_path, region, protocol, network, security } = req.body;
    if (!name || !ssh_host) {
      return res.status(400).json({ error: '缺少 name 或 ssh_host' });
    }
    const port = parseInt(ssh_port, 10) || 22;
    if (port < 1 || port > 65535) {
      return res.status(400).json({ error: '无效 ssh_port' });
    }

    const result = await deployService.deployNode({
      name,
      host: ssh_host,
      ssh_host,
      ssh_port: port,
      ssh_user: ssh_user || 'root',
      ssh_password,
      ssh_key_path,
      region,
      protocol,
      network,
      security,
    }, db);

    db.addAuditLog(null, 'ops_deploy', `OPS API 部署节点: ${name}`, 'ops-api');
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'OPS API deploy 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/rotate — 手动触发 UUID/端口轮换
router.post('/rotate', async (req, res) => {
  try {
    const result = await rotateService.rotateAll();
    db.addAuditLog(null, 'ops_rotate', 'OPS API 手动轮换', 'ops-api');
    res.json({ success: true, result });
  } catch (err) {
    logger.error({ err }, 'OPS API rotate 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/users — 用户列表
router.get('/users', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const result = db.getAllUsersPaged(limit, offset);
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'OPS API users 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/users/:id/freeze — 冻结用户
router.post('/users/:id/freeze', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效用户 ID' });
    const user = db.getUserById(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    db.freezeUser(id);
    db.addAuditLog(null, 'ops_freeze_user', `OPS API 冻结用户: ${user.username}`, 'ops-api');
    res.json({ success: true, username: user.username });
  } catch (err) {
    logger.error({ err }, 'OPS API freeze 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/users/:id/unfreeze — 解冻用户
router.post('/users/:id/unfreeze', (req, res) => {
  try {
    const id = validateId(req.params.id);
    if (!id) return res.status(400).json({ error: '无效用户 ID' });
    const user = db.getUserById(id);
    if (!user) return res.status(404).json({ error: '用户不存在' });

    db.unfreezeUser(id);
    db.addAuditLog(null, 'ops_unfreeze_user', `OPS API 解冻用户: ${user.username}`, 'ops-api');
    res.json({ success: true, username: user.username });
  } catch (err) {
    logger.error({ err }, 'OPS API unfreeze 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/audit-log — 最近审计事件
router.get('/audit-log', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const logs = db.getAuditLogs(limit, offset);
    res.json(logs);
  } catch (err) {
    logger.error({ err }, 'OPS API audit-log 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/backup — 手动触发备份
router.post('/backup', async (req, res) => {
  try {
    const result = process.env.WORKERS_RUNTIME ? {ok:true, backup:require('../../workers/backups').createBackup()} : await performBackup(db.getDb());
    db.addAuditLog(null, 'ops_backup', `OPS API 手动备份: ${result.ok ? '成功' : '失败'}`, 'ops-api');
    res.json(result);
  } catch (err) {
    logger.error({ err }, 'OPS API backup 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/health-summary — 汇总健康报告
router.get('/health-summary', (req, res) => {
  const startedAt = Date.now();
  try {
    const cached = getCachedJson('health-summary');
    if (cached) {
      logSlowOpsRoute('/health-summary:cache-hit', startedAt);
      return res.json(cached);
    }
    const nodes = db.getAllNodes();
    const agents = agentWs.getConnectedAgents();
    const agentMap = buildAgentMap(agents, nodes);
    const onlineCache = healthService.getOnlineCache();
    const todayTraffic = db.getTodayTraffic();

    const nodesSummary = nodes.map(n => {
      const agent = agentMap.get(n.id);
      return {
        id: n.id,
        name: n.name,
        host: n.host,
        is_active: n.is_active,
        remark: n.remark,
        region: n.region,
        protocol: n.protocol,
        agentOnline: !!agent,
        reportData: summarizeReportData(agent?.reportData || null),
      };
    });

    const alerts = [];
    for (const n of nodesSummary) {
      if (!n.is_active) alerts.push({ type: 'node_offline', node: n.name, remark: n.remark });
      if (!n.agentOnline) alerts.push({ type: 'agent_offline', node: n.name });
      if (n.reportData) {
        const diskPercent = Number(n.reportData.diskUsage?.usagePercent ?? n.reportData.diskUsage ?? 0);
        const memPercent = Number(n.reportData.memUsage?.usagePercent ?? n.reportData.memUsage ?? 0);
        if (diskPercent > 90) alerts.push({ type: 'disk_high', node: n.name, value: diskPercent });
        if (memPercent > 90) alerts.push({ type: 'mem_high', node: n.name, value: memPercent });
      }
    }

    const payload = setCachedJson('health-summary', {
      nodes: nodesSummary,
      onlineUsers: onlineCache?.summary?.online || 0,
      traffic: todayTraffic,
      alerts,
      timestamp: new Date().toISOString(),
    });
    logSlowOpsRoute('/health-summary', startedAt, { nodes: nodesSummary.length, alerts: alerts.length });
    return res.json(payload);
  } catch (err) {
    logger.error({ err }, 'OPS API health-summary 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/agents — 所有 Agent 连接状态
router.get('/agents', (req, res) => {
  try {
    const agents = agentWs.getConnectedAgents();
    const safe = agents.map(a => ({
      nodeId: a.nodeId,
      nodeName: a.nodeName,
      ip: a.ip,
      connectedAt: a.connectedAt,
      lastReport: a.lastReport,
      version: a.version,
    }));
    res.json({ agents: safe });
  } catch (err) {
    logger.error({ err }, 'OPS API agents 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/agents/update-all — 批量更新所有在线 Agent
router.post('/agents/update-all', async (req, res) => {
  try {
    const agents = agentWs.getConnectedAgents();
    if (agents.length === 0) {
      return res.json({ success: true, total: 0, results: [] });
    }

    const results = [];
    for (const agent of agents) {
      try {
        const result = await agentWs.sendCommand(agent.nodeId, { type: 'self_update' });
        results.push({ nodeId: agent.nodeId, nodeName: agent.nodeName, success: !!result.success });
      } catch (err) {
        results.push({ nodeId: agent.nodeId, nodeName: agent.nodeName, success: false, error: 'Command failed' });
      }
    }

    const successCount = results.filter(r => r.success).length;
    db.addAuditLog(null, 'ops_agent_update_all', `OPS API 批量更新 Agent: ${successCount}/${agents.length} 成功`, 'ops-api');
    res.json({ success: true, total: agents.length, successCount, results });
  } catch (err) {
    logger.error({ err }, 'OPS API agents update-all 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /ops/api/diary — AI 写入运营日记
router.post('/diary', (req, res) => {
  try {
    const { content, category, mood } = req.body;
    if (!content || typeof content !== 'string' || content.trim().length === 0) {
      return res.status(400).json({ error: '缺少 content' });
    }

    const trimmedContent = content.trim();
    if (/^[\s]*(\$\w+|\$\{\w+\}|\{\{\w+\}\}|<\w+>)[\s]*$/.test(trimmedContent)) {
      return res.status(400).json({ error: 'content 不能是占位符' });
    }

    const validCategories = ['ops', 'repair', 'swap_ip', 'deploy', 'scale', 'patrol', 'milestone'];
    const cat = validCategories.includes(category) ? category : 'ops';
    const m = (mood && typeof mood === 'string') ? mood.slice(0, 4) : '';

    db.addDiaryEntry(trimmedContent.slice(0, 5000), m, cat);
    db.addAuditLog(null, 'ops_diary_write', `OPS API 写入日记 [${cat}]`, 'ops-api');
    // 巡检类日记同时写入 patrol 审计事件，供飘窗统计
    if (cat === 'patrol') {
      db.addAuditLog(null, 'patrol', content.slice(0, 200), 'system');
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'OPS API diary write 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/diary — 读取运营日记
router.get('/diary', (req, res) => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const result = db.getDiaryEntries(limit, offset);
    const stats = db.getDiaryStats();
    res.json({ ...result, stats });
  } catch (err) {
    logger.error({ err }, 'OPS API diary read 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /ops/api/security/multi-node-overview — 并发多节点安全事件概览
router.get('/security/multi-node-overview', (req, res) => {
  try {
    const hours = Math.max(1, Math.min(720, parseInt(req.query.hours, 10) || 24));
    const overview = db.getUserMultiNodeObserveOverview(hours) || {};
    res.json({
      hours,
      total_events: Number(overview.total_events || 0),
      user_count: Number(overview.user_count || 0),
      high_count: Number(overview.high_count || 0),
      mid_count: Number(overview.mid_count || 0),
      avg_traffic_bytes: Number(overview.avg_traffic_bytes || 0),
      max_traffic_bytes: Number(overview.max_traffic_bytes || 0),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'OPS API security multi-node-overview 失败');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
