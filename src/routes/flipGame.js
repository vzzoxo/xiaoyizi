const express = require('express');
const db = require('../services/database');
const { gameFlipLimiter } = require('../middleware/rateLimit');
const { verifyTgInitData, today, weightedRandom, getUserByTelegramId, tryUnfreezeAfterTraffic } = require('../utils/tgGame');

const router = express.Router();

const DAILY_FLIP_LIMIT = 3;
const CARD_COUNT = 9;
const FLIP_PRIZES = [
  { label: '爆奖 +3GB', gb: 3, weight: 8 },
  { label: '好运 +2GB', gb: 2, weight: 16 },
  { label: '小奖 +1GB', gb: 1, weight: 24 },
  { label: '安慰奖 +0.5GB', gb: 0.5, weight: 20 },
  { label: '谢谢参与', gb: 0, weight: 20 },
  { label: '小失手 -0.5GB', gb: -0.5, weight: 12 },
];

function createSeededRandom(seedText) {
  let seed = 0;
  for (let i = 0; i < seedText.length; i++) {
    seed = ((seed * 31) + seedText.charCodeAt(i)) >>> 0;
  }
  return function rand() {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function getFlipProfileByUser(user) {
  const d = today();
  const row = db.getDb().prepare(`
    SELECT COUNT(*) as plays, COALESCE(SUM(amount_gb), 0) as net_gb
    FROM tg_flip_daily
    WHERE user_id = ? AND date = ?
  `).get(user.id, d);
  const records = db.getDb().prepare(`
    SELECT card_index, prize_label, amount_gb
    FROM tg_flip_daily
    WHERE user_id = ? AND date = ?
    ORDER BY id ASC
  `).all(user.id, d);
  const usedCards = records.map((r) => r.card_index);
  const trafficRow = db.getDb().prepare('SELECT COALESCE(total_up + total_down, 0) as total FROM traffic_user_total WHERE user_id = ?').get(user.id);
  const used = trafficRow ? trafficRow.total : 0;
  const remaining = user.traffic_limit < 0 ? -1 : Math.max(0, user.traffic_limit - used);

  let revealBoard = null;
  if ((row?.plays || 0) >= DAILY_FLIP_LIMIT) {
    const rand = createSeededRandom(`${user.id}:${d}:flip-board`);
    const board = new Array(CARD_COUNT).fill(null);
    for (const record of records) {
      board[record.card_index] = {
        label: record.prize_label,
        gb: record.amount_gb,
        actual: true,
      };
    }
    for (let i = 0; i < CARD_COUNT; i++) {
      if (board[i]) continue;
      const totalWeight = FLIP_PRIZES.reduce((sum, item) => sum + item.weight, 0);
      let roll = rand() * totalWeight;
      let picked = FLIP_PRIZES[FLIP_PRIZES.length - 1];
      for (const item of FLIP_PRIZES) {
        roll -= item.weight;
        if (roll <= 0) {
          picked = item;
          break;
        }
      }
      board[i] = {
        label: picked.label,
        gb: picked.gb,
        actual: false,
      };
    }
    revealBoard = board;
  }

  return {
    plays: row?.plays || 0,
    netGb: row?.net_gb || 0,
    playsLeft: DAILY_FLIP_LIMIT - (row?.plays || 0),
    remainingGB: remaining < 0 ? -1 : +(remaining / 1073741824).toFixed(2),
    usedCards,
    revealBoard,
  };
}

function applyFlipDraw(user, cardIndex, prize) {
  const d = db.getDb();
  const dateKey = today();
  const insertStmt = d.prepare(`
    INSERT INTO tg_flip_daily (user_id, date, card_index, prize_label, amount_bytes, amount_gb)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const profileStmt = d.prepare(`
    SELECT COUNT(*) as plays, COALESCE(SUM(amount_gb), 0) as net_gb
    FROM tg_flip_daily
    WHERE user_id = ? AND date = ?
  `);
  const cardStmt = d.prepare('SELECT card_index FROM tg_flip_daily WHERE user_id = ? AND date = ? ORDER BY id ASC');
  const trafficStmt = d.prepare('UPDATE users SET traffic_limit = ? WHERE id = ?');

  return d.transaction(() => {
    const profile = profileStmt.get(user.id, dateKey);
    if ((profile?.plays || 0) >= DAILY_FLIP_LIMIT) {
      const state = getFlipProfileByUser(user);
      return { ok: false, error: `今日翻卡次数已用完\n今天净收益 ${state.netGb > 0 ? '+' : ''}${state.netGb} GB`, ...state };
    }

    const usedCards = cardStmt.all(user.id, dateKey).map((r) => r.card_index);
    if (usedCards.includes(cardIndex)) {
      const state = getFlipProfileByUser(user);
      return { ok: false, error: '这张卡已经翻过了，换一张吧', ...state };
    }

    const amountBytes = Math.round(prize.gb * 1073741824);
    insertStmt.run(user.id, dateKey, cardIndex, prize.label, amountBytes, prize.gb);

    if (prize.gb !== 0 && user.traffic_limit >= 0) {
      trafficStmt.run(Math.max(0, user.traffic_limit + amountBytes), user.id);
    }

    return { ok: true, prize };
  })();
}

router.get('/flip-game', (req, res) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors https://web.telegram.org https://desktop.telegram.org"
  );
  res.render('flip-game', { nonce: res.locals.nonce || '' });
});

router.post('/api/flip-profile', express.json(), (req, res) => {
  const tgUser = verifyTgInitData(req.body?.initData || '');
  if (!tgUser) return res.json({ ok: false, error: '验证失败' });

  const user = getUserByTelegramId(db, tgUser.id);
  if (!user) return res.json({ ok: false, error: '未绑定账号' });

  res.json({ ok: true, ...getFlipProfileByUser(user) });
});

router.post('/api/flip-draw', express.json(), (req, res, next) => {
  const tgUser = verifyTgInitData(req.body?.initData || '');
  if (tgUser?.id != null) req.body.tgUserId = String(tgUser.id);
  req.tgUser = tgUser;
  next();
}, gameFlipLimiter, (req, res) => {
  const tgUser = req.tgUser || null;
  if (!tgUser) return res.json({ ok: false, error: '验证失败' });

  const cardIndex = Number(req.body?.cardIndex);
  if (!Number.isInteger(cardIndex) || cardIndex < 0 || cardIndex >= CARD_COUNT) {
    return res.json({ ok: false, error: '无效卡片' });
  }

  const user = getUserByTelegramId(db, tgUser.id);
  if (!user) return res.json({ ok: false, error: '未绑定账号' });

  const prize = weightedRandom(FLIP_PRIZES);
  const result = applyFlipDraw(user, cardIndex, prize);
  if (result.ok && prize.gb > 0) tryUnfreezeAfterTraffic(db, user.id);
  const profile = getFlipProfileByUser(user);
  if (!result.ok) {
    return res.json({ ...result, ...profile });
  }

  return res.json({
    ok: true,
    cardIndex,
    prizeLabel: result.prize.label,
    prizeGb: result.prize.gb,
    ...profile,
  });
});

module.exports = router;
module.exports._test = { verifyTgInitData, today, getFlipProfileByUser, applyFlipDraw, DAILY_FLIP_LIMIT };
