const Database = process.env.WORKERS_RUNTIME ? require('../../workers/sqlite').Database : require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { toSqlUtc } = require('../utils/time');

// 子模块
const userRepo = require('./repos/userRepo');
const nodeRepo = require('./repos/nodeRepo');
const trafficRepo = require('./repos/trafficRepo');
const settingsRepo = require('./repos/settingsRepo');
const uuidRepo = require('./repos/uuidRepo');
const awsRepo = require('./repos/awsRepo');
const subAccessRepo = require('./repos/subAccessRepo');
const opsRepo = require('./repos/opsRepo');
const metricsRepo = require('./repos/metricsRepo');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'panel.db');

let db;

const INVITE_CODE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function getDb() {
  if (!db) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initTables();
    initRepos();
  }
  return db;
}

function closeDb() {
  if (!db) return;
  try {
    db.close();
  } finally {
    db = null;
  }
}

function reopenDb() {
  closeDb();
  return getDb();
}

function initRepos() {
  const deps = { getDb };
  settingsRepo.init(deps);
  nodeRepo.init(deps);
  // userRepo 需要额外依赖
  userRepo.init({
    getDb,
    getSetting: settingsRepo.getSetting,
    addAuditLog: settingsRepo.addAuditLog,
    ensureUserHasAllNodeUuids: uuidRepo.ensureUserHasAllNodeUuids,
  });
  uuidRepo.init({
    getDb,
    getAllUsers: userRepo.getAllUsers,
    getAllNodes: nodeRepo.getAllNodes,
  });
  trafficRepo.init({ getDb, getUserById: userRepo.getUserById });
  awsRepo.init(deps);
  subAccessRepo.init({ getDb, getUserById: userRepo.getUserById });
  opsRepo.init(deps);
  metricsRepo.init(deps);
}

