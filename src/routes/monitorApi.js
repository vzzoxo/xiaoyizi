const express = require('express');
const router = express.Router();
const db = require('../services/database');
const agentWs = require('../services/agent-ws');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { userApiLimiter } = require('../middleware/rateLimit');

// 按 ssh_host 合并同机节点
function groupNodesByMachine(nodes, agentMap, metricsMap) {
  const machineMap = new Map(); // ssh_host -> { nodes[], agent, report, dbMetrics }

  for (const node of nodes) {
    const machineKey = node.ssh_host || node.host;
    if (!machineMap.has(machineKey)) {
      machineMap.set(machineKey, { nodes: [], agent: null, report: null, dbMetrics: null, agentNodeId: null });
    }
    const machine = machineMap.get(machineKey);
    machine.nodes.push(node);

    // Agent 只绑定在其中一个节点上（通常是 VLESS），找到有 agent 的那个
    const agent = agentMap.get(node.id);
    if (agent) {
      machine.agent = agent;
      machine.report = agent.reportData || null;
      machine.agentNodeId = node.id;
    }
    // DB metrics 同理
    const dbm = metricsMap.get(node.id);
    if (dbm && !machine.dbMetrics) {
      machine.dbMetrics = dbm;
      if (!machine.agentNodeId) machine.agentNodeId = node.id;
    }
  }

  return machineMap;
}

// GET /api/monitor/overview
router.get('/api/monitor/overview', requireAuth, requireAdmin, userApiLimiter, (req, res) => {
  try {
    const nodes = db.getAllNodes(true);
    const connectedAgents = agentWs.getConnectedAgents();
    const agentMap = new Map();
    for (const a of connectedAgents) agentMap.set(a.nodeId, a);

    const latestMetrics = db.getLatestMetricsAllNodes();
    const metricsMap = new Map();
    for (const m of latestMetrics) metricsMap.set(m.node_id, m);

    const machineMap = groupNodesByMachine(nodes, agentMap, metricsMap);
    const overview = [];

    for (const [machineKey, machine] of machineMap) {
      const { nodes: machineNodes, agent, report, dbMetrics, agentNodeId } = machine;
      const online = agentNodeId ? agentWs.isAgentOnline(agentNodeId) : false;

      // 合并协议列表
      const protocols = machineNodes.map(n => {
        const proto = (n.protocol || 'vless').toUpperCase();
        const ipv = n.ip_version === 6 ? '⁶' : '';
        return proto + ipv;
      });

      // 用第一个节点（通常是 VLESS）的名字作为显示名，去掉 ⁶ 后缀
      const primaryNode = machineNodes.find(n => n.protocol !== 'ss') || machineNodes[0];
      const displayName = primaryNode.name.replace(/⁶$/, '');

      overview.push({
        agentNodeId: agentNodeId || primaryNode.id,
        machineKey,
        displayName,
        protocols,
        nodeIds: machineNodes.map(n => n.id),
        region: primaryNode.region || '',
        groupName: primaryNode.group_name || '',
        online,
        cpuUsage: report?.cpuUsage ?? dbMetrics?.cpu_usage ?? null,
        memUsage: report?.memUsage?.usagePercent ?? dbMetrics?.mem_usage ?? null,
        diskUsage: report?.diskUsage?.usagePercent ?? dbMetrics?.disk_usage ?? null,
        loadAvg: report?.loadAvg ?? (dbMetrics ? [dbMetrics.load_avg_1, dbMetrics.load_avg_5, dbMetrics.load_avg_15] : null),
        netRxRate: report?.netBandwidth?.rxRate ?? dbMetrics?.net_rx_rate ?? null,
        netTxRate: report?.netBandwidth?.txRate ?? dbMetrics?.net_tx_rate ?? null,
        netTotalRx: report?.netTotalRx ?? null,
        netTotalTx: report?.netTotalTx ?? null,
        uptime: report?.uptime ?? dbMetrics?.uptime ?? null,
        xrayAlive: report?.xrayAlive ?? null,
      });
    }

    res.json({ ok: true, data: overview });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/monitor/node/:id?range=1h|6h|24h|7d
router.get('/api/monitor/node/:id', requireAuth, requireAdmin, userApiLimiter, (req, res) => {
  try {
    const nodeId = parseInt(req.params.id, 10);
    if (!Number.isFinite(nodeId)) {
      return res.status(400).json({ ok: false, error: '无效节点ID' });
    }

    const node = db.getNodeById(nodeId);
    if (!node) {
      return res.status(404).json({ ok: false, error: '节点不存在' });
    }

    const range = req.query.range || '1h';
    const rangeMap = { '1h': 1, '6h': 6, '24h': 24, '7d': 168 };
    const hours = rangeMap[range] || 1;
    const sinceIso = new Date(Date.now() - hours * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

    const metrics = db.getNodeMetrics(nodeId, sinceIso, null, 500);
    const online = agentWs.isAgentOnline(nodeId);

    // 查找同机节点，返回合并协议信息
    const sshHost = node.ssh_host || node.host;
    const allNodes = db.getAllNodes(true);
    const peerNodes = allNodes.filter(n => (n.ssh_host || n.host) === sshHost);
    const protocols = peerNodes.map(n => {
      const proto = (n.protocol || 'vless').toUpperCase();
      const ipv = n.ip_version === 6 ? '⁶' : '';
      return proto + ipv;
    });
    const displayName = (peerNodes.find(n => n.protocol !== 'ss') || node).name.replace(/⁶$/, '');

    res.json({
      ok: true,
      data: {
        node: { id: node.id, name: displayName, region: node.region, protocols },
        online,
        history: metrics,
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
