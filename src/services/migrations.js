/**
 * 数据库迁移脚本（从 initTables 中拆出）
 * 所有 ALTER TABLE / 数据回填 / 历史清理逻辑集中在此
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('./logger');

function normalizeDuplicateNodeNames(db) {
  const rows = db.prepare('SELECT id, name FROM nodes ORDER BY name, created_at, id').all();
  const usedNames = new Set();
  const updateStmt = db.prepare('UPDATE nodes SET name = ? WHERE id = ?');

  for (const row of rows) {
    const baseName = String(row.name || '').trim();
    if (!baseName) continue;
    if (!usedNames.has(baseName)) {
      usedNames.add(baseName);
      continue;
    }

    let seq = 2;
    let nextName = `${baseName} (${seq})`;
    while (usedNames.has(nextName)) {
      seq += 1;
      nextName = `${baseName} (${seq})`;
    }

    updateStmt.run(nextName, row.id);
    usedNames.add(nextName);
    logger.warn({ nodeId: row.id, from: baseName, to: nextName }, '检测到重复节点名称，已自动重命名');
  }
}

/** Apply missing SQLite schema changes and normalize legacy data during startup. */
function runMigrations(db) {
  // ─── nodes 表迁移 ───
  const cols = db.prepare("PRAGMA table_info(nodes)").all().map(c => c.name);
  if (!cols.includes('ulzix_order_id')) db.exec('ALTER TABLE nodes ADD COLUMN ulzix_order_id INTEGER');
  if (!cols.includes('socks5_host')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN socks5_host TEXT;
      ALTER TABLE nodes ADD COLUMN socks5_port INTEGER DEFAULT 1080;
      ALTER TABLE nodes ADD COLUMN socks5_user TEXT;
      ALTER TABLE nodes ADD COLUMN socks5_pass TEXT;
    `);
  }
  if (!cols.includes('min_level')) db.exec("ALTER TABLE nodes ADD COLUMN min_level INTEGER DEFAULT 0");
  if (!cols.includes('reality_private_key')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN reality_private_key TEXT;
      ALTER TABLE nodes ADD COLUMN reality_public_key TEXT;
      ALTER TABLE nodes ADD COLUMN reality_short_id TEXT;
      ALTER TABLE nodes ADD COLUMN sni TEXT DEFAULT 'www.microsoft.com';
    `);
  }
  if (!cols.includes('aws_instance_id')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN aws_instance_id TEXT;
      ALTER TABLE nodes ADD COLUMN aws_type TEXT DEFAULT 'ec2';
      ALTER TABLE nodes ADD COLUMN aws_region TEXT;
    `);
  }
  if (!cols.includes('aws_account_id')) db.exec("ALTER TABLE nodes ADD COLUMN aws_account_id INTEGER");
  if (!cols.includes('is_manual')) db.exec("ALTER TABLE nodes ADD COLUMN is_manual INTEGER DEFAULT 0");
  if (!cols.includes('fail_count')) db.exec("ALTER TABLE nodes ADD COLUMN fail_count INTEGER DEFAULT 0");
  if (!cols.includes('agent_last_report')) db.exec("ALTER TABLE nodes ADD COLUMN agent_last_report TEXT");
  if (!cols.includes('agent_token')) {
    db.exec("ALTER TABLE nodes ADD COLUMN agent_token TEXT");
    const existingNodes = db.prepare('SELECT id FROM nodes').all();
    const updateStmt = db.prepare('UPDATE nodes SET agent_token = ? WHERE id = ?');
    for (const n of existingNodes) updateStmt.run(uuidv4(), n.id);
  }
  if (!cols.includes('hy2_port')) {
    db.exec(`
      ALTER TABLE nodes ADD COLUMN hy2_port INTEGER;
      ALTER TABLE nodes ADD COLUMN hy2_obfs TEXT;
      ALTER TABLE nodes ADD COLUMN hy2_sni TEXT DEFAULT 'bing.com';
      ALTER TABLE nodes ADD COLUMN hy2_up_mbps INTEGER DEFAULT 100;
      ALTER TABLE nodes ADD COLUMN hy2_down_mbps INTEGER DEFAULT 100;
      ALTER TABLE nodes ADD COLUMN hy2_stats_secret TEXT;
    `);
  }
  if (!cols.includes('traffic_cap')) db.exec("ALTER TABLE nodes ADD COLUMN traffic_cap INTEGER DEFAULT 0");
  if (!cols.includes('traffic_rate')) db.exec("ALTER TABLE nodes ADD COLUMN traffic_rate REAL DEFAULT 1.0");
  if (!cols.includes('group_name')) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN group_name TEXT DEFAULT ''"); } catch (err) { logger.debug({ err }, '迁移 group_name 失败'); }
  }
  if (!cols.includes('tags')) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN tags TEXT DEFAULT ''"); } catch (err) { logger.debug({ err }, '迁移 tags 失败'); }
  }
  if (!cols.includes('ss_method')) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN ss_method TEXT DEFAULT 'aes-256-gcm'"); } catch (err) { logger.debug({ err }, '迁移 ss_method 失败'); }
  }
  if (!cols.includes('ss_password')) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN ss_password TEXT"); } catch (err) { logger.debug({ err }, '迁移 ss_password 失败'); }
  }
  if (!cols.includes('ip_version')) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN ip_version INTEGER DEFAULT 4"); } catch (err) { logger.debug({ err }, '迁移 ip_version 失败'); }
  }
  if (cols.includes('is_donation')) {
    try { db.exec("UPDATE nodes SET is_donation = 0 WHERE is_donation IS NOT NULL AND is_donation != 0"); } catch (err) { logger.debug({ err }, '迁移 is_donation 失败'); }
  }
  try {
    normalizeDuplicateNodeNames(db);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name)');
  } catch (err) {
    logger.error({ err }, '创建节点名称唯一索引失败');
  }

  // ─── users 表迁移 ───
  const userColsPre = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!userColsPre.includes('telegram_id')) {
    db.exec("ALTER TABLE users ADD COLUMN telegram_id INTEGER");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL");
  }
  if (!userColsPre.includes('tg_bind_token')) db.exec("ALTER TABLE users ADD COLUMN tg_bind_token TEXT");
  if (!userColsPre.includes('auth_type')) db.exec("ALTER TABLE users ADD COLUMN auth_type TEXT DEFAULT 'email'");
  if (!userColsPre.includes('password_hash')) db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  if (!userColsPre.includes('is_frozen')) db.exec("ALTER TABLE users ADD COLUMN is_frozen INTEGER DEFAULT 0");
  if (!userColsPre.includes('freeze_reason')) db.exec("ALTER TABLE users ADD COLUMN freeze_reason TEXT DEFAULT NULL");
  if (!userColsPre.includes('traffic_limit')) db.exec("ALTER TABLE users ADD COLUMN traffic_limit INTEGER DEFAULT 0");
  if (!userColsPre.includes('last_token_reset')) db.exec("ALTER TABLE users ADD COLUMN last_token_reset TEXT DEFAULT '2000-01-01'");
  if (!userColsPre.includes('expires_at')) {
    try { db.exec("ALTER TABLE users ADD COLUMN expires_at TEXT"); } catch (err) { logger.debug({ err }, '迁移 expires_at 失败'); }
  }
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at)"); } catch (err) { logger.debug({ err }, '创建 expires_at 索引失败'); }
  if (userColsPre.includes('is_donor')) {
    try { db.exec("UPDATE users SET is_donor = 0 WHERE is_donor IS NOT NULL AND is_donor != 0"); } catch (err) { logger.debug({ err }, '迁移 is_donor 失败'); }
  }

  // ─── users 表去掉 nodeloc_id 列 ───
  if (userColsPre.includes('nodeloc_id')) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        CREATE TABLE users_new (
          id INTEGER PRIMARY KEY, auth_type TEXT DEFAULT 'email', username TEXT NOT NULL, name TEXT,
          avatar_url TEXT, trust_level INTEGER DEFAULT 0, email TEXT, password_hash TEXT,
          sub_token TEXT UNIQUE NOT NULL, is_admin INTEGER DEFAULT 0, is_blocked INTEGER DEFAULT 0,
          is_frozen INTEGER DEFAULT 0, traffic_limit INTEGER DEFAULT 0, max_devices INTEGER DEFAULT 3,
          created_at TEXT DEFAULT (datetime('now')), last_login TEXT, telegram_id INTEGER,
          last_token_reset TEXT DEFAULT '2000-01-01', expires_at TEXT, freeze_reason TEXT DEFAULT NULL
        )
      `);
      db.exec(`INSERT INTO users_new (id, auth_type, username, name, avatar_url, trust_level, email, password_hash, sub_token, is_admin, is_blocked, is_frozen, traffic_limit, max_devices, created_at, last_login, telegram_id, last_token_reset, expires_at, freeze_reason)
        SELECT id, auth_type, username, name, avatar_url, trust_level, email, password_hash, sub_token, is_admin, is_blocked, is_frozen, traffic_limit, max_devices, created_at, last_login, telegram_id, last_token_reset, expires_at, freeze_reason FROM users`);
      db.exec("DROP TABLE users");
      db.exec("ALTER TABLE users_new RENAME TO users");
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_username ON users(username)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login)");
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id) WHERE telegram_id IS NOT NULL");
      db.exec("CREATE INDEX IF NOT EXISTS idx_users_expires_at ON users(expires_at)");
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }

  // ─── whitelist 表迁移 ───
  const wlCols = db.prepare("PRAGMA table_info(whitelist)").all().map(c => c.name);
  if (!wlCols.includes('user_id')) {
    db.exec("DROP TABLE IF EXISTS whitelist");
    db.exec(`CREATE TABLE whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )`);
  }

  // ─── traffic_daily 去掉 CASCADE ───
  const tdFk = db.prepare("PRAGMA foreign_key_list(traffic_daily)").all();
  if (tdFk.some(f => f.table === 'nodes' && f.on_delete === 'CASCADE')) {
    db.exec("PRAGMA foreign_keys=OFF");
    try {
      db.exec(`
        CREATE TABLE traffic_daily_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, node_id INTEGER,
          date TEXT NOT NULL, uplink INTEGER DEFAULT 0, downlink INTEGER DEFAULT 0,
          UNIQUE(user_id, node_id, date), FOREIGN KEY (user_id) REFERENCES users(id)
        );
        INSERT INTO traffic_daily_new SELECT * FROM traffic_daily;
        DROP TABLE traffic_daily;
        ALTER TABLE traffic_daily_new RENAME TO traffic_daily;
      `);
    } finally {
      db.exec("PRAGMA foreign_keys=ON");
    }
  }

  // ─── user_multi_node_observe_event 增加列 ───
  const umnoeColsRaw = db.prepare("PRAGMA table_info(user_multi_node_observe_event)").all().map(c => c.name);
  if (!umnoeColsRaw.includes('total_traffic_bytes')) {
    db.exec("ALTER TABLE user_multi_node_observe_event ADD COLUMN total_traffic_bytes INTEGER DEFAULT 0");
  }

  // ─── 历史清理 ───
  try { db.exec("DELETE FROM settings WHERE key LIKE 'donate_cfg_hash_%'"); } catch (err) { logger.debug({ err }, '清理 donate_cfg_hash 失败'); }

  // ─── 数据回填 ───
  try {
    const totalCount = db.prepare('SELECT COUNT(*) as c FROM traffic_user_total').get().c;
    if (totalCount === 0) {
      db.exec(`
        INSERT INTO traffic_user_total (user_id, total_up, total_down, updated_at)
        SELECT user_id, COALESCE(SUM(uplink), 0), COALESCE(SUM(downlink), 0), datetime('now')
        FROM traffic_daily GROUP BY user_id
      `);
    }
    db.exec('DELETE FROM traffic_user_total WHERE user_id NOT IN (SELECT id FROM users)');
  } catch (err) { logger.debug({ err }, '初始化 traffic_user_total 失败'); }

  try {
    const siteRow = db.prepare('SELECT total_up, total_down FROM traffic_site_total WHERE id = 1').get();
    if ((siteRow?.total_up || 0) + (siteRow?.total_down || 0) <= 0) {
      const sum = db.prepare('SELECT COALESCE(SUM(uplink), 0) as up, COALESCE(SUM(downlink), 0) as down FROM traffic_daily').get();
      if ((sum.up || 0) > 0 || (sum.down || 0) > 0) {
        db.prepare(`INSERT INTO traffic_site_total (id, total_up, total_down, updated_at) VALUES (1, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET total_up = excluded.total_up, total_down = excluded.total_down, updated_at = datetime('now')
        `).run(sum.up || 0, sum.down || 0);
      }
    }
  } catch (err) { logger.debug({ err }, '初始化 traffic_site_total 失败'); }
}

module.exports = { runMigrations };
