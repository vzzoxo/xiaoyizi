const express = require('express');
const db = require('../../services/database');
const deployService = require('../../services/deploy');
const agentWs = require('../../services/agent-ws');
const logger = require('../../services/logger');
const { emitSyncNode } = require('../../services/configEvents');
const { parseIntId, isValidHost } = require('../../utils/validators');
const { asyncHandler } = require('../../utils/asyncHandler');

const router = express.Router();

function findDuplicateNodeName(name, excludeId = null) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return null;
  const duplicate = db.getNodeByName(trimmedName);
  if (!duplicate) return null;
  if (excludeId && duplicate.id === excludeId) return null;
  return duplicate;
}

// 统一部署入口
router.post('/nodes/deploy-smart', asyncHandler(async (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, ss_method, enable_vless, enable_ss, enable_hy2,
          socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');
  if (!isValidHost(host)) return res.redirect('/admin?msg=invalid_host#nodes');

  const existing = db.getAllNodes().find(n => n.ssh_host === host.trim() || n.host === host.trim());
  if (existing) {
    db.addAuditLog(req.user.id, 'node_deploy_dup', `重复 IP: ${host} (已有节点: ${existing.name})`, req.clientIp || req.ip);
    return res.redirect('/admin?msg=dup#nodes');
  }

  let ulzixOrderId=null;
  if(req.body.ulzix_order_id) {
    ulzixOrderId=parseIntId(req.body.ulzix_order_id);
    if(!ulzixOrderId) return res.redirect('/admin?msg=invalid_order#nodes');
    try {
      const {UlzixClient}=require('../../services/ulzix');
      const order=await new UlzixClient(await require('../../services/ulzixSettings').read()).call('order/get',{id:ulzixOrderId});
      if(Number(order?.id)!==ulzixOrderId || order.status!=='active') return res.redirect('/admin?msg=ulzix_not_active#nodes');
    } catch {return res.redirect('/admin?msg=ulzix_verify_failed#nodes');}
  }

  const vless = enable_vless === 'on';
  const ss = enable_ss === 'on';
  const hy2 = enable_hy2 === 'on';
  if (!vless && !ss && !hy2) return res.redirect('/admin#nodes');

  const sshInfo = {
    ulzix_order_id:ulzixOrderId,
    host, ssh_port: parseInt(ssh_port) || 22, ssh_user: ssh_user || 'root', ssh_password,
    ss_method: ss_method || 'aes-256-gcm',
    socks5_host: socks5_host || null, socks5_port: parseInt(socks5_port) || 1080,
    socks5_user: socks5_user || null, socks5_pass: socks5_pass || null,
    triggered_by: req.user.id
  };

  // 异步部署（fire-and-forget）：立即返回页面，部署在后台执行，
  // 结果通过 TG 通知和审计日志反馈，用户可在管理页面查看节点状态。
  if (hy2) {
    db.addAuditLog(req.user.id, 'node_deploy_hy2_start', `开始Hy2部署: ${host}`, req.clientIp || req.ip);
    deployService.deployHy2Node(sshInfo, db).catch(err => logger.error('[Hy2部署异常]', err));
  }

  if (vless && ss) {
    db.addAuditLog(req.user.id, 'node_deploy_dual_start', `开始双协议部署: ${host}`, req.clientIp || req.ip);
    deployService.deployDualNode(sshInfo, db).catch(err => logger.error('[双协议部署异常]', err));
  } else if (vless) {
    db.addAuditLog(req.user.id, 'node_deploy_start', `开始VLESS部署: ${host}`, req.clientIp || req.ip);
    deployService.deployNode(sshInfo, db).catch(err => logger.error('[部署异常]', err));
  } else if (ss) {
    db.addAuditLog(req.user.id, 'node_deploy_ss_start', `开始SS部署: ${host}`, req.clientIp || req.ip);
    deployService.deploySsNode(sshInfo, db).catch(err => logger.error('[SS部署异常]', err));
  }

  res.redirect('/admin?msg=deploying#nodes');
}));

