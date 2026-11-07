const crypto = require('crypto');
const { toSqlUtc } = require('../../utils/time');
const logger = require('../logger');

let _getDb, _getSetting, _addAuditLog, _ensureUserHasAllNodeUuids;

function init(deps) {
  _getDb = deps.getDb;
  _getSetting = deps.getSetting;
  _addAuditLog = deps.addAuditLog;
  _ensureUserHasAllNodeUuids = deps.ensureUserHasAllNodeUuids;
}

function genSubToken() {
  // 24 字节 = 192 位熵，base64url 编码后 32 字符。
  // 因 token 在 URL 中暴露，使用更高熵以防暴力预测。
  return crypto.randomBytes(24).toString('base64url');
}

function getUserBySubToken(token) {
  return _getDb().prepare('SELECT * FROM users WHERE sub_token = ? AND is_blocked = 0 AND is_frozen = 0').get(token);
}

function getUserById(id) {
  return _getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
}

function getUsersByIds(ids = []) {
  const list = [...new Set((Array.isArray(ids) ? ids : []).map(id => parseInt(id, 10)).filter(id => id > 0))];
  if (list.length === 0) return [];
  const placeholders = list.map(() => '?').join(', ');
  return _getDb().prepare(`SELECT * FROM users WHERE id IN (${placeholders})`).all(...list);
}

function getUserByUsername(username) {
  const name = String(username || '').trim();
  if (!name) return null;
  return _getDb().prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(name) || null;
}

function getUserByEmail(email) {
  const value = String(email || '').trim().toLowerCase();
  if (!value) return null;
  return _getDb().prepare('SELECT * FROM users WHERE LOWER(email) = ?').get(value) || null;
}

function insertEmailUser({ username, email, passwordHash, displayName }) {
  const cleanUsername = String(username || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanUsername || !cleanEmail || !passwordHash) {
    throw new Error('invalid input');
  }
  const subToken = genSubToken();
  const userCount = _getDb().prepare('SELECT COUNT(*) as count FROM users').get().count;
  const isAdmin = userCount === 0 ? 1 : 0;
  const defaultLimit = parseInt(_getSetting('default_traffic_limit'));
  const trafficLimit = isNaN(defaultLimit) ? -1 : defaultLimit;
  const name = String(displayName || cleanUsername).trim();

  _getDb().prepare(`
    INSERT INTO users (auth_type, username, name, trust_level, email, password_hash, sub_token, is_admin, traffic_limit, last_login)
    VALUES ('email', ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'))
  `).run(cleanUsername, name, cleanEmail, passwordHash, subToken, isAdmin, trafficLimit);

  return {
    newUser: _getDb().prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(cleanEmail),
    isAdmin,
    cleanUsername,
    cleanEmail,
  };
}

function createEmailUser({ username, email, passwordHash, displayName, ip = 'system' }) {
  const { newUser, isAdmin, cleanUsername, cleanEmail } = insertEmailUser({ username, email, passwordHash, displayName });
  if (isAdmin) logger.info({ username: cleanUsername }, '首位用户已自动设为管理员');

  _addAuditLog(null, 'user_register_email', `邮箱注册: ${cleanUsername}${isAdmin ? ' (管理员)' : ''}`, ip);

  try {
    const { notify } = require('../notify');
    notify.userRegister(cleanUsername, { username: cleanUsername, email: cleanEmail });
  } catch (err) {
    logger.debug({ err, username: cleanUsername }, '发送用户注册通知失败，已忽略');
  }

  _ensureUserHasAllNodeUuids(newUser.id);
  return newUser;
}

function createInvitedEmailUser({ username, email, passwordHash, displayName, inviteCode, ip = 'system' }) {
  const cleanInviteCode = String(inviteCode || '').trim().toUpperCase();
  if (!cleanInviteCode) {
    throw new Error('invite required');
  }

  const tx = _getDb().transaction(() => {
    const invite = _getDb().prepare(`
      SELECT *
      FROM invite_codes
      WHERE code = ?
        AND used_at IS NULL
        AND expires_at > datetime('now')
      LIMIT 1
    `).get(cleanInviteCode);
    if (!invite) {
      throw new Error('invalid invite');
    }

    const { newUser, isAdmin, cleanUsername, cleanEmail } = insertEmailUser({ username, email, passwordHash, displayName });
    const mark = _getDb().prepare(`
      UPDATE invite_codes
      SET used_at = datetime('now'), used_by_user_id = ?
      WHERE id = ?
        AND used_at IS NULL
    `).run(newUser.id, invite.id);
    if (mark.changes !== 1) {
      throw new Error('invite already used');
    }

    return { newUser, isAdmin, cleanUsername, cleanEmail, inviterUserId: invite.inviter_user_id };
  });

  const { newUser, isAdmin, cleanUsername, cleanEmail, inviterUserId } = tx();
  if (isAdmin) logger.info({ username: cleanUsername }, '首位用户已自动设为管理员');

  _addAuditLog(null, 'user_register_email', `邮箱注册: ${cleanUsername}${isAdmin ? ' (管理员)' : ''} 邀请人:${inviterUserId}`, ip);

  try {
    const { notify } = require('../notify');
    notify.userRegister(cleanUsername, { username: cleanUsername, email: cleanEmail });
  } catch (err) {
    logger.debug({ err, username: cleanUsername }, '发送用户注册通知失败，已忽略');
  }

  _ensureUserHasAllNodeUuids(newUser.id);
  return newUser;
}

function getUserCount() {
  return _getDb().prepare('SELECT COUNT(*) as count FROM users').get().count;
}