function initTables() {
  db.exec(`
    -- 用户表
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      auth_type TEXT DEFAULT 'email',
      username TEXT NOT NULL,
      name TEXT,
      avatar_url TEXT,
      trust_level INTEGER DEFAULT 0,
      email TEXT,
      password_hash TEXT,
      sub_token TEXT UNIQUE NOT NULL,
      is_admin INTEGER DEFAULT 0,
      is_blocked INTEGER DEFAULT 0,
      is_frozen INTEGER DEFAULT 0,
      traffic_limit INTEGER DEFAULT 0,
      max_devices INTEGER DEFAULT 3,
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    );

    -- 白名单表
    CREATE TABLE IF NOT EXISTS whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    );

    -- 节点表
    CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      protocol TEXT DEFAULT 'vless',
      network TEXT DEFAULT 'tcp',
      security TEXT DEFAULT 'none',
      ssh_host TEXT,
      ssh_port INTEGER DEFAULT 22,
      ssh_user TEXT DEFAULT 'root',
      ssh_password TEXT,
      ssh_key_path TEXT,
      xray_config_path TEXT DEFAULT '/usr/local/etc/xray/config.json',
      socks5_host TEXT,
      socks5_port INTEGER DEFAULT 1080,
      socks5_user TEXT,
      socks5_pass TEXT,
      is_active INTEGER DEFAULT 1,
      region TEXT,
      remark TEXT,
      last_rotated TEXT,
      last_check TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    -- 审计日志
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      detail TEXT,
      ip TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 系统配置
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- 用户-节点 UUID 映射表
    CREATE TABLE IF NOT EXISTS user_node_uuid (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      uuid TEXT NOT NULL,
      UNIQUE(user_id, node_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    -- 流量统计表
    CREATE TABLE IF NOT EXISTS traffic (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      uplink INTEGER DEFAULT 0,
      downlink INTEGER DEFAULT 0,
      recorded_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    );

    -- 流量汇总表（按天）
    CREATE TABLE IF NOT EXISTS traffic_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER,
      date TEXT NOT NULL,
      uplink INTEGER DEFAULT 0,
      downlink INTEGER DEFAULT 0,
      UNIQUE(user_id, node_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 用户累计流量汇总表（总量，避免用户列表实时聚合）
    CREATE TABLE IF NOT EXISTS traffic_user_total (
      user_id INTEGER PRIMARY KEY,
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 全站累计流量汇总表（永久累计，不依赖 traffic_daily 保留周期）
    CREATE TABLE IF NOT EXISTS traffic_site_total (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      total_up INTEGER DEFAULT 0,
      total_down INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tg_checkin (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tg_lucky (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      week TEXT NOT NULL,
      prize TEXT NOT NULL,
      amount INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, week),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tg_rps_daily (
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      net_gb REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tg_flip_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      date TEXT NOT NULL,
      card_index INTEGER NOT NULL,
      prize_label TEXT NOT NULL,
      amount_bytes INTEGER NOT NULL,
      amount_gb REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, date, card_index),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    -- 订阅拉取 IP 记录
    CREATE TABLE IF NOT EXISTS sub_access_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      ip TEXT NOT NULL,
      ua TEXT DEFAULT '',
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    -- 订阅访问事件（成功/拒绝全量事件流，用于风控统计）
    CREATE TABLE IF NOT EXISTS sub_access_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      token_prefix TEXT DEFAULT '',
      route TEXT DEFAULT 'sub',
      result TEXT NOT NULL DEFAULT 'allow',
      reason TEXT DEFAULT 'ok',
      ip TEXT DEFAULT '',
      ua TEXT DEFAULT '',
      client_type TEXT DEFAULT '',
      http_status INTEGER DEFAULT 200,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS invite_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      inviter_user_id INTEGER NOT NULL,
      code TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      used_by_user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (inviter_user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
    );
  `);

  // 运维诊断表
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_diagnosis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      diag_info TEXT,
      ai_analysis TEXT,
      fix_commands TEXT,
      fix_result TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )
  `);

  // 并发多节点观察（结构化事件）
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_multi_node_observe_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      username TEXT DEFAULT '',
      node_count INTEGER NOT NULL DEFAULT 0,
      nodes_sample TEXT DEFAULT '',
      window_seconds INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // 索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traffic_daily_user_date ON traffic_daily(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_traffic_daily_node ON traffic_daily(node_id);
    CREATE INDEX IF NOT EXISTS idx_traffic_daily_date ON traffic_daily(date);
    CREATE INDEX IF NOT EXISTS idx_traffic_user_total_traffic ON traffic_user_total(total_up, total_down);
    CREATE INDEX IF NOT EXISTS idx_tg_checkin_user_date ON tg_checkin(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_tg_lucky_user_week ON tg_lucky(user_id, week);
    CREATE INDEX IF NOT EXISTS idx_tg_rps_daily_date ON tg_rps_daily(date);
    CREATE INDEX IF NOT EXISTS idx_tg_flip_daily_user_date ON tg_flip_daily(user_id, date);
    CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_sub_access_log_user_time ON sub_access_log(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sub_access_log_time_user_ip ON sub_access_log(created_at, user_id, ip);
    CREATE INDEX IF NOT EXISTS idx_sub_access_event_user_time ON sub_access_event(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_sub_access_event_time_result ON sub_access_event(created_at, result);
    CREATE INDEX IF NOT EXISTS idx_sub_access_event_reason_time ON sub_access_event(reason, created_at);
    CREATE INDEX IF NOT EXISTS idx_sub_access_event_token_time ON sub_access_event(token_prefix, created_at);
    CREATE INDEX IF NOT EXISTS idx_invite_codes_inviter_time ON invite_codes(inviter_user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_invite_codes_expires_at ON invite_codes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_user_node_uuid_node ON user_node_uuid(node_id);
    CREATE INDEX IF NOT EXISTS idx_user_node_uuid_user ON user_node_uuid(user_id);
    CREATE INDEX IF NOT EXISTS idx_traffic_user_node ON traffic(user_id, node_id);
    CREATE INDEX IF NOT EXISTS idx_traffic_node_recorded ON traffic(node_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_last_login ON users(last_login);
  `);

  // 初始化默认配置
  const upsert = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  upsert.run('announcement', '');
  upsert.run('rotate_cron', '0 3 * * *');
  upsert.run('rotate_port_min', '10000');
  upsert.run('rotate_port_max', '60000');
  upsert.run('max_users', '0');
  upsert.run('registration_open', 'true');
  upsert.run('default_traffic_limit', '21474836480');
  upsert.run('agent_token', uuidv4());
  upsert.run('traffic_raw_retention_days', '30');
  upsert.run('traffic_daily_retention_days', '120');
  upsert.run('smtp_enabled', 'false');
  upsert.run('smtp_host', '');
  upsert.run('smtp_port', '587');
  upsert.run('smtp_secure', 'false');
  upsert.run('smtp_user', '');
  upsert.run('smtp_pass', '');
  upsert.run('smtp_from_name', 'VLESS Panel');
  upsert.run('smtp_from_email', '');

  db.prepare(`
    INSERT OR IGNORE INTO traffic_site_total (id, total_up, total_down, updated_at)
    VALUES (1, 0, 0, datetime('now'))
  `).run();

  // 注册白名单表
  db.exec(`
    CREATE TABLE IF NOT EXISTS register_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // 节点定向白名单（允许指定用户访问指定节点）
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_access_whitelist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      node_id INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(user_id, node_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )
  `);

  // 迁移（拆分到 migrations.js）
  require('./migrations').runMigrations(db);
}