router.post('/nodes/deploy-dual', (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, ss_method, socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');
  if (!isValidHost(host)) return res.redirect('/admin?msg=invalid_host#nodes');

  const existing = db.getAllNodes().find(n => n.ssh_host === host.trim() || n.host === host.trim());
  if (existing) {
    db.addAuditLog(req.user.id, 'node_deploy_dup', `重复 IP: ${host} (已有节点: ${existing.name})`, req.clientIp || req.ip);
    return res.redirect('/admin?msg=dup#nodes');
  }

  db.addAuditLog(req.user.id, 'node_deploy_dual_start', `开始双协议部署: ${host}`, req.clientIp || req.ip);

  deployService.deployDualNode({
    host, ssh_port: parseInt(ssh_port) || 22, ssh_user: ssh_user || 'root', ssh_password,
    ss_method: ss_method || 'aes-256-gcm',
    socks5_host: socks5_host || null, socks5_port: parseInt(socks5_port) || 1080,
    socks5_user: socks5_user || null, socks5_pass: socks5_pass || null,
    triggered_by: req.user.id
  }, db).catch(err => logger.error('[双协议部署异常]', err));

  res.redirect('/admin?msg=deploying#nodes');
});

router.post('/nodes/deploy-ss', (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, ss_method, socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');
  if (!isValidHost(host)) return res.redirect('/admin?msg=invalid_host#nodes');

  const existing = db.getAllNodes().find(n => n.ssh_host === host.trim() || n.host === host.trim());
  if (existing) {
    db.addAuditLog(req.user.id, 'node_deploy_dup', `重复 IP: ${host} (已有节点: ${existing.name})`, req.clientIp || req.ip);
    return res.redirect('/admin?msg=dup#nodes');
  }

  db.addAuditLog(req.user.id, 'node_deploy_ss_start', `开始SS部署: ${host}`, req.clientIp || req.ip);

  deployService.deploySsNode({
    host, ssh_port: parseInt(ssh_port) || 22, ssh_user: ssh_user || 'root', ssh_password,
    ss_method: ss_method || 'aes-256-gcm',
    socks5_host: socks5_host || null, socks5_port: parseInt(socks5_port) || 1080,
    socks5_user: socks5_user || null, socks5_pass: socks5_pass || null,
    triggered_by: req.user.id
  }, db).catch(err => logger.error('[SS部署异常]', err));

  res.redirect('/admin?msg=deploying#nodes');
});

router.post('/nodes/deploy', (req, res) => {
  const { host, ssh_port, ssh_user, ssh_password, socks5_host, socks5_port, socks5_user, socks5_pass } = req.body;
  if (!host || !ssh_password) return res.redirect('/admin#nodes');
  if (!isValidHost(host)) return res.redirect('/admin?msg=invalid_host#nodes');

  const existing = db.getAllNodes().find(n => n.ssh_host === host.trim() || n.host === host.trim());
  if (existing) {
    db.addAuditLog(req.user.id, 'node_deploy_dup', `重复 IP: ${host} (已有节点: ${existing.name})`, req.clientIp || req.ip);
    return res.redirect('/admin?msg=dup#nodes');
  }

  db.addAuditLog(req.user.id, 'node_deploy_start', `开始部署: ${host}${socks5_host ? ' (socks5→' + socks5_host + ')' : ''}`, req.clientIp || req.ip);

  deployService.deployNode({
    host, ssh_port: parseInt(ssh_port) || 22, ssh_user: ssh_user || 'root', ssh_password,
    socks5_host: socks5_host || null, socks5_port: parseInt(socks5_port) || 1080,
    socks5_user: socks5_user || null, socks5_pass: socks5_pass || null,
    triggered_by: req.user.id
  }, db).catch(err => logger.error('[部署异常]', err));

  res.redirect('/admin?msg=deploying#nodes');
});

