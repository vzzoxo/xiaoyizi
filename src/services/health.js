const net = require('net');
const db = require('./database');
const { notify, send: notifySend } = require('./notify');
const logger = require('./logger');
const { nowUtcIso, toSqlUtc, dateKeyInTimeZone, formatDateTimeInTimeZone } = require('../utils/time');

// 模块级缓存（替代 global 变量）
const _trafficNotifiedCache = new Set();
// 节点连续失败计数（防抖用，连续 N 次失败才通知掉线）
const _nodeFailCount = new Map();
// Xray 自动重启计数（连续重启 N 次仍未恢复才通知管理员）
const _xrayRestartCount = new Map();
// 资源告警去重缓存：`${nodeId}_${type}` → 上次告警时间戳
const _resourceAlertCache = new Map();
// 用户并发多节点观察（仅记录，不自动封禁）
const _userConcurrentUsage = new Map();
const USER_MULTI_NODE_WINDOW_MS = Math.max(10000, parseInt(process.env.USER_MULTI_NODE_WINDOW_MS || '60000', 10) || 60000);
const USER_MULTI_NODE_MIN_NODES = Math.max(2, parseInt(process.env.USER_MULTI_NODE_MIN_NODES || '3', 10) || 3);
const USER_MULTI_NODE_ALERT_COOLDOWN_MS = Math.max(60000, parseInt(process.env.USER_MULTI_NODE_ALERT_COOLDOWN_MS || '600000', 10) || 600000);
const USER_MULTI_NODE_MAX_USERS = Math.max(1000, parseInt(process.env.USER_MULTI_NODE_MAX_USERS || '50000', 10) || 50000);
const USER_MULTI_NODE_TRAFFIC_THRESHOLD_BYTES = Math.max(0, parseInt(process.env.USER_MULTI_NODE_TRAFFIC_THRESHOLD_BYTES || '524288000', 10) || 524288000);
const RESOURCE_ALERT_SETTINGS_TTL_MS = Math.max(10000, parseInt(process.env.RESOURCE_ALERT_SETTINGS_TTL_MS || '30000', 10) || 30000);
const TRAFFIC_EXCEED_SETTINGS_TTL_MS = Math.max(10000, parseInt(process.env.TRAFFIC_EXCEED_SETTINGS_TTL_MS || '30000', 10) || 30000);
const AUTO_RESTART_SETTINGS_TTL_MS = Math.max(10000, parseInt(process.env.AUTO_RESTART_SETTINGS_TTL_MS || '30000', 10) || 30000);
const HEALTH_SLOW_LOG_MS = Math.max(50, parseInt(process.env.HEALTH_SLOW_LOG_MS || '200', 10) || 200);
const HEALTH_AUDIT_FLUSH_MS = Math.max(50, parseInt(process.env.HEALTH_AUDIT_FLUSH_MS || '250', 10) || 250);
const HEALTH_AUDIT_FLUSH_MAX = Math.max(10, parseInt(process.env.HEALTH_AUDIT_FLUSH_MAX || '50', 10) || 50);
const NODE_RECOVERY_NOTIFY_WINDOW_MS = Math.max(60000, parseInt(process.env.NODE_RECOVERY_NOTIFY_WINDOW_MS || '300000', 10) || 300000);

// TCP 端口探测
function checkPort(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let resolved = false;
    socket.setTimeout(timeout);
    socket.on('connect', () => { resolved = true; socket.destroy(); resolve(true); });
    socket.on('timeout', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.on('error', () => { if (!resolved) { resolved = true; socket.destroy(); resolve(false); } });
    socket.connect(port, host);
  });
}

// 在线用户共享缓存
const ONLINE_CACHE_TTL_MS = Math.max(15000, parseInt(process.env.ONLINE_CACHE_TTL_MS || '120000', 10) || 120000);
// 在线用户滑动窗口：用户在此时间内有过流量就算在线
const ONLINE_USER_WINDOW_MS = Math.max(30000, parseInt(process.env.ONLINE_USER_WINDOW_MS || '300000', 10) || 300000);
const _onlineCache = { full: null, summary: null, ts: 0 };
// 每个节点的用户最后活跃时间: nodeId -> Map<userId, timestamp>
const _nodeUserLastSeen = new Map();
const NODE_SNAPSHOT_TTL_MS = Math.max(3000, parseInt(process.env.NODE_SNAPSHOT_TTL_MS || '5000', 10) || 5000);
const _nodeSnapshotCache = { ts: 0, nodes: [], byId: new Map(), byHost: new Map() };
const _resourceAlertSettingsCache = { ts: 0, value: null };
const _trafficExceedSettingsCache = { ts: 0, value: null };
const _autoRestartSettingsCache = { ts: 0, value: null };
const _nodeRecoveryNotifyCache = new Map();
const _bufferedAuditLogs = [];
const _bufferedObserveEvents = [];
let _auditFlushTimer = null;

function getNodeSnapshot(force = false) {
  const now = Date.now();
  if (!force && _nodeSnapshotCache.nodes.length > 0 && now - _nodeSnapshotCache.ts < NODE_SNAPSHOT_TTL_MS) {
    return _nodeSnapshotCache;
  }
  const nodes = db.getAllNodes();
  const byId = new Map();
  const byHost = new Map();
  for (const node of nodes) {
    byId.set(node.id, node);
    const host = getNodeHost(node);
    if (!host) continue;
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(node);
  }
  _nodeSnapshotCache.ts = now;
  _nodeSnapshotCache.nodes = nodes;
  _nodeSnapshotCache.byId = byId;
  _nodeSnapshotCache.byHost = byHost;
  return _nodeSnapshotCache;
}

function getResourceAlertSettings() {
  const now = Date.now();
  if (_resourceAlertSettingsCache.value && now - _resourceAlertSettingsCache.ts < RESOURCE_ALERT_SETTINGS_TTL_MS) {
    return _resourceAlertSettingsCache.value;
  }
  const rawDisk = db.getSetting('resource_alert_disk');
  const rawMem = db.getSetting('resource_alert_mem');
  const rawLoad = db.getSetting('resource_alert_load');
  const rawCooldown = db.getSetting('resource_alert_cooldown');
  const diskThreshold = parseFloat(rawDisk ?? '') || 90;
  const memThreshold = parseFloat(rawMem ?? '') || 90;
  const loadThreshold = parseFloat(rawLoad ?? '') || 2;
  const parsedCooldown = parseInt(rawCooldown, 10);
  const cooldownMin = Number.isFinite(parsedCooldown) && parsedCooldown >= 1 ? parsedCooldown : 60;
  const value = {
    diskThreshold,
    memThreshold,
    loadThreshold,
    cooldownMs: cooldownMin * 60 * 1000,
  };
  _resourceAlertSettingsCache.ts = now;
  _resourceAlertSettingsCache.value = value;
  return value;
}

function getTrafficExceedSettings() {
  const now = Date.now();
  if (_trafficExceedSettingsCache.value && now - _trafficExceedSettingsCache.ts < TRAFFIC_EXCEED_SETTINGS_TTL_MS) {
    return _trafficExceedSettingsCache.value;
  }
  const action = db.getSetting('traffic_exceed_action') || 'notify';
  const thresholdGb = parseFloat(db.getSetting('traffic_exceed_threshold_gb')) || 20;
  const hardLimitGb = parseFloat(db.getSetting('traffic_exceed_hard_limit_gb')) || 50;
  const trafficFreezeEnabled = db.getSetting('auto_freeze_traffic_enabled') === 'true';
  const value = {
    action,
    thresholdGb,
    hardLimitGb,
    thresholdBytes: thresholdGb * 1073741824,
    hardLimitBytes: hardLimitGb * 1073741824,
    trafficFreezeEnabled,
  };
  _trafficExceedSettingsCache.ts = now;
  _trafficExceedSettingsCache.value = value;
  return value;
}