function getAllUsers() {
  return _getDb().prepare(`
    SELECT u.*, COALESCE(tut.total_up, 0) + COALESCE(tut.total_down, 0) as total_traffic
    FROM users u
    LEFT JOIN traffic_user_total tut ON u.id = tut.user_id
    ORDER BY total_traffic DESC
  `).all();
}

// 转义 SQLite LIKE 模式中的特殊字符，防止用户输入的 % 或 _ 被解释为通配符
function escapeLikePattern(s) {
  return String(s == null ? '' : s).replace(/[\\%_]/g, '\\$&');
}

/** Return sorted users and a matching count, escaping literal LIKE search characters. */
function getAllUsersPaged(limit = 20, offset = 0, search = '', sortBy = 'total_traffic', sortDir = 'DESC') {
  const escSearch = escapeLikePattern(search);
  const where = search ? "WHERE (u.username LIKE '%' || @search || '%' ESCAPE '\\' OR u.name LIKE '%' || @search || '%' ESCAPE '\\')" : '';
  const allowedSorts = {
    id: 'u.id', username: 'u.username', trust_level: 'u.trust_level',
    total_traffic: 'total_traffic', expires_at: 'u.expires_at', last_login: 'u.last_login'
  };
  const orderCol = allowedSorts[sortBy] || 'total_traffic';
  const dir = sortDir === 'ASC' ? 'ASC' : 'DESC';
  const rows = _getDb().prepare(`
    SELECT u.*, COALESCE(tut.total_up, 0) + COALESCE(tut.total_down, 0) as total_traffic
    FROM users u
    LEFT JOIN traffic_user_total tut ON u.id = tut.user_id
    ${where}
    ORDER BY ${orderCol} ${dir}
    LIMIT @limit OFFSET @offset
  `).all({ limit, offset, search: escSearch });
  const total = _getDb().prepare(`SELECT COUNT(*) as c FROM users u ${where}`).get({ search: escSearch }).c;
  return { rows, total };
}

function blockUser(id, blocked) {
  _getDb().prepare('UPDATE users SET is_blocked = ? WHERE id = ?').run(blocked ? 1 : 0, id);
}

function setUserTrafficLimit(id, limitBytes) {
  _getDb().prepare('UPDATE users SET traffic_limit = ? WHERE id = ?').run(limitBytes, id);
}

function isTrafficExceeded(userId) {
  const user = getUserById(userId);
  if (!user || user.traffic_limit <= 0) return false;
  const traffic = _getDb().prepare(
    'SELECT COALESCE(total_up, 0) + COALESCE(total_down, 0) as total FROM traffic_user_total WHERE user_id = ?'
  ).get(userId);
  return (traffic?.total || 0) >= user.traffic_limit;
}

function freezeUser(id, reason = 'manual') {
  _getDb().prepare('UPDATE users SET is_frozen = 1, freeze_reason = ? WHERE id = ?').run(reason, id);
  _getDb().prepare('DELETE FROM user_node_uuid WHERE user_id = ?').run(id);
}

function unfreezeUser(id) {
  const result = _getDb().prepare('UPDATE users SET is_frozen = 0, freeze_reason = NULL WHERE id = ?').run(id);
  if (result.changes > 0) {
    _ensureUserHasAllNodeUuids(id);
  }
}

function autoFreezeInactiveUsers(days = 15) {
  const cutoff = toSqlUtc(new Date(Date.now() - days * 86400000));
  const users = _getDb().prepare(
    "SELECT id, username FROM users WHERE is_frozen = 0 AND is_blocked = 0 AND is_admin = 0 AND last_login < ?"
  ).all(cutoff);
  for (const u of users) {
    freezeUser(u.id, 'inactive');
  }
  return users;
}

// 冻结超过 days 天未在 TG 签到的已绑定 TG 用户（未绑定 TG 的用户跳过）
function autoFreezeNoCheckinUsers(days = 30) {
  const cutoffDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const users = _getDb().prepare(`
    SELECT u.id, u.username,
      (SELECT MAX(date) FROM tg_checkin WHERE user_id = u.id) AS last_checkin
    FROM users u
    WHERE u.is_frozen = 0
      AND u.is_blocked = 0
      AND u.is_admin = 0
      AND u.telegram_id IS NOT NULL
      AND u.telegram_id != ''
  `).all().filter(u => !u.last_checkin || u.last_checkin < cutoffDate);
  for (const u of users) {
    freezeUser(u.id, 'tg_inactive');
  }
  return users;
}

function resetSubToken(userId) {
  const newToken = genSubToken();
  _getDb().prepare('UPDATE users SET sub_token = ? WHERE id = ?').run(newToken, userId);
  return newToken;
}

// Sprint 6: 用户到期时间
function setUserExpiry(userId, expiresAt) {
  _getDb().prepare('UPDATE users SET expires_at = ? WHERE id = ?').run(expiresAt || null, userId);
}

function autoFreezeExpiredUsers() {
  const now = toSqlUtc();
  const users = _getDb().prepare(
    "SELECT id, username FROM users WHERE is_frozen = 0 AND is_blocked = 0 AND is_admin = 0 AND expires_at IS NOT NULL AND expires_at < ?"
  ).all(now);
  for (const u of users) {
    freezeUser(u.id, 'expired');
  }
  return users;
}

module.exports = {
  init,
  getUserBySubToken, getUserById, getUsersByIds, getUserByUsername, getUserByEmail, createEmailUser, createInvitedEmailUser, getUserCount,
  getAllUsers, getAllUsersPaged, blockUser, setUserTrafficLimit,
  isTrafficExceeded, freezeUser, unfreezeUser, autoFreezeInactiveUsers, autoFreezeNoCheckinUsers, resetSubToken,
  setUserExpiry, autoFreezeExpiredUsers
};