function generateInviteCodeValue() {
  return crypto.randomBytes(6).toString('base64url').toUpperCase();
}

function cleanupExpiredInviteCodes() {
  const d = getDb();
  const expired = d.prepare(`
    DELETE FROM invite_codes
    WHERE used_at IS NULL
      AND expires_at <= datetime('now')
  `).run();
  return { deletedExpired: expired.changes };
}

function getLatestInviteCodeByUser(userId) {
  return getDb().prepare(`
    SELECT *
    FROM invite_codes
    WHERE inviter_user_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) || null;
}

function getActiveInviteCodeByUser(userId) {
  return getDb().prepare(`
    SELECT *
    FROM invite_codes
    WHERE inviter_user_id = ?
      AND used_at IS NULL
      AND expires_at > datetime('now')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId) || null;
}

function getInviteGenerateStatusByUser(userId, isAdmin = false) {
  const latest = getLatestInviteCodeByUser(userId);
  const activeInvite = getActiveInviteCodeByUser(userId);
  if (!latest) {
    return {
      activeInvite: null,
      latestInvite: null,
      canGenerate: true,
      nextGenerateAt: null,
    };
  }

  if (isAdmin) {
    return {
      activeInvite,
      latestInvite: latest,
      canGenerate: true,
      nextGenerateAt: null,
    };
  }

  const createdAtMs = new Date(`${String(latest.created_at).replace(' ', 'T')}Z`).getTime();
  const nextGenerateAt = Number.isFinite(createdAtMs)
    ? toSqlUtc(new Date(createdAtMs + INVITE_CODE_TTL_MS))
    : null;
  const canGenerate = !nextGenerateAt || (Date.now() >= new Date(`${nextGenerateAt.replace(' ', 'T')}Z`).getTime());
  return {
    activeInvite,
    latestInvite: latest,
    canGenerate,
    nextGenerateAt,
  };
}

function getUsableInviteCode(code) {
  const value = String(code || '').trim().toUpperCase();
  if (!value) return null;
  return getDb().prepare(`
    SELECT *
    FROM invite_codes
    WHERE code = ?
      AND used_at IS NULL
      AND expires_at > datetime('now')
    LIMIT 1
  `).get(value) || null;
}

