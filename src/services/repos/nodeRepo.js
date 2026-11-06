const { v4: uuidv4 } = require('uuid');
const { encrypt, decrypt } = require('../../utils/crypto');

let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

// 解密节点敏感字段
function decryptNode(node) {
  if (!node) return node;
  node.ssh_password = decrypt(node.ssh_password);
  node.socks5_pass = decrypt(node.socks5_pass);
  node.reality_private_key = decrypt(node.reality_private_key);
  node.ss_password = decrypt(node.ss_password);
  node.hy2_stats_secret = decrypt(node.hy2_stats_secret);
  return node;
}

function getAllNodes(activeOnly = false) {
  const rows = activeOnly
    ? _getDb().prepare('SELECT * FROM nodes WHERE is_active = 1 ORDER BY region, name').all()
    : _getDb().prepare('SELECT * FROM nodes WHERE 1=1 ORDER BY is_active DESC, region, name').all();
  return rows.map(decryptNode);
}

function getNodeById(id) {
  return decryptNode(_getDb().prepare('SELECT * FROM nodes WHERE id = ?').get(id));
}

function getNodeByName(name) {
  return decryptNode(_getDb().prepare('SELECT * FROM nodes WHERE name = ?').get(String(name || '').trim()));
}

function getNodesByIds(ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => parseInt(id, 10)).filter(id => id > 0))];
  if (list.length === 0) return [];
  const placeholders = list.map(() => '?').join(', ');
  return _getDb().prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`).all(...list).map(decryptNode);
}

function addNode(node) {
  const stmt = _getDb().prepare(`
    INSERT INTO nodes (name, host, port, uuid, protocol, network, security, ssh_host, ssh_port, ssh_user, ssh_password, ssh_key_path, xray_config_path, socks5_host, socks5_port, socks5_user, socks5_pass, is_active, region, remark, is_manual, fail_count, agent_token, ip_version, ss_method, ss_password, hy2_port, hy2_obfs, hy2_sni, hy2_up_mbps, hy2_down_mbps, hy2_stats_secret)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    node.name, node.host, node.port, node.uuid,
    node.protocol || 'vless', node.network || 'tcp', node.security || 'none',
    node.ssh_host, node.ssh_port || 22, node.ssh_user || 'root',
    encrypt(node.ssh_password) || null, node.ssh_key_path,
    node.xray_config_path || '/usr/local/etc/xray/config.json',
    node.socks5_host || null, node.socks5_port || 1080,
    node.socks5_user || null, encrypt(node.socks5_pass) || null,
    node.is_active !== undefined ? node.is_active : 1,
    node.region, node.remark,
    node.is_manual ? 1 : 0,
    node.fail_count || 0,
    node.agent_token || uuidv4(),
    node.ip_version || 4,
    node.ss_method || null,
    encrypt(node.ss_password) || null,
    node.hy2_port || null,
    node.hy2_obfs || null,
    node.hy2_sni || null,
    node.hy2_up_mbps || null,
    node.hy2_down_mbps || null,
    encrypt(node.hy2_stats_secret) || null
  );
}

function updateNode(id, fields) {
  const allowed = ['ulzix_order_id','name','host','port','uuid','ssh_host','ssh_port','ssh_user','ssh_password','ssh_key_path','region','remark','is_active','last_check','last_rotated','socks5_host','socks5_port','socks5_user','socks5_pass','min_level','reality_private_key','reality_public_key','reality_short_id','sni','aws_instance_id','aws_type','aws_region','aws_account_id','is_manual','fail_count','agent_last_report','agent_token','group_name','tags','ss_method','ss_password','ip_version','hy2_port','hy2_obfs','hy2_sni','hy2_up_mbps','hy2_down_mbps','hy2_stats_secret','traffic_cap'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  // 敏感字段加密存储
  if (safe.ssh_password !== undefined) safe.ssh_password = encrypt(safe.ssh_password) || null;
  if (safe.socks5_pass !== undefined) safe.socks5_pass = encrypt(safe.socks5_pass) || null;
  if (safe.reality_private_key !== undefined) safe.reality_private_key = encrypt(safe.reality_private_key) || null;
  if (safe.ss_password !== undefined) safe.ss_password = encrypt(safe.ss_password) || null;
  if (safe.hy2_stats_secret !== undefined) safe.hy2_stats_secret = encrypt(safe.hy2_stats_secret) || null;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  const values = Object.values(safe);
  _getDb().prepare(`UPDATE nodes SET ${sets} WHERE id = ?`).run(...values, id);
}

function deleteNode(id) {
  _getDb().prepare('DELETE FROM nodes WHERE id = ?').run(id);
}

function updateNodeAfterRotation(id, newUuid, newPort, protocol) {
  if (protocol === 'hy2') {
    // hy2 节点同时更新 hy2_port
    _getDb().prepare(`
      UPDATE nodes SET uuid = ?, port = ?, hy2_port = ?, last_rotated = datetime('now') WHERE id = ?
    `).run(newUuid, newPort, newPort, id);
  } else {
    _getDb().prepare(`
      UPDATE nodes SET uuid = ?, port = ?, last_rotated = datetime('now') WHERE id = ?
    `).run(newUuid, newPort, id);
  }
}

module.exports = {
  init,
  getAllNodes, getNodeById, getNodeByName, getNodesByIds, addNode, updateNode, deleteNode, updateNodeAfterRotation
};
