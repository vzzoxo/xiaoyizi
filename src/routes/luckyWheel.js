const express = require('express');
const db = require('../services/database');
const { gameLuckyLimiter } = require('../middleware/rateLimit');
const { verifyTgInitData, weightedRandom, weekKey, shiftIsoDate, TG_INITDATA_MAX_AGE_SEC, getUserByTelegramId, tryUnfreezeAfterTraffic } = require('../utils/tgGame');

const router = express.Router();

const LUCKY_WHEEL_PRIZES = [
  { label: '头奖 88GB', gb: 88, weight: 1, tone: 'jackpot' },
  { label: '大奖 50GB', gb: 50, weight: 4, tone: 'grand' },
  { label: '豪礼 30GB', gb: 30, weight: 8, tone: 'major' },
  { label: '好运 20GB', gb: 20, weight: 14, tone: 'major' },
  { label: '小爆 10GB', gb: 10, weight: 22, tone: 'good' },
  { label: '稳赚 10GB', gb: 10, weight: 20, tone: 'good' },
  { label: '保底 10GB', gb: 10, weight: 18, tone: 'base' },
  { label: '幸运 10GB', gb: 10, weight: 13, tone: 'base' },
];

function getNextLuckyOpenLabel(date = new Date()) {
  const nextMonday = shiftIsoDate(weekKey(date), 7);
  const [, month, day] = nextMonday.split('-').map(Number);
  return `${month}月${day}日`;
}

function getLuckyProfileByUser(user) {
  const wk = weekKey();
  const row = db.getDb().prepare('SELECT prize, amount FROM tg_lucky WHERE user_id = ? AND week = ?').get(user.id, wk);
  const trafficRow = db.getDb().prepare('SELECT COALESCE(total_up + total_down, 0) as total FROM traffic_user_total WHERE user_id = ?').get(user.id);
  const used = trafficRow ? trafficRow.total : 0;
  const remaining = user.traffic_limit < 0 ? -1 : Math.max(0, user.traffic_limit - used);
  const prizeGb = row ? +(row.amount / 1073741824).toFixed(2) : null;
  const prizeIndex = row ? LUCKY_WHEEL_PRIZES.findIndex((item) => item.label === row.prize) : null;

  return {
    week: wk,
    canSpin: !row,
    prizeLabel: row?.prize || '',
    prizeGb,
    prizeIndex: prizeIndex >= 0 ? prizeIndex : null,
    remainingGB: remaining < 0 ? -1 : +(remaining / 1073741824).toFixed(2),
    nextOpenLabel: getNextLuckyOpenLabel(),
    prizes: LUCKY_WHEEL_PRIZES,
  };
}

function applyLuckySpin(userId, wk, prize) {
  const d = db.getDb();
  const bytes = Math.round(prize.gb * 1073741824);
  const stmtUser = d.prepare('SELECT id, traffic_limit FROM users WHERE id = ?');
  const stmtInsert = d.prepare('INSERT OR IGNORE INTO tg_lucky (user_id, week, prize, amount) VALUES (?, ?, ?, ?)');
  const stmtExisting = d.prepare('SELECT prize, amount FROM tg_lucky WHERE user_id = ? AND week = ?');
  const stmtTraffic = d.prepare('UPDATE users SET traffic_limit = ? WHERE id = ?');

  return d.transaction(() => {
    const user = stmtUser.get(userId);
    if (!user) return { ok: false, error: '未绑定账号' };

    const inserted = stmtInsert.run(userId, wk, prize.label, bytes);
    if (!inserted.changes) {
      const existing = stmtExisting.get(userId, wk);
      return {
        ok: false,
        error: `本周已经转过了\n你抽中的是 ${existing?.prize || '本周奖励'}`,
      };
    }

    if (user.traffic_limit >= 0) {
      stmtTraffic.run(Math.max(0, user.traffic_limit + bytes), userId);
    }

    return { ok: true, prize };
  })();
}

router.get('/lucky-wheel', (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://web.telegram.org https://desktop.telegram.org"
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.render('lucky-wheel', {
    nonce: res.locals.nonce || '',
    assetVersion: String(Date.now()),
  });
});

router.post('/api/lucky-profile', express.json(), (req, res) => {
  const tgUser = verifyTgInitData(req.body?.initData || '');
  if (!tgUser) return res.json({ ok: false, error: '验证失败' });

  const user = getUserByTelegramId(db, tgUser.id);
  if (!user) return res.json({ ok: false, error: '未绑定账号' });

  return res.json({ ok: true, ...getLuckyProfileByUser(user) });
});

router.post('/api/lucky-spin', express.json(), (req, res, next) => {
  const tgUser = verifyTgInitData(req.body?.initData || '');
  if (tgUser?.id != null) req.body.tgUserId = String(tgUser.id);
  req.tgUser = tgUser;
  next();
}, gameLuckyLimiter, (req, res) => {
  const tgUser = req.tgUser || null;
  if (!tgUser) return res.json({ ok: false, error: '验证失败' });

  const user = getUserByTelegramId(db, tgUser.id);
  if (!user) return res.json({ ok: false, error: '未绑定账号' });

  const prize = weightedRandom(LUCKY_WHEEL_PRIZES);
  const result = applyLuckySpin(user.id, weekKey(), prize);
  if (result.ok) tryUnfreezeAfterTraffic(db, user.id);
  const profile = getLuckyProfileByUser(user);
  if (!result.ok) {
    return res.json({ ...result, ...profile });
  }

  return res.json({
    ok: true,
    prizeLabel: result.prize.label,
    prizeGb: result.prize.gb,
    prizeIndex: LUCKY_WHEEL_PRIZES.findIndex((item) => item.label === result.prize.label),
    ...profile,
  });
});

module.exports = router;
module.exports._test = {
  verifyTgInitData,
  weekKey,
  getNextLuckyOpenLabel,
  getLuckyProfileByUser,
  applyLuckySpin,
  LUCKY_WHEEL_PRIZES,
  TG_INITDATA_MAX_AGE_SEC,
};