function getInviteRelationsPaged(limit = 20, offset = 0, search = '', status = 'all') {
  const q = String(search || '').trim().toLowerCase();
  const filters = [];
  if (q) {
    filters.push(`(
      LOWER(ic.code) LIKE '%' || @search || '%'
      OR LOWER(COALESCE(inviter.username, '')) LIKE '%' || @search || '%'
      OR LOWER(COALESCE(inviter.email, '')) LIKE '%' || @search || '%'
      OR LOWER(COALESCE(invitee.username, '')) LIKE '%' || @search || '%'
      OR LOWER(COALESCE(invitee.email, '')) LIKE '%' || @search || '%'
    )`);
  }
  if (status === 'used') {
    filters.push('ic.used_at IS NOT NULL');
  } else if (status === 'active') {
    filters.push("ic.used_at IS NULL AND ic.expires_at > datetime('now')");
  } else if (status === 'expired') {
    filters.push("ic.used_at IS NULL AND ic.expires_at <= datetime('now')");
  }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';

  const rows = getDb().prepare(`
    SELECT
      ic.id,
      ic.code,
      ic.created_at,
      ic.expires_at,
      ic.used_at,
      ic.inviter_user_id,
      ic.used_by_user_id,
      inviter.username AS inviter_username,
      inviter.email AS inviter_email,
      invitee.username AS invitee_username,
      invitee.email AS invitee_email,
      CASE
        WHEN ic.used_at IS NOT NULL THEN 'used'
        WHEN ic.expires_at <= datetime('now') THEN 'expired'
        ELSE 'active'
      END AS status
    FROM invite_codes ic
    LEFT JOIN users inviter ON inviter.id = ic.inviter_user_id
    LEFT JOIN users invitee ON invitee.id = ic.used_by_user_id
    ${where}
    ORDER BY ic.created_at DESC, ic.id DESC
    LIMIT @limit OFFSET @offset
  `).all({ limit, offset, search: q });

  const total = getDb().prepare(`
    SELECT COUNT(*) AS c
    FROM invite_codes ic
    LEFT JOIN users inviter ON inviter.id = ic.inviter_user_id
    LEFT JOIN users invitee ON invitee.id = ic.used_by_user_id
    ${where}
  `).get({ search: q }).c;

  return { rows, total };
}