router.post('/nodes/:id/delete', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.redirect('/admin#nodes');

  const stopCmd = 'systemctl stop xray; systemctl disable xray; systemctl stop hysteria-server; systemctl disable hysteria-server; systemctl stop vless-agent; systemctl disable vless-agent';

  (async () => {
    try {
      if (agentWs.isAgentOnline(node.id)) {
        await agentWs.sendCommand(node.id, { type: 'exec', command: stopCmd });
      } else if (node.ssh_password || node.ssh_key_path) {
        const { NodeSSH } = require('node-ssh');
        const ssh = new NodeSSH();
        const connectOpts = {
          host: node.ssh_host || node.host, port: node.ssh_port || 22,
          username: node.ssh_user || 'root', readyTimeout: 10000
        };
        if (node.ssh_key_path) connectOpts.privateKeyPath = node.ssh_key_path;
        else connectOpts.password = node.ssh_password;
        await ssh.connect(connectOpts);
        await ssh.execCommand(stopCmd, { execOptions: { timeout: 15000 } });
        ssh.dispose();
      }
    } catch (err) {
      logger.error(`[删除节点] 停止远端服务失败: ${err.message}`);
    }
    db.deleteNode(node.id);
    // 清理 health 模块中与该节点相关的内存状态，防止残留
    try { require('../../services/health').cleanupNodeState(node.id); } catch (_) { /* 忽略 */ }
    db.addAuditLog(req.user.id, 'node_delete', `删除节点: ${node.name}`, req.clientIp || req.ip);
  })();

  res.redirect('/admin#nodes');
});

function updateNodeBasicInfo(req, res) {
  const { host, name } = req.body;
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });

  const trimmedHost = String(host || '').trim();
  const trimmedName = String(name || '').trim();
  if (!trimmedHost || !isValidHost(trimmedHost)) return res.status(400).json({ error: 'host 格式非法' });
  if (!trimmedName) return res.status(400).json({ error: '节点名称不能为空' });
  const duplicate = findDuplicateNodeName(trimmedName, id);
  if (duplicate) {
    db.addAuditLog(req.user.id, 'node_update_name_dup', `重复节点名称: ${trimmedName} (节点#${duplicate.id})`, req.clientIp || req.ip);
    return res.redirect('/admin?msg=dup_name#nodes');
  }

  const node = db.getNodeById(id);
  if (node) {
    const oldHost = node.host;
    const oldSshHost = node.ssh_host;
    const oldName = node.name;
    db.updateNode(node.id, { name: trimmedName, host: trimmedHost, ssh_host: trimmedHost });
    const rate = parseFloat(req.body.traffic_rate);
    if (!isNaN(rate) && rate >= 0) db.updateNode(node.id, { traffic_rate: rate });
    db.addAuditLog(req.user.id, 'node_update_basic', `节点更新: ${oldName}(${oldHost}) → ${trimmedName}(${trimmedHost})`, req.clientIp || req.ip);

    // 同步同机 peer 节点的 ssh_host（如双协议 VLESS+SS 部署在同一台机器）
    const allNodes = db.getAllNodes();
    const peerNodes = allNodes.filter(n => n.id !== node.id && (n.ssh_host === oldSshHost || n.ssh_host === oldHost));
    for (const peer of peerNodes) {
      const updates = { ssh_host: trimmedHost };
      // 非 IPv6 节点的 host 也一并更新
      if (peer.ip_version !== 6 && peer.host === oldHost) {
        updates.host = trimmedHost;
      }
      db.updateNode(peer.id, updates);
      db.addAuditLog(req.user.id, 'node_update_basic', `同机节点同步: ${peer.name} ssh_host → ${trimmedHost}`, req.clientIp || req.ip);
    }
  }
  res.redirect('/admin#nodes');
}

router.post('/nodes/:id/update-basic', updateNodeBasicInfo);
// 兼容旧入口
router.post('/nodes/:id/update-host', updateNodeBasicInfo);

router.get('/nodes/:id/info', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  res.json({ traffic_cap: node.traffic_cap || 0, traffic_rate: node.traffic_rate ?? 1 });
});

router.post('/nodes/:id/traffic-cap', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  // 节点流量上限上限：10000 TB（10 PB），防止数值溢出
  const MAX_NODE_TRAFFIC_TB = 10000;
  let capTb = parseFloat(req.body.cap_tb || 0);
  if (!Number.isFinite(capTb) || capTb < 0) capTb = 0;
  if (capTb > MAX_NODE_TRAFFIC_TB) capTb = MAX_NODE_TRAFFIC_TB;
  const cap = Math.round(capTb * 1099511627776);
  db.updateNode(id, { traffic_cap: cap });
  // 同机节点同步
  const node = db.getNodeById(id);
  if (node) {
    const sshHost = node.ssh_host || node.host;
    db.getAllNodes().filter(n => n.id !== id && (n.ssh_host || n.host) === sshHost).forEach(n => db.updateNode(n.id, { traffic_cap: cap }));
  }
  db.addAuditLog(req.user.id, 'node_traffic_cap', `设置流量上限: ${node?.name} → ${req.body.cap_tb || 0} TB`, req.clientIp || req.ip);
  res.json({ ok: true });
});

