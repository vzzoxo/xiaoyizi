let _getDb;

function init(deps) {
  _getDb = deps.getDb;
}

function addDiagnosis(nodeId, diagInfo) {
  return _getDb().prepare("INSERT INTO ops_diagnosis (node_id, diag_info, created_at) VALUES (?, ?, datetime('now'))").run(nodeId, diagInfo);
}

function updateDiagnosis(id, fields) {
  const allowed = ['status','ai_analysis','fix_commands','fix_result','resolved_at'];
  const safe = Object.fromEntries(Object.entries(fields).filter(([k]) => allowed.includes(k)));
  if (Object.keys(safe).length === 0) return;
  const sets = Object.keys(safe).map(k => `${k} = ?`).join(', ');
  _getDb().prepare(`UPDATE ops_diagnosis SET ${sets} WHERE id = ?`).run(...Object.values(safe), id);
}

function getDiagnosis(id) {
  return _getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id WHERE d.id = ?').get(id);
}

function getAllDiagnoses(limit = 20) {
  return _getDb().prepare('SELECT d.*, n.name as node_name, n.host FROM ops_diagnosis d JOIN nodes n ON d.node_id = n.id ORDER BY d.created_at DESC LIMIT ?').all(limit);
}

// AI 运营日记
function addDiaryEntry(content, mood = '', category = 'ops') {
  return _getDb().prepare(
    "INSERT INTO ops_diary (content, mood, category, created_at) VALUES (?, ?, ?, datetime('now'))"
  ).run(content, mood, category);
}

function getDiaryEntries(limit = 50, offset = 0) {
  const total = _getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const rows = _getDb().prepare(
    'SELECT * FROM ops_diary ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset);
  return { rows, total, pages: Math.ceil(total / limit) };
}

function getDiaryStats() {
  const total = _getDb().prepare('SELECT COUNT(*) as c FROM ops_diary').get().c;
  const firstEntry = _getDb().prepare('SELECT created_at FROM ops_diary ORDER BY created_at ASC LIMIT 1').get();
  const todayCount = _getDb().prepare(
    "SELECT COUNT(*) as c FROM ops_diary WHERE date(created_at, '+8 hours') = date('now', '+8 hours')"
  ).get().c;
  return { total, todayCount, firstEntry: firstEntry?.created_at || null };
}

// 并发多节点观察（结构化事件）
function addUserMultiNodeObserveEvent(input = {}) {
  const userId = Number(input.userId || 0);
  const username = String(input.username || '').slice(0, 120);
  const nodeCount = Number(input.nodeCount || 0);
  const windowSeconds = Number(input.windowSeconds || 0);
  const totalTrafficBytes = Number(input.totalTrafficBytes || 0);
  const nodesSample = Array.isArray(input.nodesSample)
    ? input.nodesSample.map((x) => String(x)).join(',').slice(0, 300)
    : String(input.nodesSample || '').slice(0, 300);
  if (!userId || nodeCount <= 0) return;
  _getDb().prepare(`
    INSERT INTO user_multi_node_observe_event
      (user_id, username, node_count, nodes_sample, window_seconds, total_traffic_bytes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(userId, username, nodeCount, nodesSample, windowSeconds, totalTrafficBytes);
}

function getUserMultiNodeObserveOverview(hours = 24) {
  const h = Math.max(1, parseInt(hours, 10) || 24);
  return _getDb().prepare(`
    SELECT
      COUNT(*) as total_events,
      COUNT(DISTINCT user_id) as user_count,
      ROUND(COALESCE(AVG(node_count), 0), 2) as avg_node_count,
      SUM(CASE WHEN node_count >= 4 THEN 1 ELSE 0 END) as high_count,
      SUM(CASE WHEN node_count >= 2 AND node_count <= 3 THEN 1 ELSE 0 END) as mid_count,
      ROUND(COALESCE(AVG(total_traffic_bytes), 0), 0) as avg_traffic_bytes,
      COALESCE(MAX(total_traffic_bytes), 0) as max_traffic_bytes
    FROM user_multi_node_observe_event
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
  `).get(h) || {
    total_events: 0, user_count: 0, avg_node_count: 0, high_count: 0, mid_count: 0,
    avg_traffic_bytes: 0, max_traffic_bytes: 0,
  };
}

function getUserMultiNodeObserveEvents(hours = 24, limit = 20, offset = 0) {
  const h = Math.max(1, parseInt(hours, 10) || 24);
  const l = Math.max(1, parseInt(limit, 10) || 20);
  const o = Math.max(0, parseInt(offset, 10) || 0);
  const total = _getDb().prepare(`
    SELECT COUNT(*) as c
    FROM user_multi_node_observe_event
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
  `).get(h).c;
  const rows = _getDb().prepare(`
    SELECT id, user_id, username, node_count, nodes_sample, window_seconds, total_traffic_bytes, created_at
    FROM user_multi_node_observe_event
    WHERE created_at >= datetime('now', '-' || ? || ' hours')
    ORDER BY created_at DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(h, l, o);
  return { total, rows };
}

module.exports = {
  init,
  addDiagnosis, updateDiagnosis, getDiagnosis, getAllDiagnoses,
  addDiaryEntry, getDiaryEntries, getDiaryStats,
  addUserMultiNodeObserveEvent, getUserMultiNodeObserveOverview, getUserMultiNodeObserveEvents,
};