function generateInviteCodeForUser(userId, isAdmin = false) {
  const d = getDb();
  const latest = getLatestInviteCodeByUser(userId);
  const now = Date.now();

  if (!isAdmin && latest) {
    const createdAtMs = new Date(`${String(latest.created_at).replace(' ', 'T')}Z`).getTime();
    if (Number.isFinite(createdAtMs) && (now - createdAtMs) < INVITE_CODE_TTL_MS) {
      const activeInvite = latest.used_at ? null : getActiveInviteCodeByUser(userId);
      return {
        ok: false,
        reason: 'daily_limit',
        invite: activeInvite || latest,
        nextGenerateAt: toSqlUtc(new Date(createdAtMs + INVITE_CODE_TTL_MS)),
      };
    }
  }

  let code = '';
  let generated = false;
  let attempts = 0;
  while (attempts < 5) {
    code = generateInviteCodeValue();
    const exists = d.prepare('SELECT 1 FROM invite_codes WHERE code = ? LIMIT 1').get(code);
    if (!exists) {
      generated = true;
      break;
    }
    attempts++;
  }
  if (!generated) {
    throw new Error('failed to generate invite code');
  }

  const expiresAt = isAdmin ? '9999-12-31 23:59:59' : toSqlUtc(new Date(now + INVITE_CODE_TTL_MS));
  d.prepare(`
    INSERT INTO invite_codes (inviter_user_id, code, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, code, expiresAt);

  return {
    ok: true,
    invite: getActiveInviteCodeByUser(userId),
    nextGenerateAt: isAdmin ? null : expiresAt,
  };
}

function callWithDb(fn) {
  return (...args) => {
    getDb();
    return fn(...args);
  };
}

// 导出所有函数（向后兼容）
module.exports = {
  getDb,
  closeDb,
  reopenDb,
  // 用户
  getUserBySubToken: callWithDb((...a) => userRepo.getUserBySubToken(...a)),
  getUserById: callWithDb((...a) => userRepo.getUserById(...a)),
  getUsersByIds: callWithDb((...a) => userRepo.getUsersByIds(...a)),
  getUserByUsername: callWithDb((...a) => userRepo.getUserByUsername(...a)),
  getUserByEmail: callWithDb((...a) => userRepo.getUserByEmail(...a)),
  createEmailUser: callWithDb((...a) => userRepo.createEmailUser(...a)),
  createInvitedEmailUser: callWithDb((...a) => userRepo.createInvitedEmailUser(...a)),
  getUserCount: callWithDb((...a) => userRepo.getUserCount(...a)),
  getAllUsers: callWithDb((...a) => userRepo.getAllUsers(...a)),
  getAllUsersPaged: callWithDb((...a) => userRepo.getAllUsersPaged(...a)),
  blockUser: callWithDb((...a) => userRepo.blockUser(...a)),
  setUserTrafficLimit: callWithDb((...a) => userRepo.setUserTrafficLimit(...a)),
  isTrafficExceeded: callWithDb((...a) => userRepo.isTrafficExceeded(...a)),
  freezeUser: callWithDb((...a) => userRepo.freezeUser(...a)),
  unfreezeUser: callWithDb((...a) => userRepo.unfreezeUser(...a)),
  autoFreezeInactiveUsers: callWithDb((...a) => userRepo.autoFreezeInactiveUsers(...a)),
  autoFreezeNoCheckinUsers: callWithDb((...a) => userRepo.autoFreezeNoCheckinUsers(...a)),
  resetSubToken: callWithDb((...a) => userRepo.resetSubToken(...a)),
  setUserExpiry: callWithDb((...a) => userRepo.setUserExpiry(...a)),
  autoFreezeExpiredUsers: callWithDb((...a) => userRepo.autoFreezeExpiredUsers(...a)),
  // 节点
  getAllNodes: callWithDb((...a) => nodeRepo.getAllNodes(...a)),
  getNodeById: callWithDb((...a) => nodeRepo.getNodeById(...a)),
  getNodeByName: callWithDb((...a) => nodeRepo.getNodeByName(...a)),
  getNodesByIds: callWithDb((...a) => nodeRepo.getNodesByIds(...a)),
  addNode: callWithDb((...a) => nodeRepo.addNode(...a)),
  updateNode: callWithDb((...a) => nodeRepo.updateNode(...a)),
  deleteNode: callWithDb((...a) => nodeRepo.deleteNode(...a)),
  updateNodeAfterRotation: callWithDb((...a) => nodeRepo.updateNodeAfterRotation(...a)),
  // UUID
  getUserNodeUuid: callWithDb((...a) => uuidRepo.getUserNodeUuid(...a)),
  getUserAllNodeUuids: callWithDb((...a) => uuidRepo.getUserAllNodeUuids(...a)),
  getNodeAllUserUuids: callWithDb((...a) => uuidRepo.getNodeAllUserUuids(...a)),
  ensureAllUsersHaveUuid: callWithDb((...a) => uuidRepo.ensureAllUsersHaveUuid(...a)),
  ensureUserHasAllNodeUuids: callWithDb((...a) => uuidRepo.ensureUserHasAllNodeUuids(...a)),
  rotateAllUserNodeUuids: callWithDb((...a) => uuidRepo.rotateAllUserNodeUuids(...a)),
  rotateUserAllNodeUuids: callWithDb((...a) => uuidRepo.rotateUserAllNodeUuids(...a)),
  rotateUserNodeUuidsByNodeIds: callWithDb((...a) => uuidRepo.rotateUserNodeUuidsByNodeIds(...a)),
  rotateUserNodeUuidsByNodeIdsAndLevels: callWithDb((...a) => uuidRepo.rotateUserNodeUuidsByNodeIdsAndLevels(...a)),
  // 流量
  recordTraffic: callWithDb((...a) => trafficRepo.recordTraffic(...a)),
  getUserTraffic: callWithDb((...a) => trafficRepo.getUserTraffic(...a)),
  getHostTraffic: callWithDb((...a) => trafficRepo.getHostTraffic(...a)),
  getGlobalTraffic: callWithDb((...a) => trafficRepo.getGlobalTraffic(...a)),
  cleanupTrafficHistory: callWithDb((...a) => trafficRepo.cleanupTrafficHistory(...a)),
  getTodayTraffic: callWithDb((...a) => trafficRepo.getTodayTraffic(...a)),
  getUsersTrafficByRange: callWithDb((...a) => trafficRepo.getUsersTrafficByRange(...a)),
  getNodesTrafficByRange: callWithDb((...a) => trafficRepo.getNodesTrafficByRange(...a)),
  getTrafficTrend: callWithDb((...a) => trafficRepo.getTrafficTrend(...a)),
  getUserTrafficDaily: callWithDb((...a) => trafficRepo.getUserTrafficDaily(...a)),
  getUserTrafficDailyAgg: callWithDb((...a) => trafficRepo.getUserTrafficDailyAgg(...a)),
  // 设置 & 审计 & 白名单
  addAuditLog: callWithDb((...a) => settingsRepo.addAuditLog(...a)),
  getAuditLogs: callWithDb((...a) => settingsRepo.getAuditLogs(...a)),
  clearAuditLogs: callWithDb((...a) => settingsRepo.clearAuditLogs(...a)),
  getSetting: callWithDb((...a) => settingsRepo.getSetting(...a)),
  setSetting: callWithDb((...a) => settingsRepo.setSetting(...a)),
  // AWS
  getAwsAccounts: callWithDb((...a) => awsRepo.getAwsAccounts(...a)),
  getAwsAccountById: callWithDb((...a) => awsRepo.getAwsAccountById(...a)),
  addAwsAccount: callWithDb((...a) => awsRepo.addAwsAccount(...a)),
  updateAwsAccount: callWithDb((...a) => awsRepo.updateAwsAccount(...a)),
  deleteAwsAccount: callWithDb((...a) => awsRepo.deleteAwsAccount(...a)),
  // 订阅访问
  logSubAccess: callWithDb((...a) => subAccessRepo.logSubAccess(...a)),
  countDistinctSubAccessUas: callWithDb((...a) => subAccessRepo.countDistinctSubAccessUas(...a)),
  clearSubAccessWindow: callWithDb((...a) => subAccessRepo.clearSubAccessWindow(...a)),
  logSubAccessEvent: callWithDb((...a) => subAccessRepo.logSubAccessEvent(...a)),
  getSubAccessIPs: callWithDb((...a) => subAccessRepo.getSubAccessIPs(...a)),
  getSubAccessStats: callWithDb((...a) => subAccessRepo.getSubAccessStats(...a)),
  getSubEventOverview: callWithDb((...a) => subAccessRepo.getSubEventOverview(...a)),
  getSubAccessStatsV2: callWithDb((...a) => subAccessRepo.getSubAccessStatsV2(...a)),
  getSubAccessUserDetail: callWithDb((...a) => subAccessRepo.getSubAccessUserDetail(...a)),
  getSubAccessUserDetailV2: callWithDb((...a) => subAccessRepo.getSubAccessUserDetailV2(...a)),
  // 运维
  addDiagnosis: callWithDb((...a) => opsRepo.addDiagnosis(...a)),
  updateDiagnosis: callWithDb((...a) => opsRepo.updateDiagnosis(...a)),
  getDiagnosis: callWithDb((...a) => opsRepo.getDiagnosis(...a)),
  getAllDiagnoses: callWithDb((...a) => opsRepo.getAllDiagnoses(...a)),
  addDiaryEntry: callWithDb((...a) => opsRepo.addDiaryEntry(...a)),
  getDiaryEntries: callWithDb((...a) => opsRepo.getDiaryEntries(...a)),
  getDiaryStats: callWithDb((...a) => opsRepo.getDiaryStats(...a)),
  addUserMultiNodeObserveEvent: callWithDb((...a) => opsRepo.addUserMultiNodeObserveEvent(...a)),
  getUserMultiNodeObserveOverview: callWithDb((...a) => opsRepo.getUserMultiNodeObserveOverview(...a)),
  getUserMultiNodeObserveEvents: callWithDb((...a) => opsRepo.getUserMultiNodeObserveEvents(...a)),
  // 监控指标
  recordMetrics: callWithDb((...a) => metricsRepo.recordMetrics(...a)),
  getNodeMetrics: callWithDb((...a) => metricsRepo.getNodeMetrics(...a)),
  getLatestMetricsAllNodes: callWithDb((...a) => metricsRepo.getLatestMetricsAllNodes(...a)),
  cleanupMetrics: callWithDb((...a) => metricsRepo.cleanupMetrics(...a)),
  // 邀请码
  cleanupExpiredInviteCodes: callWithDb(cleanupExpiredInviteCodes),
  getLatestInviteCodeByUser: callWithDb(getLatestInviteCodeByUser),
  getActiveInviteCodeByUser: callWithDb(getActiveInviteCodeByUser),
  getInviteGenerateStatusByUser: callWithDb(getInviteGenerateStatusByUser),
  getUsableInviteCode: callWithDb(getUsableInviteCode),
  getInviteRelationsPaged: callWithDb(getInviteRelationsPaged),
  generateInviteCodeForUser: callWithDb(generateInviteCodeForUser),
};