router.post('/nodes/:id/update-level', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  const level = parseInt(req.body.level) || 0;
  if (node) {
    db.updateNode(node.id, { min_level: Math.max(0, Math.min(3, level)) });
    db.addAuditLog(req.user.id, 'node_update_level', `${node.name} 等级: Lv.${level}`, req.clientIp || req.ip);
    emitSyncNode(db.getNodeById(id));
  }
  res.json({ ok: true });
});

router.post('/nodes/:id/restart-xray', asyncHandler(async (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  if (!agentWs.isAgentOnline(node.id)) {
    return res.json({ success: false, error: 'Agent 不在线' });
  }
  const cmdType = node.protocol === 'hy2' ? 'restart_hysteria' : 'restart_xray';
  const serviceName = node.protocol === 'hy2' ? 'Hysteria' : 'Xray';
  const result = await agentWs.sendCommand(node.id, { type: cmdType });
  db.addAuditLog(req.user.id, 'restart_xray', `重启 ${serviceName}: ${node.name}`, req.clientIp || req.ip);
  res.json(result);
}));

// Sprint 6: 更新节点分组/标签
router.post('/nodes/:id/update-group', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const { group_name, tags } = req.body;
  db.updateNode(id, {
    group_name: (group_name || '').trim(),
    tags: (tags || '').trim()
  });
  db.addAuditLog(req.user.id, 'node_update_group', `${node.name} 分组: ${group_name || '无'}, 标签: ${tags || '无'}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

// 更新节点 SS/IPv6 配置
router.post('/nodes/:id/update-ss', (req, res) => {
  const id = parseIntId(req.params.id);
  if (!id) return res.status(400).json({ error: '参数错误' });
  const node = db.getNodeById(id);
  if (!node) return res.status(404).json({ error: '节点不存在' });
  const { protocol, ip_version, ss_method, ss_password } = req.body;
  const updates = {};
  if (protocol) updates.protocol = protocol;
  if (ip_version !== undefined) updates.ip_version = parseInt(ip_version) || 4;
  if (ss_method) updates.ss_method = ss_method;
  if (ss_password !== undefined) updates.ss_password = ss_password;
  db.updateNode(id, updates);
  db.addAuditLog(req.user.id, 'node_update_ss', `${node.name} SS配置: protocol=${protocol}, ipv=${ip_version}`, req.clientIp || req.ip);
  res.json({ ok: true });
});

// 手动添加节点（SS/IPv6）
router.post('/nodes/manual', (req, res) => {
  const { name, host, port, protocol, ip_version, region, ss_method, ss_password } = req.body;
  if (!name || !host || !port) return res.status(400).json({ error: '缺少必填字段' });
  if (!isValidHost(String(host).trim())) return res.status(400).json({ error: 'host 格式非法' });
  const trimmedName = String(name || '').trim();
  const duplicate = findDuplicateNodeName(trimmedName);
  if (duplicate) return res.status(400).json({ error: '节点名称已存在' });
  const p = parseInt(port);
  if (!p || p < 1 || p > 65535) return res.status(400).json({ error: '端口无效' });

  const proto = protocol === 'ss' ? 'ss' : protocol === 'hy2' ? 'hy2' : 'vless';
  const ipv = parseInt(ip_version) === 6 ? 6 : 4;

  const { v4: uuidv4 } = require('uuid');
  const nodeData = {
    name: trimmedName,
    host: host.trim(),
    port: p,
    uuid: uuidv4(), // SS 不用但字段 NOT NULL
    protocol: proto,
    ip_version: ipv,
    region: (region || '').trim(),
    is_manual: 1,
  };

  const result = db.addNode(nodeData);
  const nodeId = result.lastInsertRowid;

  // SS 特有字段通过 updateNode 写入
  if (proto === 'ss') {
    db.updateNode(nodeId, {
      ss_method: ss_method || 'aes-256-gcm',
      ss_password: ss_password || '',
    });
  }

  db.addAuditLog(req.user.id, 'node_add_manual', `手动添加节点: ${name} (${proto}/IPv${ipv})`, req.clientIp || req.ip);
  res.json({ ok: true, id: nodeId });
});

module.exports = router;
