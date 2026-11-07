const db = require('./database');
const { randomPort } = require('../utils/vless');
const { syncNodeConfig } = require('./deploy');
const { notify } = require('./notify');
const logger = require('./logger');
const { dateKeyInTimeZone } = require('../utils/time');
const { getGroupResetConfig, getGroupLabel } = require('../utils/userGroup');

// 核心轮换：端口 + 按组UUID重置 + 同步配置（排除手动节点）
async function rotateCore() {
  const allActiveNodes = db.getAllNodes(true);
  const nodes = allActiveNodes.filter(n => !n.is_manual);
  logger.info({ activeNodes: allActiveNodes.length, rotateNodes: nodes.length }, '[轮换开始] 自动节点轮换启动');

  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');

  // 端口轮换周期检查
  const portDays = parseInt(db.getSetting('port_rotate_days'));
  const portRotateDays = Number.isFinite(portDays) ? portDays : 1;
  let portRotated = false;
  if (portRotateDays > 0) {
    const lastPortDate = db.getSetting('last_port_rotate') || '2000-01-01';
    const daysSincePort = Math.floor((new Date(today).getTime() - new Date(lastPortDate).getTime()) / 86400000);
    if (daysSincePort >= portRotateDays) {
      for (const node of nodes) {
        const portMin = parseInt(db.getSetting('rotate_port_min')) || 10000;
        const portMax = parseInt(db.getSetting('rotate_port_max')) || 60000;
        db.updateNodeAfterRotation(node.id, node.uuid, randomPort(portMin, portMax), node.protocol);
      }
      db.setSetting('last_port_rotate', today);
      portRotated = true;
    }
  }

  const nodeIds = nodes.map(n => n.id);
  const cfg = getGroupResetConfig(db);
  let uuidCount = 0;
  const uuidDetails = {};

  for (const g of cfg) {
    if (g.uuid_days <= 0) {
      uuidDetails[g.level] = 'skip';
      continue;
    }
    const lastKey = `group_${g.level}_last_uuid_rotate`;
    const lastDate = db.getSetting(lastKey) || '2000-01-01';
    const daysSince = Math.floor((new Date(today).getTime() - new Date(lastDate).getTime()) / 86400000);
    if (daysSince >= g.uuid_days) {
      const count = db.rotateUserNodeUuidsByNodeIdsAndLevels(nodeIds, [g.level]);
      uuidCount += count;
      uuidDetails[g.level] = count;
      db.setSetting(lastKey, today);
    } else {
      uuidDetails[g.level] = 'wait';
    }
  }

  logger.info({ uuidCount, uuidDetails }, '[轮换] 按组UUID重置完成');

  let success = 0, failed = 0;
  for (const node of nodes) {
    const updatedNode = db.getNodeById(node.id);
    const ok = await syncNodeConfig(updatedNode, db).catch(() => false);
    if (ok) success++; else failed++;
  }
  return { success, failed, uuidCount, portRotated };
}

/**
 * 检查是否需要重置该用户的订阅 token
 */
function shouldResetToken(user, today, subDays) {
  if (subDays <= 0) return false;
  const lastReset = user.last_token_reset || '2000-01-01';
  const daysSince = Math.floor((new Date(today).getTime() - new Date(lastReset).getTime()) / 86400000);
  return daysSince >= subDays;
}

// 自动轮换（cron 调用）：核心 + 分级 token 轮换
async function rotateAll() {
  const core = await rotateCore();

  const today = dateKeyInTimeZone(new Date(), 'Asia/Shanghai');
  const users = db.getAllUsers();
  const cfg = getGroupResetConfig(db);
  let tokenCount = 0;
  const resetDetails = {};
  for (const g of cfg) resetDetails[g.level] = 0;
  let skipCount = 0;

  for (const user of users) {
    const level = Math.min(Math.max(user.trust_level || 0, 0), 3);
    const subDays = cfg[level].sub_days;
    if (shouldResetToken(user, today, subDays)) {
      db.resetSubToken(user.id);
      db.getDb().prepare("UPDATE users SET last_token_reset = ? WHERE id = ?").run(today, user.id);
      tokenCount++;
      resetDetails[level]++;
    } else if (subDays <= 0) {
      skipCount++;
    }
  }

  const detailStr = cfg.map(g => `${getGroupLabel(g.level)}:${resetDetails[g.level]}`).join(' ');
  logger.info({ tokenCount, resetDetails, skipCount }, '[轮换] 订阅 token 重置完成');

  const result = { ...core, tokenCount };
  logger.info({ syncSuccess: core.success, syncFailed: core.failed, uuidCount: core.uuidCount, tokenCount }, '[轮换完成] 自动轮换结束');
  db.addAuditLog(null, 'auto_rotate', `自动轮换完成 同步成功 ${core.success}，失败 ${core.failed}，端口 ${core.portRotated ? '已轮换' : '已跳过'} UUID:${core.uuidCount} 订阅:${tokenCount} (${detailStr} 免:${skipCount})`, 'system');
  notify.rotate(result);
  return result;
}

// 手动轮换：只换端口+UUID，不换 token
async function rotateManual() {
  const core = await rotateCore();
  const result = { ...core, tokenCount: 0 };
  logger.info({ syncSuccess: core.success, syncFailed: core.failed, uuidCount: core.uuidCount }, '[手动轮换] 执行完成');
  db.addAuditLog(null, 'manual_rotate', `手动轮换完成 同步成功 ${core.success}，失败 ${core.failed}，端口 ${core.portRotated ? '已轮换' : '已跳过'} UUID:${core.uuidCount}`, 'system');
  notify.rotate(result);
  return result;
}

module.exports = { rotateAll, rotateManual };