function getAutoRestartSettings() {
  const now = Date.now();
  if (_autoRestartSettingsCache.value && now - _autoRestartSettingsCache.ts < AUTO_RESTART_SETTINGS_TTL_MS) {
    return _autoRestartSettingsCache.value;
  }
  const value = {
    autoRestartEnabled: db.getSetting('auto_restart_xray') !== 'false',
    maxRestarts: parseInt(db.getSetting('auto_restart_max'), 10) || 2,
  };
  _autoRestartSettingsCache.ts = now;
  _autoRestartSettingsCache.value = value;
  return value;
}

function logSlowHealthStep(step, startedAt, extra = {}) {
  const durationMs = Date.now() - startedAt;
  if (durationMs < HEALTH_SLOW_LOG_MS) return;
  logger.warn({ step, durationMs, ...extra }, 'health 慢路径');
}

function flushBufferedHealthWrites() {
  if (_auditFlushTimer) {
    clearTimeout(_auditFlushTimer);
    _auditFlushTimer = null;
  }
  if (_bufferedAuditLogs.length === 0 && _bufferedObserveEvents.length === 0) return;

  const auditRows = _bufferedAuditLogs.splice(0, _bufferedAuditLogs.length);
  const observeRows = _bufferedObserveEvents.splice(0, _bufferedObserveEvents.length);

  try {
    const d = db.getDb();
    d.transaction(() => {
      if (auditRows.length > 0) {
        const stmt = d.prepare('INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?, ?, ?, ?, ?)');
        for (const row of auditRows) {
          stmt.run(row.userId, row.action, row.detail, row.ip, row.createdAt);
        }
      }
      if (observeRows.length > 0) {
        const stmt = d.prepare(`
          INSERT INTO user_multi_node_observe_event
            (user_id, username, node_count, nodes_sample, window_seconds, total_traffic_bytes, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        for (const row of observeRows) {
          stmt.run(row.userId, row.username, row.nodeCount, row.nodesSample, row.windowSeconds, row.totalTrafficBytes, row.createdAt);
        }
      }
    })();
  } catch (err) {
    logger.warn({ err, auditRows: auditRows.length, observeRows: observeRows.length }, '批量写入 health 审计事件失败');
    for (const row of auditRows) {
      try { db.addAuditLog(row.userId, row.action, row.detail, row.ip); } catch (_) {}
    }
    for (const row of observeRows) {
      try {
        db.addUserMultiNodeObserveEvent(row);
      } catch (_) {}
    }
  }
}

function scheduleHealthWriteFlush() {
  if (_auditFlushTimer) return;
  _auditFlushTimer = setTimeout(() => flushBufferedHealthWrites(), HEALTH_AUDIT_FLUSH_MS);
  if (typeof _auditFlushTimer.unref === 'function') _auditFlushTimer.unref();
}

function bufferSystemAuditLog(action, detail, ip = 'system') {
  _bufferedAuditLogs.push({
    userId: null,
    action,
    detail,
    ip,
    createdAt: toSqlUtc(),
  });
  if (_bufferedAuditLogs.length >= HEALTH_AUDIT_FLUSH_MAX) return flushBufferedHealthWrites();
  scheduleHealthWriteFlush();
}

function bufferMultiNodeObserveEvent(input = {}) {
  const userId = Number(input.userId || 0);
  const nodeCount = Number(input.nodeCount || 0);
  if (!userId || nodeCount <= 0) return;
  _bufferedObserveEvents.push({
    userId,
    username: String(input.username || '').slice(0, 120),
    nodeCount,
    nodesSample: Array.isArray(input.nodesSample)
      ? input.nodesSample.map((x) => String(x)).join(',').slice(0, 300)
      : String(input.nodesSample || '').slice(0, 300),
    windowSeconds: Number(input.windowSeconds || 0),
    totalTrafficBytes: Number(input.totalTrafficBytes || 0),
    createdAt: toSqlUtc(),
  });
  if (_bufferedObserveEvents.length >= HEALTH_AUDIT_FLUSH_MAX) return flushBufferedHealthWrites();
  scheduleHealthWriteFlush();
}

function ensureOnlineCacheFull(now) {
  if (!_onlineCache.full || now - _onlineCache.ts > ONLINE_CACHE_TTL_MS) {
    _onlineCache.full = { total: 0, users: [], nodes: [], nodeUsers: new Map(), nodeUpdatedAt: new Map() };
    _onlineCache.ts = now;
  }
  return _onlineCache.full;
}

function getOnlineCache() {
  const now = Date.now();
  if (_onlineCache.summary && now - _onlineCache.ts > ONLINE_CACHE_TTL_MS) {
    _onlineCache.summary = { online: 0, nodes: _onlineCache.summary.nodes || 0 };
    if (_onlineCache.full?.nodes) {
      for (const n of _onlineCache.full.nodes) n.count = 0;
      _onlineCache.full.total = 0;
      _onlineCache.full.users = [];
      _onlineCache.full.nodeUsers?.clear();
      _onlineCache.full.nodeUpdatedAt?.clear();
    }
  }
  return _onlineCache;
}

function getNodeHost(node) {
  return (node?.ssh_host || node?.host || '').trim();
}

function shouldNotifyNodeRecovery(node, now = Date.now()) {
  const hostKey = getNodeHost(node) || String(node?.id || '');
  const lastNotifiedAt = _nodeRecoveryNotifyCache.get(hostKey) || 0;
  if (lastNotifiedAt && now - lastNotifiedAt < NODE_RECOVERY_NOTIFY_WINDOW_MS) {
    return false;
  }
  _nodeRecoveryNotifyCache.set(hostKey, now);
  if (_nodeRecoveryNotifyCache.size > 1000) {
    for (const [key, ts] of _nodeRecoveryNotifyCache) {
      if (now - ts >= NODE_RECOVERY_NOTIFY_WINDOW_MS) _nodeRecoveryNotifyCache.delete(key);
    }
  }
  return true;
}

// 同机双协议节点（VLESS/SS）共享同一个 Agent/xray 时，用于状态与在线人数镜像
function getPeerNodes(node) {
  const host = getNodeHost(node);
  if (!host) return [];
  try {
    const snapshot = getNodeSnapshot();
    return (snapshot.byHost.get(host) || []).filter(n => n.id !== node.id && n.protocol !== node.protocol);
  } catch (err) {
    logger.debug({ err, nodeId: node?.id }, '读取同机双协议节点失败，已忽略');
    return [];
  }
}

function updatePeerLastReport(peerNodes, now) {
  if (!peerNodes || peerNodes.length === 0) return;
  const stmt = db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?');
  for (const peer of peerNodes) {
    try { stmt.run(now, peer.id); } catch (err) {
      logger.debug({ err, nodeId: peer?.id }, '更新双协议同机节点上报时间失败，已忽略');
    }
  }
}

function mirrorPeerState(peerNodes, status, remark, now) {
  if (!peerNodes || peerNodes.length === 0) return;
  for (const peer of peerNodes) {
    try {
      db.updateNode(peer.id, {
        is_active: status,
        remark,
        last_check: toSqlUtc(now),
      });
      db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?').run(now, peer.id);
    } catch (err) {
      logger.debug({ err, nodeId: peer?.id }, '镜像双协议节点状态失败，已忽略');
    }
  }
}

function upsertOnlineNodeCount(cache, nodeId, nodeName, count) {
  const idx = cache.nodes.findIndex(n => n.nodeId === nodeId);
  if (idx >= 0) cache.nodes[idx].count = count;
  else cache.nodes.push({ nodeId, nodeName, count });
}

function rebuildOnlineUsersFromNodeMap(cache) {
  const userIds = new Set();
  for (const ids of cache.nodeUsers.values()) {
    for (const uid of ids) userIds.add(uid);
  }
  const users = db.getUsersByIds([...userIds]).map(u => ({ id: u.id, username: u.username }));
  cache.users = users;
  cache.total = users.length;
}

function pruneStaleOnlineNodeEntries(cache, now) {
  for (const row of cache.nodes) {
    const updatedAt = cache.nodeUpdatedAt.get(row.nodeId) || 0;
    if (!updatedAt || now - updatedAt > ONLINE_CACHE_TTL_MS) {
      cache.nodeUsers.set(row.nodeId, new Set());
      row.count = 0;
    }
  }
}

function cleanupConcurrentNodeState(now) {
  for (const [userId, state] of _userConcurrentUsage) {
    const map = state.hosts || state.nodes;
    if (!map) { _userConcurrentUsage.delete(userId); continue; }
    for (const [key, entry] of map) {
      if (now - entry.ts > USER_MULTI_NODE_WINDOW_MS) map.delete(key);
    }
    if (map.size === 0 && now - (state.updatedAt || 0) > USER_MULTI_NODE_WINDOW_MS) {
      _userConcurrentUsage.delete(userId);
    }
  }
  if (_userConcurrentUsage.size <= USER_MULTI_NODE_MAX_USERS) return;
  const sorted = [..._userConcurrentUsage.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  const removeCount = _userConcurrentUsage.size - USER_MULTI_NODE_MAX_USERS;
  for (let i = 0; i < removeCount; i++) _userConcurrentUsage.delete(sorted[i][0]);
}

function trackConcurrentNodeUsage(nodeUserIdsMap, nodeUserTrafficMap, now) {
  if (!nodeUserIdsMap || nodeUserIdsMap.size === 0) return;
  const snapshot = getNodeSnapshot();

  // 构建 nodeId → ssh_host 映射，用于按物理机器去重
  const nodeHostMap = new Map();
  for (const nodeId of nodeUserIdsMap.keys()) {
    const n = snapshot.byId.get(nodeId);
    nodeHostMap.set(nodeId, n?.ssh_host || n?.host || String(nodeId));
  }

  const currentByUser = new Map();
  for (const [nodeId, uidSet] of nodeUserIdsMap) {
    const host = nodeHostMap.get(nodeId);
    for (const uid of uidSet) {
      if (!currentByUser.has(uid)) currentByUser.set(uid, new Map()); // host → { nodeIds, traffic }
      const userHosts = currentByUser.get(uid);
      if (!userHosts.has(host)) userHosts.set(host, { nodeIds: new Set(), trafficBytes: 0 });
      const entry = userHosts.get(host);
      entry.nodeIds.add(nodeId);
      const traffic = (nodeUserTrafficMap?.get(nodeId)?.get(uid)) || 0;
      entry.trafficBytes += traffic;
    }
  }

  for (const [userId, hostMap] of currentByUser) {
    let state = _userConcurrentUsage.get(userId);
    if (!state) {
      state = { hosts: new Map(), lastAlertAt: 0, updatedAt: now };
      _userConcurrentUsage.set(userId, state);
    }
    for (const [host, data] of hostMap) {
      state.hosts.set(host, { ts: now, trafficBytes: (state.hosts.get(host)?.trafficBytes || 0) + data.trafficBytes, nodeIds: data.nodeIds });
    }
    for (const [host, entry] of state.hosts) {
      if (now - entry.ts > USER_MULTI_NODE_WINDOW_MS) state.hosts.delete(host);
    }
    state.updatedAt = now;

    // 按物理机器数判断，不再按 nodeId 数
    if (state.hosts.size >= USER_MULTI_NODE_MIN_NODES && now - state.lastAlertAt >= USER_MULTI_NODE_ALERT_COOLDOWN_MS) {
      let totalTrafficBytes = 0;
      for (const entry of state.hosts.values()) totalTrafficBytes += entry.trafficBytes;
      if (totalTrafficBytes < USER_MULTI_NODE_TRAFFIC_THRESHOLD_BYTES) continue;
      try {
        const user = db.getUserById(userId);
        const hostList = [...state.hosts.keys()].slice(0, 8);
        const allNodeIds = [];
        for (const entry of state.hosts.values()) for (const nid of entry.nodeIds) allNodeIds.push(nid);
        const windowSeconds = Math.round(USER_MULTI_NODE_WINDOW_MS / 1000);
        const trafficMb = (totalTrafficBytes / 1048576).toFixed(1);
        bufferMultiNodeObserveEvent({
          userId,
          username: user?.username || '',
          nodeCount: state.hosts.size,
          nodesSample: allNodeIds.slice(0, 20),
          windowSeconds,
          totalTrafficBytes,
        });
        const detail = `用户#${userId} user=${user?.username || 'unknown'} window=${windowSeconds}s hosts=${state.hosts.size} traffic=${trafficMb}MB sample=[${hostList.join(',')}]`;
        bufferSystemAuditLog('user_multi_node_observe', detail);
        state.lastAlertAt = now;
      } catch (err) {
        logger.debug({ err, userId }, '记录并发多节点观察事件失败，已忽略');
      }
    }
  }

  cleanupConcurrentNodeState(now);
}

function buildTagCache(nodeId) {
  const cache = {};
  try {
    const rows = db.getDb().prepare('SELECT user_id, uuid FROM user_node_uuid WHERE node_id = ?').all(nodeId);
    for (const row of rows) cache[row.uuid.slice(0, 8)] = row.user_id;
  } catch (err) {
    logger.debug({ err, nodeId }, '加载 user_node_uuid 标签映射失败，已忽略');
  }
  return cache;
}

function buildProtocolNodeMap(node, peerNodes) {
  const map = { defaultNodeId: node.id };
  if (node.protocol === 'vless') map.vlessNodeId = node.id;
  if (node.protocol === 'ss') map.ssNodeId = node.id;
  if (node.protocol === 'hy2') map.hy2NodeId = node.id;
  for (const peer of (peerNodes || [])) {
    if (peer.protocol === 'vless' && !map.vlessNodeId) map.vlessNodeId = peer.id;
    if (peer.protocol === 'ss' && !map.ssNodeId) map.ssNodeId = peer.id;
    if (peer.protocol === 'hy2' && !map.hy2NodeId) map.hy2NodeId = peer.id;
  }
  return map;
}

function resolveTargetNodeId(record, protocolNodeMap) {
  const proto = String(record?.proto || '').toLowerCase();
  if (proto === 'ss') return protocolNodeMap.ssNodeId || protocolNodeMap.defaultNodeId;
  if (proto === 'vless' || proto === 'v') return protocolNodeMap.vlessNodeId || protocolNodeMap.defaultNodeId;
  if (proto === 'hy2') return protocolNodeMap.hy2NodeId || protocolNodeMap.defaultNodeId;
  return protocolNodeMap.defaultNodeId;
}

// 保存流量记录到数据库
function saveTrafficRecords(nodeId, records, routeCtx = null) {
  if (!records || records.length === 0) return 0;
  const snapshot = routeCtx?.nodeSnapshot || getNodeSnapshot();
  const node = routeCtx?.node || snapshot.byId.get(nodeId) || db.getNodeById(nodeId);
  if (!node) return 0;
  const peerNodes = routeCtx?.peerNodes || getPeerNodes(node);
  const protocolNodeMap = buildProtocolNodeMap(node, peerNodes);
  const hasProtocolSplit = records.some(r => {
    const p = String(r?.proto || '').toLowerCase();
    return p === 'ss' || p === 'vless' || p === 'v' || p === 'hy2';
  });

  const userTraffic = {};

  // 兼容旧格式 tag → userId 映射缓存
  let _tagCache = null;
  function resolveTag(tag) {
    if (!_tagCache) _tagCache = buildTagCache(nodeId);
    return _tagCache[tag] || null;
  }

  for (const r of records) {
    let userId = r.userId;
    // 兼容旧格式：通过 tag 反查 userId
    if (!userId && r.tag) {
      userId = resolveTag(r.tag);
      if (!userId) continue; // 无法反查，跳过
    }
    if (!userId) continue;

    const targetNodeId = hasProtocolSplit
      ? resolveTargetNodeId(r, protocolNodeMap)
      : nodeId;

    const key = `${targetNodeId}:${userId}`;
    if (!userTraffic[key]) userTraffic[key] = { up: 0, down: 0 };
    if (r.direction === 'uplink') userTraffic[key].up += r.value;
    else userTraffic[key].down += r.value;
  }
  let count = 0;
  for (const [key, traffic] of Object.entries(userTraffic)) {
    const [targetNodeIdRaw, userIdRaw] = key.split(':');
    const targetNodeId = parseInt(targetNodeIdRaw, 10);
    const userId = parseInt(userIdRaw, 10);
    if (!targetNodeId || !userId) continue;
    if (traffic.up > 0 || traffic.down > 0) {
      const tNode = (targetNodeId === nodeId) ? node : (snapshot.byId.get(targetNodeId) || db.getNodeById(targetNodeId));
      const rate = (tNode && tNode.traffic_rate != null) ? tNode.traffic_rate : 1;
      try {
        db.recordTraffic(userId, targetNodeId, Math.round(traffic.up * rate), Math.round(traffic.down * rate));
        count++;
      } catch (err) {
        // 用户或节点已删除时外键约束会失败，记录日志后跳过避免进程崩溃
        logger.debug({ err: err.message, userId, targetNodeId }, '记录流量失败（实体可能已删除），已跳过');
      }
    }
  }
  // 检查同机节点流量上限
  if (count > 0) {
    checkNodeTrafficCap(nodeId);
    // 检查用户总流量限额
    const checkedUsers = new Set();
    for (const key of Object.keys(userTraffic)) {
      const userId = parseInt(key.split(':')[1], 10);
      if (!userId || checkedUsers.has(userId)) continue;
      checkedUsers.add(userId);
      checkUserTrafficLimit(userId);
      checkUserDailyTrafficAlert(userId);
    }
  }
  return count;
}

// 用户单日流量预警（独立于硬限额，给已绑定 TG 的用户私信提醒）
const _trafficAlertNotified = new Map(); // userId → 上次通知日期 (YYYY-MM-DD)

// 每天凌晨清理：保留今日条目，丢弃过期日期
function cleanupTrafficAlertCache() {
  try {
    const today = require('../utils/time').dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
    let removed = 0;
    for (const [uid, date] of _trafficAlertNotified) {
      if (date !== today) {
        _trafficAlertNotified.delete(uid);
        removed++;
      }
    }
    if (removed > 0) logger.debug({ removed, kept: _trafficAlertNotified.size }, 'trafficAlertCache cleaned');
  } catch (_) { /* 忽略 */ }
}
setInterval(cleanupTrafficAlertCache, 60 * 60 * 1000).unref(); // 每小时清理一次

function checkUserDailyTrafficAlert(userId) {
  if (db.getSetting('traffic_alert_enabled') !== 'true') return;
  const user = db.getUserById(userId);
  if (!user || !user.telegram_id) return;
  if (user.is_blocked || user.is_frozen) return;

  const thresholdGb = parseFloat(db.getSetting('traffic_alert_threshold_gb'));
  if (!Number.isFinite(thresholdGb) || thresholdGb <= 0) return;

  // 今日已用流量（基于 traffic_daily 表）
  const today = require('../utils/time').dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const row = db.getDb().prepare(
    'SELECT COALESCE(SUM(uplink+downlink), 0) AS bytes FROM traffic_daily WHERE user_id = ? AND date = ?'
  ).get(userId, today);
  const todayGb = (row?.bytes || 0) / 1073741824;
  if (todayGb < thresholdGb) return;

  // 同一用户每日最多通知一次
  if (_trafficAlertNotified.get(userId) === today) return;
  _trafficAlertNotified.set(userId, today);

  notify.userTrafficAlert(user, todayGb).then(ok => {
    if (ok) {
      db.addAuditLog(userId, 'traffic_alert_notify', `今日流量预警 ${todayGb.toFixed(2)} GB（阈值 ${thresholdGb} GB）`, 'system');
    }
  }).catch(() => {});
}

// 用户总流量限额检查
function checkUserTrafficLimit(userId) {
  const user = db.getUserById(userId);
  if (!user || user.traffic_limit < 0) return;
  if (!db.isTrafficExceeded(userId)) {
    // 流量未超限：如果之前因流量冻结的，自动解冻
    if (user.is_frozen && user.freeze_reason === 'traffic_limit') {
      db.unfreezeUser(userId);
      db.addAuditLog(null, 'traffic_limit_unfreeze', `流量限额恢复自动解冻: ${user.username}`, 'system');
      notify.ops(`🔓 <b>流量限额恢复</b>\n用户: ${user.username}\n动作: 自动解冻`);
      try { require('./configEvents').emitSyncAll(); } catch (_) {}
    }
    return;
  }
  if (user.is_frozen) return; // 已冻结不重复处理
  db.freezeUser(userId, 'traffic_limit');
  const usedGb = ((db.getUserTraffic(userId).total_up || 0) + (db.getUserTraffic(userId).total_down || 0)) / 1073741824;
  const limitGb = (user.traffic_limit / 1073741824).toFixed(2);
  db.addAuditLog(null, 'traffic_limit_freeze', `流量限额用完自动冻结: ${user.username} (${usedGb.toFixed(2)}/${limitGb} GB)`, 'system');
  notify.ops(`🔒 <b>流量限额用完</b>\n用户: ${user.username}\n已用: ${usedGb.toFixed(2)} GB\n限额: ${limitGb} GB\n动作: 自动冻结`);
  try { require('./configEvents').emitSyncAll(); } catch (_) {}
}

// 节点流量上限检查（按同机 ssh_host 汇总）
const _trafficCapNotified = new Set();
let _lastTrafficCapResetMonth = -1;
// 节点流量超限标记每月初重置（流量周期通常按月计算）
function maybeResetTrafficCapNotified() {
  try {
    const now = new Date();
    const month = now.getUTCFullYear() * 12 + now.getUTCMonth();
    if (_lastTrafficCapResetMonth === -1) { _lastTrafficCapResetMonth = month; return; }
    if (month !== _lastTrafficCapResetMonth) {
      _trafficCapNotified.clear();
      _lastTrafficCapResetMonth = month;
      logger.info('节点流量超限缓存已按月重置');
    }
  } catch (_) { /* 忽略 */ }
}
setInterval(maybeResetTrafficCapNotified, 60 * 60 * 1000).unref(); // 每小时检查一次
function checkNodeTrafficCap(nodeId) {
  const snapshot = getNodeSnapshot();
  const node = snapshot.byId.get(nodeId) || db.getNodeById(nodeId);
  if (!node || !node.traffic_cap || node.traffic_cap <= 0) return;
  const sshHost = node.ssh_host || node.host;
  if (_trafficCapNotified.has(sshHost)) return;

  const t = db.getHostTraffic(sshHost);
  const total = (t.total_up || 0) + (t.total_down || 0);
  if (total < node.traffic_cap) return;

  _trafficCapNotified.add(sshHost);
  // 停用同机所有节点
  const peers = snapshot.nodes.filter(n => (n.ssh_host || n.host) === sshHost);
  const names = [];
  let agentNodeId = null;
  for (const p of peers) {
    if (p.is_active) {
      db.updateNode(p.id, { is_active: 0, remark: '🚫 流量超限自动停用' });
      names.push(p.name);
    }
    if (!agentNodeId) agentNodeId = p.id;
  }
  if (names.length) {
    db.addAuditLog(null, 'node_traffic_cap', `流量超限停用: ${names.join(', ')} (${sshHost})`, 'system');
    notify.ops(`🚫 <b>节点流量超限</b>\n主机: ${sshHost}\n停用: ${names.join(', ')}`).catch(() => {});
    // 远程停掉 Xray 和 Hysteria 服务，防止已连接用户继续跑流量
    if (agentNodeId) {
      const agentWs = require('./agent-ws');
      if (agentWs.isAgentOnline(agentNodeId)) {
        agentWs.sendCommand(agentNodeId, { type: 'exec', command: 'systemctl stop xray; systemctl stop hysteria-server' }).catch(() => {});
      }
    }
  }
}

// 资源阈值告警检查
function checkResourceThresholds(nodeId, nodeName, reportData) {
  if (!reportData) return;
  const now = Date.now();
  const { diskUsage, memUsage, loadAvg } = reportData;

  // 统一提取数值：Agent 上报的 diskUsage/memUsage 可能是对象 { usagePercent } 或数字
  const diskVal = typeof diskUsage === 'object' ? diskUsage?.usagePercent : diskUsage;
  const memVal = typeof memUsage === 'object' ? memUsage?.usagePercent : memUsage;
  const loadVal = Array.isArray(loadAvg) ? loadAvg[0] : loadAvg;

  // 从 DB 读取可配置阈值（用 ?? 而非 || 以允许设置为 0）
  const { diskThreshold, memThreshold, loadThreshold, cooldownMs } = getResourceAlertSettings();

  const checks = [];
  if (typeof diskVal === 'number' && diskVal > diskThreshold) {
    checks.push({ type: 'disk', label: '磁盘', value: diskVal, unit: '%' });
  }
  if (typeof memVal === 'number' && memVal > memThreshold) {
    checks.push({ type: 'mem', label: '内存', value: memVal, unit: '%' });
  }
  if (typeof loadVal === 'number' && loadVal > loadThreshold) {
    checks.push({ type: 'load', label: '负载', value: loadVal.toFixed(2), unit: '' });
  }

  for (const c of checks) {
    const cacheKey = `${nodeId}_${c.type}`;
    const lastAlert = _resourceAlertCache.get(cacheKey) || 0;
    if (now - lastAlert < cooldownMs) continue;
    _resourceAlertCache.set(cacheKey, now);
    bufferSystemAuditLog(`resource_${c.type}_high`, `${nodeName}: ${c.label}使用率 ${c.value}${c.unit}`);
    notify.ops(`⚠️ <b>资源告警</b>\n节点: ${nodeName}\n${c.label}: ${c.value}${c.unit}`);
  }
}

// 流量超标检测（可配置策略）
let _lastTrafficCheckTs = 0;
const TRAFFIC_CHECK_INTERVAL_MS = 60000;

function checkTrafficExceed() {
  // 节流：每分钟最多执行一次（避免每次 Agent 心跳都跑聚合查询）
  const now = Date.now();
  if (now - _lastTrafficCheckTs < TRAFFIC_CHECK_INTERVAL_MS) return;
  _lastTrafficCheckTs = now;

  try {
    const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
    // 清理非今日缓存，避免 Set 长期增长
    for (const key of _trafficNotifiedCache) {
      if (!String(key).endsWith(`_${today}`)) _trafficNotifiedCache.delete(key);
    }

    // 读取可配置策略（提到循环外，避免重复读取）
    const {
      action,
      thresholdGb,
      hardLimitGb,
      thresholdBytes,
      hardLimitBytes,
      trafficFreezeEnabled,
    } = getTrafficExceedSettings();

    const todayTraffic = db.getDb().prepare(`
      SELECT t.user_id, u.username, SUM(t.uplink) as total_up, SUM(t.downlink) as total_down
      FROM traffic_daily t JOIN users u ON t.user_id = u.id
      WHERE t.date = ? GROUP BY t.user_id HAVING (total_up + total_down) >= ?
    `).all(today, thresholdBytes);

    let needSync = false;

    for (const u of todayTraffic) {
      const totalBytes = u.total_up + u.total_down;
      const gb = (totalBytes / 1073741824).toFixed(2);

      // 通知（每用户每天仅一次）
      const notifyKey = `traffic_notified_${u.user_id}_${today}`;
      if (!_trafficNotifiedCache.has(notifyKey)) {
        _trafficNotifiedCache.add(notifyKey);
        bufferSystemAuditLog('traffic_exceed', `用户 ${u.username} 今日流量超标: ${gb} GB`);
        notify.trafficExceed(u.username, totalBytes);
      }

      // 冻结（独立于通知，每用户每天仅冻结一次，受开关控制）
      if (!trafficFreezeEnabled) continue;
      const freezeKey = `traffic_frozen_${u.user_id}_${today}`;
      if (_trafficNotifiedCache.has(freezeKey)) continue;
      const shouldFreeze = action === 'freeze'
        ? totalBytes >= thresholdBytes
        : totalBytes >= hardLimitBytes;
      if (shouldFreeze) {
        try {
          db.freezeUser(u.user_id, 'traffic');
          _trafficNotifiedCache.add(freezeKey);
          needSync = true;
          const limitGb = action === 'freeze' ? thresholdGb : hardLimitGb;
          bufferSystemAuditLog('traffic_exceed_freeze', `流量超标自动冻结: ${u.username} (${gb} GB)`);
          notify.ops(`🔒 <b>流量超标自动冻结</b>\n用户: ${u.username}\n今日流量: ${gb} GB\n阈值: ${limitGb} GB`);
        } catch (err) {
          logger.debug({ err, userId: u.user_id }, '流量超标冻结用户失败');
        }
      }
    }

    // 有冻结发生时，统一同步一次配置到所有节点
    if (needSync) {
      try {
        const { emitSyncAll } = require('./configEvents');
        emitSyncAll();
      } catch (syncErr) {
        logger.warn({ err: syncErr }, '流量冻结后同步配置失败，节点可能仍允许已冻结用户');
      }
    }
  } catch (e) {
    logger.error({ err: e }, '流量超标检测失败');
  }
}

// 更新在线用户缓存（从流量记录推断）
function updateOnlineCache(nodeId, trafficRecords, routeCtx = null) {
  const now = Date.now();
  const cache = ensureOnlineCacheFull(now);
  const snapshot = routeCtx?.nodeSnapshot || getNodeSnapshot();
  const node = routeCtx?.node || snapshot.byId.get(nodeId) || db.getNodeById(nodeId);
  if (!node) return;
  const peerNodes = routeCtx?.peerNodes || getPeerNodes(node);
  const records = Array.isArray(trafficRecords) ? trafficRecords : [];
  const protocolNodeMap = buildProtocolNodeMap(node, peerNodes);
  const hasProtocolSplit = records.some(r => {
    const p = String(r?.proto || '').toLowerCase();
    return p === 'ss' || p === 'vless' || p === 'v' || p === 'hy2';
  });

  const nodeUserIdsMap = new Map();
  const nodeUserTrafficMap = new Map();
  // 构建 tag→userId 缓存
  let _tagCache = null;
  function resolveTag(tag) {
    if (!_tagCache) _tagCache = buildTagCache(nodeId);
    return _tagCache[tag] || null;
  }
  for (const r of records) {
    let uid = r.userId;
    if (!uid && r.tag) {
      uid = resolveTag(r.tag);
    }
    if (!uid) continue;
    const targetNodeId = hasProtocolSplit ? resolveTargetNodeId(r, protocolNodeMap) : nodeId;
    if (!nodeUserIdsMap.has(targetNodeId)) nodeUserIdsMap.set(targetNodeId, new Set());
    nodeUserIdsMap.get(targetNodeId).add(uid);
    // 累加流量字节数
    if (!nodeUserTrafficMap.has(targetNodeId)) nodeUserTrafficMap.set(targetNodeId, new Map());
    const userTraffic = nodeUserTrafficMap.get(targetNodeId);
    userTraffic.set(uid, (userTraffic.get(uid) || 0) + (r.value || 0));
  }

  // 兼容旧格式：若本轮无协议信息，则对双协议伙伴继续镜像在线人数，避免升级窗口期显示为 0
  if (!hasProtocolSplit && peerNodes.length > 0) {
    const reporterUsers = nodeUserIdsMap.get(nodeId) || new Set();
    const reporterTraffic = nodeUserTrafficMap.get(nodeId) || new Map();
    for (const peer of peerNodes) {
      nodeUserIdsMap.set(peer.id, new Set(reporterUsers));
      nodeUserTrafficMap.set(peer.id, new Map(reporterTraffic));
    }
  }

  // 更新节点在线信息（滑动窗口：最近 N 秒内有流量的用户都算在线）
  const trackedNodes = [node, ...peerNodes];
  for (const n of trackedNodes) {
    const currentUsers = nodeUserIdsMap.get(n.id) || new Set();
    if (!_nodeUserLastSeen.has(n.id)) _nodeUserLastSeen.set(n.id, new Map());
    const lastSeen = _nodeUserLastSeen.get(n.id);
    // 更新本次有流量的用户的最后活跃时间
    for (const uid of currentUsers) lastSeen.set(uid, now);
    // 清理过期用户
    for (const [uid, ts] of lastSeen) {
      if (now - ts > ONLINE_USER_WINDOW_MS) lastSeen.delete(uid);
    }
    // 窗口内所有活跃用户
    const windowUsers = new Set(lastSeen.keys());
    cache.nodeUsers.set(n.id, windowUsers);
    cache.nodeUpdatedAt.set(n.id, now);
    upsertOnlineNodeCount(cache, n.id, n.name, windowUsers.size);
  }

  pruneStaleOnlineNodeEntries(cache, now);

  // 并发多节点观察（仅记审计日志，不自动封禁）
  trackConcurrentNodeUsage(nodeUserIdsMap, nodeUserTrafficMap, now);

  // 根据各节点最新在线集合重建总在线用户，避免“有更新时只增不减”
  rebuildOnlineUsersFromNodeMap(cache);
  _onlineCache.summary = { online: cache.total, nodes: cache.nodes.length };
  _onlineCache.ts = now;
}

/**
 * 统一处理 Agent 上报数据
 * 供 agent-ws.js 调用，集中所有节点状态更新、流量保存、通知等逻辑
 */
function updateFromAgentReport(nodeId, reportData) {
  const reportStartedAt = Date.now();
  const { xrayAlive, hysteriaAlive, cnReachable, ipv6Reachable, loadAvg, memUsage, diskUsage, trafficRecords } = reportData;
  const now = nowUtcIso();
  const nodeSnapshot = getNodeSnapshot();
  const node = nodeSnapshot.byId.get(nodeId) || db.getNodeById(nodeId);
  if (!node) return;
  const peerNodes = getPeerNodes(node);
  const routeCtx = { node, peerNodes, nodeSnapshot };
  // 共用 Agent 的同机节点也刷新上报时间，避免 SS 节点显示长期未上报
  updatePeerLastReport(peerNodes, now);

  // 判定节点状态（根据协议选择检测目标）
  const isHy2Node = node.protocol === 'hy2';
  const serviceAlive = isHy2Node ? hysteriaAlive : xrayAlive;
  const serviceName = isHy2Node ? 'Hysteria' : 'Xray';
  let status, remark;
  if (!serviceAlive) {
    status = 0;
    remark = `🔴 ${serviceName} 离线 (Agent)`;
  } else if (cnReachable === false || cnReachable === 0) {
    status = 0;
    remark = '🧱 疑似被墙 (Agent)';
  } else if (node.remark && node.remark.includes('零流量')) {
    // 被零流量巡检标记为疑似被墙的节点，不能仅凭 Agent 上报恢复
    // 需要有实际用户流量才能解除（由 checkSuddenZeroTraffic 的清理逻辑处理）
    // 但如果本次上报带有流量记录，说明有用户在用，可以恢复
    const hasTraffic = trafficRecords && trafficRecords.length > 0 && trafficRecords.some(r => r.value > 0);
    if (hasTraffic) {
      status = 1;
      remark = '';
    } else {
      status = 0;
      remark = node.remark; // 保持原有的被墙标记
    }
  } else {
    status = 1;
    remark = '';
  }

  // ─── IPv6 连通性检测 ───
  const ipv6FailKey = `ipv6_${nodeId}`;
  const prevIpv6Fail = _nodeFailCount.get(ipv6FailKey) || 0;
  if (status === 1 && (ipv6Reachable === false || ipv6Reachable === 0)) {
    const newIpv6Fail = prevIpv6Fail + 1;
    _nodeFailCount.set(ipv6FailKey, newIpv6Fail);
    remark = remark ? `${remark} | 🌐 IPv6 不通` : '🌐 IPv6 不通';
    if (newIpv6Fail === 3) {
      bufferSystemAuditLog('node_ipv6_down', `${node.name}: IPv6 连通性异常（连续3次）`);
      notify.ops(`🌐 <b>IPv6 连通性异常</b>\n节点: ${node.name}\nIPv4 正常，但 IPv6 不通\nSS 用户可能受影响`);
    }
  } else if (ipv6Reachable === true || ipv6Reachable === 1) {
    if (prevIpv6Fail >= 3) {
      bufferSystemAuditLog('node_ipv6_recovered', `${node.name}: IPv6 恢复正常`);
      notify.ops(`✅ <b>IPv6 恢复</b>\n节点: ${node.name}`);
    }
    _nodeFailCount.set(ipv6FailKey, 0);
  }

  // 防抖：连续失败计数，达到阈值才通知掉线
  const FAIL_THRESHOLD = 3;
  const prevFailCount = _nodeFailCount.get(nodeId) || 0;

  if (status === 0) {
    // 失败计数 +1
    const newFailCount = prevFailCount + 1;
    _nodeFailCount.set(nodeId, newFailCount);

    if (newFailCount === FAIL_THRESHOLD) {
      // 达到阈值，触发掉线通知
      logger.info({ nodeId, nodeName: node.name, failThreshold: FAIL_THRESHOLD, remark }, '[Agent] 节点连续失败达到阈值');
      bufferSystemAuditLog(remark.includes('被墙') ? 'node_blocked' : 'node_xray_down', `${node.name}: ${remark}（连续${FAIL_THRESHOLD}次）`);

      if (remark.includes('被墙')) {
        notify.nodeBlocked(node.name, '需手动处理');
      } else if (!serviceAlive) {
        // 服务离线：尝试自动重启（从 DB 读取配置）
        const { autoRestartEnabled, maxRestarts } = getAutoRestartSettings();
        const restartCount = (_xrayRestartCount.get(nodeId) || 0) + 1;
        _xrayRestartCount.set(nodeId, restartCount);
        const agentWs = require('./agent-ws');
        const restartCmd = isHy2Node ? 'restart_hysteria' : 'restart_xray';
        if (autoRestartEnabled && restartCount <= maxRestarts && agentWs.isAgentOnline(nodeId)) {
          agentWs.sendCommand(nodeId, { type: restartCmd }).catch(() => {});
          bufferSystemAuditLog('xray_auto_restart', `自动重启 ${serviceName} (${restartCount}/${maxRestarts}): ${node.name}`);
          notify.ops(`🔄 <b>${serviceName} 自动重启</b>\n节点: ${node.name}\n第 ${restartCount} 次尝试`);
          // 重置失败计数，等下一轮 Agent 上报确认是否恢复
          _nodeFailCount.set(nodeId, 0);
        } else {
          // 超过最大重启次数、未启用或 Agent 不在线，通知管理员
          notify.nodeDown(node.name + ' ' + remark + (restartCount > 1 ? `（已自动重启${restartCount - 1}次未恢复）` : ''));
        }
      } else {
        notify.nodeDown(node.name + ' ' + remark);
      }
    } else if (newFailCount < FAIL_THRESHOLD) {
      // 未达阈值，静默，不更新数据库状态
      logger.info({ nodeId, nodeName: node.name, newFailCount, failThreshold: FAIL_THRESHOLD }, '[Agent] 节点检测失败，未达通知阈值');
      // 保存 agent 上报时间但不改状态
      try { db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?').run(now, nodeId); } catch (err) {
        logger.debug({ err, nodeId }, '保存 Agent 上报时间失败，已忽略');
      }
      // 保存流量 & 检测超标
      if (trafficRecords && trafficRecords.length > 0) {
        const saveStartedAt = Date.now();
        saveTrafficRecords(nodeId, trafficRecords, routeCtx);
        logSlowHealthStep('saveTrafficRecords', saveStartedAt, { nodeId, records: trafficRecords.length });
      }
      const onlineCacheStartedAt = Date.now();
      updateOnlineCache(nodeId, trafficRecords || [], routeCtx);
      logSlowHealthStep('updateOnlineCache', onlineCacheStartedAt, { nodeId, records: trafficRecords?.length || 0 });
      const trafficCheckStartedAt = Date.now();
      checkTrafficExceed();
      logSlowHealthStep('checkTrafficExceed', trafficCheckStartedAt, { nodeId });
      logSlowHealthStep('updateFromAgentReport', reportStartedAt, { nodeId, records: trafficRecords?.length || 0, status });
      return; // 提前返回，不更新节点为离线
    }
    // newFailCount > FAIL_THRESHOLD: 已经通知过了，静默更新状态即可
  } else {
    // 恢复在线：清零计数
    if (prevFailCount >= FAIL_THRESHOLD || !node.is_active) {
      // 之前判定过掉线 或 数据库中仍为离线（panel重启后计数丢失的情况）
      logger.info({ nodeId, nodeName: node.name }, '[Agent] 节点恢复在线');
      bufferSystemAuditLog('node_recovered', `${node.name} 恢复在线`);
      if (shouldNotifyNodeRecovery(node, reportStartedAt)) {
        notify.nodeUp(node.name);
      }
    }
    _nodeFailCount.set(nodeId, 0);
    _xrayRestartCount.delete(nodeId);
  }

  // 更新节点状态
  db.updateNode(nodeId, {
    is_active: status,
    remark,
    last_check: toSqlUtc(now),
  });
  // 同机双协议节点镜像状态（用于 IPv6 SS 节点展示）
  mirrorPeerState(peerNodes, status, remark, now);

  // 保存 agent 上报时间
  try {
    db.getDb().prepare('UPDATE nodes SET agent_last_report = ? WHERE id = ?').run(now, nodeId);
  } catch (err) {
    logger.debug({ err, nodeId }, '更新节点 Agent 上报时间失败，已忽略');
  }

  // 手动节点：连续失败自动移除
  if (node.is_manual) {
    const nextFailCount = status === 0 ? ((node.fail_count || 0) + 1) : 0;
    db.updateNode(nodeId, { fail_count: nextFailCount });
    if (status === 0 && nextFailCount >= 3) {
      const detail = `${node.name} (${node.host}:${node.port}) 连续 ${nextFailCount} 次检测失败，已自动移除`;
      logger.info({ nodeId, nodeName: node.name, detail }, '[Agent] 手动节点自动移除');
      bufferSystemAuditLog('node_auto_remove_manual', detail);
      db.deleteNode(nodeId);
      // notify already imported at top
      notifySend(`🗑️ <b>手动节点已自动移除</b>\n节点: ${node.name}\n地址: ${node.host}:${node.port}\n原因: 连续 ${nextFailCount} 次检测失败 (${remark})\n时间: ${formatDateTimeInTimeZone(new Date(), 'Asia/Shanghai', true)}`).catch(() => {});
      return;
    }
  }

  // 保存流量记录
  if (trafficRecords && trafficRecords.length > 0) {
    const saveStartedAt = Date.now();
    saveTrafficRecords(nodeId, trafficRecords, routeCtx);
    logSlowHealthStep('saveTrafficRecords', saveStartedAt, { nodeId, records: trafficRecords.length });
  }
  // 更新在线用户缓存（即使无流量记录也要刷新，保证可实时降为 0）
  const onlineCacheStartedAt = Date.now();
  updateOnlineCache(nodeId, trafficRecords || [], routeCtx);
  logSlowHealthStep('updateOnlineCache', onlineCacheStartedAt, { nodeId, records: trafficRecords?.length || 0 });

  // 流量超标检测
  const trafficCheckStartedAt = Date.now();
  checkTrafficExceed();
  logSlowHealthStep('checkTrafficExceed', trafficCheckStartedAt, { nodeId });

  // 资源阈值告警
  const resourceCheckStartedAt = Date.now();
  checkResourceThresholds(nodeId, node.name, { diskUsage, memUsage, loadAvg });
  logSlowHealthStep('checkResourceThresholds', resourceCheckStartedAt, { nodeId });
  logSlowHealthStep('updateFromAgentReport', reportStartedAt, { nodeId, records: trafficRecords?.length || 0, status });
}

// ─── 零流量疑似被墙检测 ───
const {PersistentSet} = require('../../workers/persistent-map');
const _zeroTrafficNotified = process.env.WORKERS_RUNTIME ? new PersistentSet('health-zero') : new Set(); // 已通知的 nodeId，避免重复

function startZeroTrafficWatch() {
  const INTERVAL = 60 * 60 * 1000; // 每小时检查一次
  setInterval(() => checkZeroTrafficNodes(), INTERVAL).unref();
  // 启动 10 分钟后首次检查
  setTimeout(() => checkZeroTrafficNodes(), 10 * 60 * 1000).unref();
}

/** Notify once per active node with no traffic in the current two-day window. */
function checkZeroTrafficNodes() {
  const nodes = db.getAllNodes().filter(n => n.is_active);
  if (!nodes.length) return;

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const stmt = db.getDb().prepare(
    'SELECT COALESCE(SUM(uplink + downlink), 0) as total FROM traffic_daily WHERE node_id = ? AND date IN (?, ?)'
  );

  for (const node of nodes) {
    const { total } = stmt.get(node.id, today, yesterday);
    if (total > 0) {
      _zeroTrafficNotified.delete(node.id);
      continue;
    }
    if (_zeroTrafficNotified.has(node.id)) continue;
    _zeroTrafficNotified.add(node.id);

    logger.info({ nodeId: node.id, nodeName: node.name }, '节点24小时零流量，疑似被墙');
    bufferSystemAuditLog('node_zero_traffic', `${node.name}: 24小时零流量，疑似被墙`);

    {
      notify.ops(`🧱 <b>疑似被墙（24h零流量）</b>\n节点: ${node.name}\n请在 Ulzix 控制台检查实例与网络`);
    }
  }
}

// ─── 定时巡检：agent_last_report 超时的节点标记为离线 ───
const STALE_AGENT_THRESHOLD_MS = Math.max(60000, parseInt(process.env.STALE_AGENT_THRESHOLD_MS || '180000', 10) || 180000); // 默认 3 分钟

function startStaleAgentWatch() {
  const INTERVAL = 60000; // 每分钟检查一次
  setInterval(() => checkStaleAgents(), INTERVAL).unref();
  // 启动 90 秒后首次检查（给 Agent 重连的时间）
  setTimeout(() => checkStaleAgents(), 90000).unref();
}

function checkStaleAgents() {
  const agentWs = require('./agent-ws');
  const now = Date.now();
  const nodes = db.getAllNodes().filter(n => n.is_active);
  for (const node of nodes) {
    // 如果 Agent WebSocket 当前在线，跳过
    if (agentWs.isAgentOnline(node.id)) continue;
    // 同机伙伴节点有 Agent 在线也跳过（双协议共享 Agent）
    const peers = getPeerNodes(node);
    if (peers.some(p => agentWs.isAgentOnline(p.id))) continue;

    const lastReport = node.agent_last_report ? new Date(node.agent_last_report).getTime() : 0;
    if (!lastReport || now - lastReport < STALE_AGENT_THRESHOLD_MS) continue;

    // 超时，标记离线
    const agoMin = Math.round((now - lastReport) / 60000);
    const remark = '🔴 Agent 失联';
    db.updateNode(node.id, { is_active: 0, remark, last_check: toSqlUtc() });
    mirrorPeerState(peers, 0, remark, nowUtcIso());
    bufferSystemAuditLog('agent_stale', `${node.name}: Agent 上报超时 (${agoMin}分钟)，标记离线`);
    notify.nodeDown(`${node.name} (Agent 失联 ${agoMin}分钟)`);
    logger.info({ nodeId: node.id, nodeName: node.name, agoMin }, '[巡检] 节点 Agent 上报超时，标记离线');
  }
}

// ─── 活跃节点突然零流量检测（疑似被墙快速发现） ───
// 如果一个在线节点在过去 N 小时内有流量，但最近 M 小时完全没有流量，标记为疑似被墙
const SUDDEN_ZERO_CHECK_INTERVAL = 10 * 60 * 1000; // 每 10 分钟检查一次
const SUDDEN_ZERO_SILENCE_HOURS = parseFloat(process.env.SUDDEN_ZERO_SILENCE_HOURS || '3') || 3;
const SUDDEN_ZERO_ACTIVE_HOURS = parseFloat(process.env.SUDDEN_ZERO_ACTIVE_HOURS || '12') || 12;
const _suddenZeroNotified = process.env.WORKERS_RUNTIME ? new PersistentSet('health-sudden-zero') : new Set();

function startSuddenZeroTrafficWatch() {
  setInterval(() => checkSuddenZeroTraffic(), SUDDEN_ZERO_CHECK_INTERVAL).unref();
  setTimeout(() => checkSuddenZeroTraffic(), 5 * 60 * 1000).unref();
}

/** Detect previously active machines that become silent and clear recovered alerts. */
function checkSuddenZeroTraffic() {
  try {
    const now = new Date();
    const silenceCutoff = new Date(now.getTime() - SUDDEN_ZERO_SILENCE_HOURS * 3600000).toISOString().replace('T', ' ').slice(0, 19);
    const activeCutoff = new Date(now.getTime() - SUDDEN_ZERO_ACTIVE_HOURS * 3600000).toISOString().replace('T', ' ').slice(0, 19);

    // 按物理机（ssh_host/host）分组，避免同机双协议重复告警
    const nodes = db.getAllNodes().filter(n => n.is_active);
    const hostGroups = new Map();
    for (const n of nodes) {
      const host = (n.ssh_host || n.host || '').trim();
      if (!host) continue;
      if (!hostGroups.has(host)) hostGroups.set(host, []);
      hostGroups.get(host).push(n);
    }

    const stmtRecent = db.getDb().prepare(
      'SELECT COALESCE(SUM(uplink + downlink), 0) as total FROM traffic WHERE node_id = ? AND recorded_at > ?'
    );
    const stmtActive = db.getDb().prepare(
      'SELECT COALESCE(SUM(uplink + downlink), 0) as total FROM traffic WHERE node_id = ? AND recorded_at > ? AND recorded_at <= ?'
    );

    for (const [host, group] of hostGroups) {
      if (_suddenZeroNotified.has(host)) continue;

      // 汇总该物理机所有节点的流量
      let recentTotal = 0, activeTotal = 0;
      for (const n of group) {
        recentTotal += stmtRecent.get(n.id, silenceCutoff).total;
        activeTotal += stmtActive.get(n.id, activeCutoff, silenceCutoff).total;
      }

      // 最近 N 小时零流量，但之前 M 小时有流量（说明之前是活跃的）
      if (recentTotal === 0 && activeTotal > 1048576) { // 之前至少 1MB 流量
        _suddenZeroNotified.add(host);
        const names = group.map(n => n.name).join(', ');
        const prevMb = (activeTotal / 1048576).toFixed(1);

        for (const n of group) {
          db.updateNode(n.id, { is_active: 0, remark: '🧱 疑似被墙 (零流量)', last_check: toSqlUtc() });
        }

        bufferSystemAuditLog('node_sudden_zero', `${names}: ${SUDDEN_ZERO_SILENCE_HOURS}h 零流量（此前 ${prevMb}MB），疑似被墙`);
        notify.ops(`🧱 <b>疑似被墙（突然零流量）</b>\n节点: ${names}\n主机: ${host}\n静默: ${SUDDEN_ZERO_SILENCE_HOURS} 小时\n此前流量: ${prevMb} MB`);
        logger.info({ host, names, silenceHours: SUDDEN_ZERO_SILENCE_HOURS, prevMb }, '[巡检] 活跃节点突然零流量，疑似被墙');


      }
    }

    // 清理已恢复的节点（有新流量了）
    for (const host of _suddenZeroNotified) {
      const group = hostGroups.get(host);
      if (!group) { _suddenZeroNotified.delete(host); continue; }
      let recent = 0;
      for (const n of group) recent += stmtRecent.get(n.id, silenceCutoff).total;
      if (recent > 0) _suddenZeroNotified.delete(host);
    }
  } catch (e) {
    logger.error({ err: e }, '突然零流量检测失败');
  }
}

// 节点被删除时清理相关内存状态，防止条目残留
function cleanupNodeState(nodeId) {
  if (!nodeId) return;
  try {
    _nodeFailCount.delete(nodeId);
    _nodeFailCount.delete(`ipv6_${nodeId}`);
    _nodeUserLastSeen.delete(nodeId);
    // 清理资源告警缓存（key 形如 nodeId_disk / nodeId_mem 等）
    for (const k of _resourceAlertCache.keys()) {
      if (typeof k === 'string' && k.startsWith(`${nodeId}_`)) {
        _resourceAlertCache.delete(k);
      }
    }
    // 清理在线缓存中该节点条目
    if (_onlineCache.full?.nodes) {
      const idx = _onlineCache.full.nodes.findIndex(n => n.nodeId === nodeId);
      if (idx >= 0) _onlineCache.full.nodes.splice(idx, 1);
      _onlineCache.full.nodeUsers?.delete(nodeId);
      _onlineCache.full.nodeUpdatedAt?.delete(nodeId);
    }
  } catch (err) {
    logger.debug({ err, nodeId }, '清理节点内存状态失败，已忽略');
  }
}

module.exports = { checkZeroTrafficNodes, checkSuddenZeroTraffic, checkStaleAgents, flushBufferedHealthWrites, checkPort, getOnlineCache, updateFromAgentReport, getPeerNodes, mirrorPeerState, startZeroTrafficWatch, startStaleAgentWatch, startSuddenZeroTrafficWatch, cleanupNodeState };
